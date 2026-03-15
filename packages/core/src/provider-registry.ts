import type { OrchestratorConfig } from "./types.js";

export type AuthProfileType = "browser-account" | "api-key" | "aws-profile" | "console";
export type ProviderKind = "anthropic" | "openai" | "bedrock" | "custom";

export interface ProviderCapabilitiesMetadata {
  browserAuth: boolean;
  apiAuth: boolean;
  awsProfileAuth: boolean;
  supportsRoleOverride: boolean;
  supportedAuthProfileTypes: AuthProfileType[];
}

export interface ProviderRegistryEntry {
  key: "anthropic" | "openai" | "bedrock";
  kind: ProviderKind;
  displayName: string;
  compatibleAgents: string[];
  supportedExactModels: string[];
  supportedModelPrefixes: string[];
  capabilities: ProviderCapabilitiesMetadata;
}

const PROVIDER_REGISTRY: ProviderRegistryEntry[] = [
  {
    key: "anthropic",
    kind: "anthropic",
    displayName: "Anthropic",
    compatibleAgents: ["claude-code"],
    supportedExactModels: [
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-3-7-sonnet",
      "claude-3-5-sonnet",
      "claude-3-5-haiku",
      "claude-3-opus",
      "claude-3-sonnet",
      "claude-3-haiku",
      "opus",
      "sonnet",
      "haiku",
    ],
    supportedModelPrefixes: ["claude-", "claude."],
    capabilities: {
      browserAuth: true,
      apiAuth: true,
      awsProfileAuth: false,
      supportsRoleOverride: true,
      supportedAuthProfileTypes: ["browser-account", "api-key", "console"],
    },
  },
  {
    key: "openai",
    kind: "openai",
    displayName: "OpenAI",
    compatibleAgents: ["codex", "opencode"],
    supportedExactModels: [
      "gpt-4",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-codex",
      "o1",
      "o1-mini",
      "o3",
      "o3-mini",
      "o4-mini",
      "chatgpt-4o-latest",
      "codex-1",
      "codex-mini-latest",
    ],
    supportedModelPrefixes: ["gpt-", "o1", "o3", "o4", "chatgpt-", "codex-"],
    capabilities: {
      browserAuth: true,
      apiAuth: true,
      awsProfileAuth: false,
      supportsRoleOverride: true,
      supportedAuthProfileTypes: ["browser-account", "api-key", "console"],
    },
  },
  {
    key: "bedrock",
    kind: "bedrock",
    displayName: "AWS Bedrock",
    compatibleAgents: ["claude-code", "codex", "opencode"],
    supportedExactModels: [
      "anthropic.claude-3-7-sonnet",
      "anthropic.claude-3-5-sonnet",
      "anthropic.claude-3-5-haiku",
      "anthropic.claude-3-sonnet",
      "anthropic.claude-3-haiku",
      "amazon.nova-lite-v1:0",
      "amazon.nova-pro-v1:0",
      "amazon.titan-text-express-v1",
      "meta.llama3-1-70b-instruct-v1:0",
      "mistral.mistral-large-2407-v1:0",
      "ai21.jamba-1-5-large-v1:0",
      "cohere.command-r-v1:0",
    ],
    supportedModelPrefixes: [
      "anthropic.",
      "amazon.",
      "meta.",
      "mistral.",
      "ai21.",
      "cohere.",
      "us.anthropic.",
      "us.amazon.",
      "us.meta.",
      "us.mistral.",
      "us.ai21.",
      "us.cohere.",
      "eu.anthropic.",
      "eu.amazon.",
      "eu.meta.",
      "eu.mistral.",
      "eu.ai21.",
      "eu.cohere.",
      "apac.anthropic.",
      "apac.amazon.",
      "apac.meta.",
      "apac.mistral.",
      "apac.ai21.",
      "apac.cohere.",
    ],
    capabilities: {
      browserAuth: false,
      apiAuth: true,
      awsProfileAuth: true,
      supportsRoleOverride: true,
      supportedAuthProfileTypes: ["aws-profile", "api-key", "console"],
    },
  },
];

