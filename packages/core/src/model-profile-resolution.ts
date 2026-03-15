import type {
  AgentPermissionInput,
  ModelProfileConfig,
  OrchestratorConfig,
  ProviderConfig,
  RoleConfig,
} from "./types.js";
import {
  getProviderByKind,
  isAgentCompatibleWithProvider,
  isModelCompatibleWithProvider,
} from "./provider-registry.js";

export interface NormalizedModelRuntimeSettings {
  approvalPolicy?: AgentPermissionInput;
  reasoningEffort?: "low" | "medium" | "high";
  extra?: Record<string, unknown>;
}

export interface NormalizedPromptSettings {
  rulesFiles?: string[];
  promptPrefix?: string;
  guardrails?: string[];
}

export interface ResolvedModelRuntimeConfig {
  roleKey?: string;
  modelProfileKey?: string;
  providerKey?: string;
  providerKind?: string;
  authProfileKey?: string;
  agent: string;
  model?: string;
  runtimeSettings: NormalizedModelRuntimeSettings;
  promptSettings: NormalizedPromptSettings;
}

export interface ResolveModelRuntimeConfigOptions {
  config: OrchestratorConfig;
  projectId: string;
  agent: string;
  agentOverride?: string;
  roleKey?: string;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeRuntimeSettings(
  modelProfile: ModelProfileConfig,
  agent: string,
): NormalizedModelRuntimeSettings {
  const runtime = asObject(modelProfile.runtime);
  const approvalPolicyRaw = runtime["approvalPolicy"];
  const reasoningEffortRaw = runtime["reasoningEffort"];

  const approvalPolicy =
    typeof approvalPolicyRaw === "string" ? (approvalPolicyRaw as AgentPermissionInput) : undefined;
  const reasoningEffort =
    reasoningEffortRaw === "low" || reasoningEffortRaw === "medium" || reasoningEffortRaw === "high"
      ? reasoningEffortRaw
      : undefined;

  const supportsApprovalPolicy = agent === "codex" || agent === "opencode";
  const supportsReasoningEffort = agent === "codex" || agent === "opencode";

  if (approvalPolicy && !supportsApprovalPolicy) {
    throw new Error(`modelProfiles runtime approvalPolicy is not supported by agent "${agent}"`);
  }

  if (reasoningEffort && !supportsReasoningEffort) {
    throw new Error(`modelProfiles runtime reasoningEffort is not supported by agent "${agent}"`);
  }

  const extra = { ...runtime };
  delete extra["approvalPolicy"];
  delete extra["reasoningEffort"];

  return {
    approvalPolicy,
    reasoningEffort,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

function resolveWorkflowRole(config: OrchestratorConfig, projectId: string): string | undefined {
  const project = config.projects[projectId];
  if (!project?.workflow) return undefined;
  const workflow = config.workflow?.[project.workflow];
  return workflow?.childIssueRole;
}

function resolveRole(
  config: OrchestratorConfig,
  roleKey: string | undefined,
): RoleConfig | undefined {
  if (!roleKey) return undefined;
  return config.roles?.[roleKey];
}

function resolveProvider(
  config: OrchestratorConfig,
  providerKey: string | undefined,
): { providerKey?: string; provider?: ProviderConfig } {
  if (!providerKey) return {};
  const provider = config.providers?.[providerKey];
  if (!provider) {
    throw new Error(`Unknown provider reference "${providerKey}"`);
  }
  return { providerKey, provider };
}

function normalizeGuardrails(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function dedupeStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push(trimmed);
  }

  return deduped;
}

export function resolveModelRuntimeConfig(
  options: ResolveModelRuntimeConfigOptions,
): ResolvedModelRuntimeConfig {
  const { config, projectId, agent } = options;
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  const roleKey = options.roleKey ?? resolveWorkflowRole(config, projectId);
  const role = resolveRole(config, roleKey);

  if (options.roleKey && !role) {
    throw new Error(`Unknown role reference "${options.roleKey}"`);
  }

  if (!role) {
    // Backward-compatible fallback to legacy project agentConfig only.
    return {
      agent: options.agentOverride ?? agent,
      model: project.agentConfig?.model,
      runtimeSettings: {},
      promptSettings: {},
    };
  }

  const modelProfileKey = role.modelProfile;
  const modelProfile = config.modelProfiles?.[modelProfileKey];
  if (!modelProfile) {
    throw new Error(
      `roles.${roleKey}.modelProfile references unknown modelProfile "${modelProfileKey}"`,
    );
  }

  const authProfileKey = role.authProfile ?? modelProfile.authProfile;
  if (authProfileKey && !config.authProfiles?.[authProfileKey]) {
    throw new Error(
      `model profile resolution requires existing authProfile "${authProfileKey}" for role "${roleKey}"`,
    );
  }

  const providerKey =
    role.provider ?? modelProfile.provider ?? config.authProfiles?.[authProfileKey ?? ""]?.provider;
  const { provider } = resolveProvider(config, providerKey);
  const effectiveAgent = options.agentOverride ?? role.agent ?? modelProfile.agent ?? agent;

  if (provider && !isAgentCompatibleWithProvider(provider.kind, effectiveAgent)) {
    throw new Error(
      `Resolved agent "${effectiveAgent}" is not compatible with provider "${providerKey}" (${provider.kind})`,
    );
  }

  const effectiveModel = modelProfile.model;
  if (provider && !isModelCompatibleWithProvider(provider.kind, effectiveModel)) {
    const providerMeta = getProviderByKind(provider.kind);
    throw new Error(
      `Model "${effectiveModel}" is not compatible with provider "${providerKey}" (${providerMeta?.displayName ?? provider.kind})`,
    );
  }

  const runtimeSettings = normalizeRuntimeSettings(modelProfile, effectiveAgent);
  const rulesFiles = dedupeStrings(
    [
      modelProfile.rulesFile,
      role.rulesFile ?? role.promptPolicy?.rulesFile,
    ].filter((value): value is string => typeof value === "string"),
  );
  const promptPrefix =
    normalizeOptionalString(role.promptPrefix) ??
    normalizeOptionalString(role.promptPolicy?.systemAppend) ??
    normalizeOptionalString(modelProfile.promptPrefix);
  const guardrails = dedupeStrings([
    ...normalizeGuardrails(modelProfile.guardrails),
    ...normalizeGuardrails(role.guardrails),
  ]);

  return {
    roleKey,
    modelProfileKey,
    providerKey,
    providerKind: provider?.kind,
    authProfileKey,
    agent: effectiveAgent,
    model: effectiveModel,
    runtimeSettings,
    promptSettings: {
      rulesFiles: rulesFiles.length > 0 ? rulesFiles : undefined,
      promptPrefix,
      guardrails: guardrails.length > 0 ? guardrails : undefined,
    },
  };
}