const PROVIDER_BY_KIND = new Map(PROVIDER_REGISTRY.map((entry) => [entry.kind, entry]));

function cloneProviderEntry(entry: ProviderRegistryEntry): ProviderRegistryEntry {
  return {
    ...entry,
    compatibleAgents: [...entry.compatibleAgents],
    supportedExactModels: [...entry.supportedExactModels],
    supportedModelPrefixes: [...entry.supportedModelPrefixes],
    capabilities: {
      ...entry.capabilities,
      supportedAuthProfileTypes: [...entry.capabilities.supportedAuthProfileTypes],
    },
  };
}

export function listSupportedProviders(): ProviderRegistryEntry[] {
  return PROVIDER_REGISTRY.map(cloneProviderEntry);
}

export function getProviderByKind(kind: string): ProviderRegistryEntry | null {
  const entry = PROVIDER_BY_KIND.get(kind as ProviderKind);
  return entry ? cloneProviderEntry(entry) : null;
}

export function isAgentCompatibleWithProvider(kind: string, agent: string): boolean {
  const provider = getProviderByKind(kind);
  if (!provider) return true; // Unknown providers are allowed for backward compatibility.
  return provider.compatibleAgents.includes(agent);
}

export function isModelCompatibleWithProvider(kind: string, model: string): boolean {
  const provider = getProviderByKind(kind);
  if (!provider) return true;

  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel) return true;

  if (provider.supportedExactModels.includes(normalizedModel)) {
    return true;
  }

  if (provider.supportedModelPrefixes.some((prefix) => normalizedModel.startsWith(prefix))) {
    return true;
  }

  if (provider.kind === "openai" && normalizedModel.startsWith("ft:")) {
    return true;
  }

  if (provider.kind === "bedrock" && normalizedModel.startsWith("arn:aws:bedrock")) {
    return true;
  }

  return false;
}

export function validateProviderCompatibility(config: OrchestratorConfig): string[] {
  const errors: string[] = [];

  for (const [providerKey, provider] of Object.entries(config.providers ?? {})) {
    const metadata = getProviderByKind(provider.kind);
    if (!metadata) {
      if (provider.kind !== "custom") {
        errors.push(
          `providers.${providerKey}.kind "${provider.kind}" is not in supported provider registry (anthropic/openai/bedrock/custom)`,
        );
      }
      continue;
    }

    if (
      provider.defaultAgentPlugin &&
      !isAgentCompatibleWithProvider(provider.kind, provider.defaultAgentPlugin)
    ) {
      errors.push(
        `providers.${providerKey}.defaultAgentPlugin "${provider.defaultAgentPlugin}" is not compatible with provider kind "${provider.kind}"`,
      );
    }
  }

  for (const [authProfileKey, profile] of Object.entries(config.authProfiles ?? {})) {
    if (!profile.provider) continue;
    const provider = config.providers?.[profile.provider];
    if (!provider) continue;

    const metadata = getProviderByKind(provider.kind);
    if (!metadata) continue;

    if (!metadata.capabilities.supportedAuthProfileTypes.includes(profile.type)) {
      errors.push(
        `authProfiles.${authProfileKey}.type "${profile.type}" is not supported by provider "${profile.provider}" (${provider.kind})`,
      );
    }
  }

  for (const [modelProfileKey, modelProfile] of Object.entries(config.modelProfiles ?? {})) {
    if (!modelProfile.provider || !modelProfile.agent) continue;
    const provider = config.providers?.[modelProfile.provider];
    if (!provider) continue;

    if (!isAgentCompatibleWithProvider(provider.kind, modelProfile.agent)) {
      errors.push(
        `modelProfiles.${modelProfileKey}.agent "${modelProfile.agent}" is not compatible with provider "${modelProfile.provider}" (${provider.kind})`,
      );
    }

    if (!isModelCompatibleWithProvider(provider.kind, modelProfile.model)) {
      errors.push(
        `modelProfiles.${modelProfileKey}.model "${modelProfile.model}" is not compatible with provider "${modelProfile.provider}" (${provider.kind})`,
      );
    }
  }

  return errors;
}
