/**
 * Configuration loader — reads agent-orchestrator.yaml and validates with Zod.
 *
 * Minimal config that just works:
 *   projects:
 *     my-app:
 *       repo: org/repo
 *       path: ~/my-app
 *
 * Everything else has sensible defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { OrchestratorConfig } from "./types.js";
import { generateSessionPrefix } from "./paths.js";
import { hasInlineSecretValues } from "./auth-profile-resolver.js";
import { validateProviderCompatibility } from "./provider-registry.js";

function inferScmPlugin(project: {
  repo: string;
  scm?: Record<string, unknown>;
  tracker?: Record<string, unknown>;
}): "github" | "gitlab" {
  const scmPlugin = project.scm?.["plugin"];
  if (scmPlugin === "gitlab") {
    return "gitlab";
  }

  const scmHost = project.scm?.["host"];
  if (typeof scmHost === "string" && scmHost.toLowerCase().includes("gitlab")) {
    return "gitlab";
  }

  const trackerPlugin = project.tracker?.["plugin"];
  if (trackerPlugin === "gitlab") {
    return "gitlab";
  }

  const trackerHost = project.tracker?.["host"];
  if (typeof trackerHost === "string" && trackerHost.toLowerCase().includes("gitlab")) {
    return "gitlab";
  }

  return "github";
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const ReactionConfigSchema = z.object({
  auto: z.boolean().default(true),
  action: z.enum(["send-to-agent", "notify", "auto-merge"]).default("notify"),
  message: z.string().optional(),
  priority: z.enum(["urgent", "action", "warning", "info"]).optional(),
  retries: z.number().optional(),
  escalateAfter: z.union([z.number(), z.string()]).optional(),
  threshold: z.string().optional(),
  includeSummary: z.boolean().optional(),
});

const TrackerConfigSchema = z
  .object({
    plugin: z.string(),
  })
  .passthrough();

const SCMWebhookReviewerHandoffStoreConfigSchema = z
  .object({
    provider: z
      .enum(["project-local-filesystem", "shared-filesystem"])
      .default("project-local-filesystem"),
    path: z.string().optional(),
    pathEnvVar: z.string().optional(),
    keyPrefix: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.provider === "shared-filesystem" && !value.path && !value.pathEnvVar) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "scm.webhook.reviewerHandoffStore shared-filesystem provider requires path or pathEnvVar",
      });
    }
  });

const SCMConfigSchema = z
  .object({
    plugin: z.string(),
    webhook: z
      .object({
        enabled: z.boolean().default(true),
        path: z.string().optional(),
        secretEnvVar: z.string().optional(),
        signatureHeader: z.string().optional(),
        eventHeader: z.string().optional(),
        deliveryHeader: z.string().optional(),
        maxBodyBytes: z.number().int().positive().optional(),
        reviewerHandoffStore: SCMWebhookReviewerHandoffStoreConfigSchema.optional(),
      })
      .optional(),
  })
  .passthrough();

const NotifierConfigSchema = z
  .object({
    plugin: z.string(),
  })
  .passthrough();

const ProviderConfigSchema = z
  .object({
    kind: z.string(),
    displayName: z.string().optional(),
    defaultAgentPlugin: z.string().optional(),
    capabilities: z
      .object({
        browserAuth: z.boolean().optional(),
        apiAuth: z.boolean().optional(),
        supportsRoleOverride: z.boolean().optional(),
      })
      .optional(),
    options: z.record(z.unknown()).optional(),
  })
  .passthrough();

const AuthProfileConfigSchema = z
  .object({
    type: z.enum(["browser-account", "api-key", "aws-profile", "console"]),
    provider: z.string().optional(),
    displayName: z.string().optional(),
    credentialEnvVar: z.string().optional(),
    credentialRef: z.string().optional(),
    accountType: z.string().optional(),
    options: z.record(z.unknown()).optional(),
  })
  .passthrough();

const ModelProfileConfigSchema = z
  .object({
    provider: z.string().optional(),
    agent: z.string().optional(),
    authProfile: z.string().optional(),
    model: z.string(),
    runtime: z.record(z.unknown()).optional(),
    rulesFile: z.string().optional(),
    promptPrefix: z.string().optional(),
    guardrails: z.union([z.string(), z.array(z.string())]).optional(),
    options: z.record(z.unknown()).optional(),
  })
  .passthrough();

const RolePromptPolicySchema = z
  .object({
    systemAppend: z.string().optional(),
    rulesFile: z.string().optional(),
  })
  .passthrough();

const AgentPermissionSchema = z
  .enum(["permissionless", "default", "auto-edit", "suggest", "skip"])
  .default("permissionless")
  .transform((value) => (value === "skip" ? "permissionless" : value));

const OptionalAgentPermissionSchema = z
  .enum(["permissionless", "default", "auto-edit", "suggest", "skip"])
  .transform((value) => (value === "skip" ? "permissionless" : value))
  .optional();

const RoleConfigSchema = z
  .object({
    description: z.string().optional(),
    modelProfile: z.string(),
    provider: z.string().optional(),
    authProfile: z.string().optional(),
    agent: z.string().optional(),
    rulesFile: z.string().optional(),
    promptPrefix: z.string().optional(),
    guardrails: z.union([z.string(), z.array(z.string())]).optional(),
    permissions: OptionalAgentPermissionSchema,
    promptPolicy: RolePromptPolicySchema.optional(),
    options: z.record(z.unknown()).optional(),
  })
  .passthrough();

const WorkflowConfigSchema = z
  .object({
    parentIssueRole: z.string(),
    childIssueRole: z.string(),
    reviewRole: z.string(),
    ciFixRole: z.string(),
    options: z.record(z.unknown()).optional(),
  })
  .passthrough();

const AgentSpecificConfigSchema = z
  .object({
    permissions: AgentPermissionSchema,
    model: z.string().optional(),
    orchestratorModel: z.string().optional(),
    opencodeSessionId: z.string().optional(),
  })
  .passthrough();

const DecomposerConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxDepth: z.number().min(1).max(5).default(3),
    model: z.string().default("claude-sonnet-4-20250514"),
    requireApproval: z.boolean().default(true),
  })
  .default({
    enabled: false,
    maxDepth: 3,
    model: "claude-sonnet-4-20250514",
    requireApproval: true,
  });

const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  repo: z.string(),
  path: z.string(),
  defaultBranch: z.string().default("main"),
  sessionPrefix: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "sessionPrefix must match [a-zA-Z0-9_-]+")
    .optional(),
  runtime: z.string().optional(),
  agent: z.string().optional(),
  workspace: z.string().optional(),
  tracker: TrackerConfigSchema.optional(),
  scm: SCMConfigSchema.optional(),
  symlinks: z.array(z.string()).optional(),
  postCreate: z.array(z.string()).optional(),
  agentConfig: AgentSpecificConfigSchema.default({}),
  reactions: z.record(ReactionConfigSchema.partial()).optional(),
  agentRules: z.string().optional(),
  agentRulesFile: z.string().optional(),
  orchestratorRules: z.string().optional(),
  workflow: z.string().optional(),
  orchestratorSessionStrategy: z
    .enum(["reuse", "delete", "ignore", "delete-new", "ignore-new", "kill-previous"])
    .optional(),
  opencodeIssueSessionStrategy: z.enum(["reuse", "delete", "ignore"]).optional(),
  decomposer: DecomposerConfigSchema.optional(),
});

const DefaultPluginsSchema = z.object({
  runtime: z.string().default("tmux"),
  agent: z.string().default("claude-code"),
  workspace: z.string().default("worktree"),
  notifiers: z.array(z.string()).default(["composio", "desktop"]),
});

const OrchestratorConfigSchema = z.object({
  port: z.number().default(3000),
  terminalPort: z.number().optional(),
  directTerminalPort: z.number().optional(),
  readyThresholdMs: z.number().nonnegative().default(300_000),
  defaults: DefaultPluginsSchema.default({}),
  providers: z.record(ProviderConfigSchema).default({}),
  authProfiles: z.record(AuthProfileConfigSchema).default({}),
  modelProfiles: z.record(ModelProfileConfigSchema).default({}),
  roles: z.record(RoleConfigSchema).default({}),
  workflow: z.record(WorkflowConfigSchema).default({}),
  projects: z.record(ProjectConfigSchema),
  notifiers: z.record(NotifierConfigSchema).default({}),
  notificationRouting: z.record(z.array(z.string())).default({
    urgent: ["desktop", "composio"],
    action: ["desktop", "composio"],
    warning: ["composio"],
    info: ["composio"],
  }),
  reactions: z.record(ReactionConfigSchema).default({}),
});

// =============================================================================
// CONFIG LOADING
// =============================================================================

/** Expand ~ to home directory */
function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

/** Expand all path fields in the config */
function expandPaths(config: OrchestratorConfig): OrchestratorConfig {
  for (const project of Object.values(config.projects)) {
    project.path = expandHome(project.path);
  }

  return config;
}

/** Apply defaults to project configs */
function applyProjectDefaults(config: OrchestratorConfig): OrchestratorConfig {
  for (const [id, project] of Object.entries(config.projects)) {
    // Derive name from project ID if not set
    if (!project.name) {
      project.name = id;
    }

    // Derive session prefix from canonical project key if not set
    if (!project.sessionPrefix) {
      project.sessionPrefix = generateSessionPrefix(id);
    }

    const inferredPlugin = inferScmPlugin(project);

    // Infer SCM from repo if not set
    if (!project.scm && project.repo.includes("/")) {
      project.scm = { plugin: inferredPlugin };
    }

    // Infer tracker from repo if not set (default to github issues)
    if (!project.tracker) {
      project.tracker = { plugin: inferredPlugin };
    }
  }

  return config;
}

/** Validate project uniqueness and session prefix collisions */
function validateProjectUniqueness(config: OrchestratorConfig): void {
  // Check for duplicate session prefixes
  const prefixes = new Set<string>();
  const prefixToProject: Record<string, string> = {};

  for (const [configKey, project] of Object.entries(config.projects)) {
    const prefix = project.sessionPrefix || generateSessionPrefix(configKey);

    if (prefixes.has(prefix)) {
      const firstProjectKey = prefixToProject[prefix];
      const firstProject = config.projects[firstProjectKey];
      throw new Error(
        `Duplicate session prefix detected: "${prefix}"\n` +
          `Projects "${firstProjectKey}" and "${configKey}" would generate the same prefix.\n\n` +
          `To fix this, add an explicit sessionPrefix to one of these projects:\n\n` +
          `projects:\n` +
          `  ${firstProjectKey}:\n` +
          `    path: ${firstProject?.path}\n` +
          `    sessionPrefix: ${prefix}1  # Add explicit prefix\n` +
          `  ${configKey}:\n` +
          `    path: ${project.path}\n` +
          `    sessionPrefix: ${prefix}2  # Add explicit prefix\n`,
      );
    }

    prefixes.add(prefix);
    prefixToProject[prefix] = configKey;
  }
}

function formatConfigValidationError(configPath: string, details: string[]): Error {
  const header = `Config validation failed at ${configPath}`;
  if (details.length === 0) {
    return new Error(header);
  }
  return new Error(`${header}:\n${details.map((d) => `- ${d}`).join("\n")}`);
}

function validateSchemaReferences(config: OrchestratorConfig, configPath: string): void {
  const providers = new Set(Object.keys(config.providers ?? {}));
  const authProfiles = new Set(Object.keys(config.authProfiles ?? {}));
  const modelProfiles = new Set(Object.keys(config.modelProfiles ?? {}));
  const roles = new Set(Object.keys(config.roles ?? {}));
  const workflows = new Set(Object.keys(config.workflow ?? {}));

  const errors: string[] = [];

  for (const [authProfileKey, authProfile] of Object.entries(config.authProfiles ?? {})) {
    if (authProfile.provider && !providers.has(authProfile.provider)) {
      errors.push(
        `authProfiles.${authProfileKey}.provider references unknown provider "${authProfile.provider}"`,
      );
    }

    const inlineSecretPaths = hasInlineSecretValues(authProfile as Record<string, unknown>);
    if (inlineSecretPaths.length > 0) {
      errors.push(
        `authProfiles.${authProfileKey} includes inline secret values at ${inlineSecretPaths.join(", ")}; use credentialRef/credentialEnvVar references`,
      );
    }
  }

  for (const [modelProfileKey, modelProfile] of Object.entries(config.modelProfiles ?? {})) {
    if (modelProfile.provider && !providers.has(modelProfile.provider)) {
      errors.push(
        `modelProfiles.${modelProfileKey}.provider references unknown provider "${modelProfile.provider}"`,
      );
    }

    if (modelProfile.authProfile && !authProfiles.has(modelProfile.authProfile)) {
      errors.push(
        `modelProfiles.${modelProfileKey}.authProfile references unknown authProfile "${modelProfile.authProfile}"`,
      );
    }
  }

  for (const [roleKey, role] of Object.entries(config.roles ?? {})) {
    if (role.provider && !providers.has(role.provider)) {
      errors.push(`roles.${roleKey}.provider references unknown provider "${role.provider}"`);
    }

    if (role.authProfile && !authProfiles.has(role.authProfile)) {
      errors.push(
        `roles.${roleKey}.authProfile references unknown authProfile "${role.authProfile}"`,
      );
    }

    if (!modelProfiles.has(role.modelProfile)) {
      errors.push(
        `roles.${roleKey}.modelProfile references unknown modelProfile "${role.modelProfile}"`,
      );
    }
  }

  for (const [workflowKey, workflow] of Object.entries(config.workflow ?? {})) {
    const roleRefs: Array<[field: string, roleName: string]> = [
      ["parentIssueRole", workflow.parentIssueRole],
      ["childIssueRole", workflow.childIssueRole],
      ["reviewRole", workflow.reviewRole],
      ["ciFixRole", workflow.ciFixRole],
    ];

    for (const [field, roleName] of roleRefs) {
      if (!roles.has(roleName)) {
        errors.push(`workflow.${workflowKey}.${field} references unknown role "${roleName}"`);
      }
    }
  }

  for (const [projectKey, project] of Object.entries(config.projects)) {
    if (!project.workflow) continue;

    if (!workflows.has(project.workflow)) {
      errors.push(
        `projects.${projectKey}.workflow references unknown workflow "${project.workflow}"`,
      );
      continue;
    }

    const workflow = config.workflow?.[project.workflow];
    if (!workflow) continue;

    const roleRefs: Array<[field: string, roleName: string]> = [
      ["parentIssueRole", workflow.parentIssueRole],
      ["childIssueRole", workflow.childIssueRole],
      ["reviewRole", workflow.reviewRole],
      ["ciFixRole", workflow.ciFixRole],
    ];

    for (const [field, roleName] of roleRefs) {
      if (!roles.has(roleName)) {
        errors.push(
          `projects.${projectKey}.workflow (${project.workflow}) has ${field} with unknown role "${roleName}"`,
        );
      }
    }
  }

  errors.push(...validateProviderCompatibility(config));

  if (errors.length > 0) {
    throw formatConfigValidationError(configPath, errors);
  }
}

/** Apply default reactions */
function applyDefaultReactions(config: OrchestratorConfig): OrchestratorConfig {
  const defaults: Record<string, (typeof config.reactions)[string]> = {
    "ci-failed": {
      auto: true,
      action: "send-to-agent",
      message:
        "CI is failing on your PR. Run `gh pr checks` to see the failures, fix them, and push.",
      retries: 2,
      escalateAfter: 2,
    },
    "changes-requested": {
      auto: true,
      action: "send-to-agent",
      message:
        "There are review comments on your PR. Check with `gh pr view --comments` and `gh api` for inline comments. Address each one, push fixes, and reply.",
      escalateAfter: "30m",
    },
    "bugbot-comments": {
      auto: true,
      action: "send-to-agent",
      message: "Automated review comments found on your PR. Fix the issues flagged by the bot.",
      escalateAfter: "30m",
    },
    "merge-conflicts": {
      auto: true,
      action: "send-to-agent",
      message: "Your branch has merge conflicts. Rebase on the default branch and resolve them.",
      escalateAfter: "15m",
    },
    "approved-and-green": {
      auto: false,
      action: "notify",
      priority: "action",
      message: "PR is ready to merge",
    },
    "agent-idle": {
      auto: true,
      action: "send-to-agent",
      message:
        "You appear to be idle. If your task is not complete, continue working — write the code, commit, push, and create a PR. If you are blocked, explain what is blocking you.",
      retries: 2,
      escalateAfter: "15m",
    },
    "agent-stuck": {
      auto: true,
      action: "notify",
      priority: "urgent",
      threshold: "10m",
    },
    "agent-needs-input": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "agent-exited": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "all-complete": {
      auto: true,
      action: "notify",
      priority: "info",
      includeSummary: true,
    },
  };

  // Merge defaults with user-specified reactions (user wins)
  config.reactions = { ...defaults, ...config.reactions };

  return config;
}

/**
 * Search for config file in standard locations.
 *
 * Search order:
 * 1. AO_CONFIG_PATH environment variable (if set)
 * 2. Search up directory tree from CWD (like git)
 * 3. Explicit startDir (if provided)
 * 4. Home directory locations
 */
export function findConfigFile(startDir?: string): string | null {
  // 1. Check environment variable override
  if (process.env["AO_CONFIG_PATH"]) {
    const envPath = resolve(process.env["AO_CONFIG_PATH"]);
    if (existsSync(envPath)) {
      return envPath;
    }
  }

  // 2. Search up directory tree from CWD (like git)
  const searchUpTree = (dir: string): string | null => {
    const configFiles = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];

    for (const filename of configFiles) {
      const configPath = resolve(dir, filename);
      if (existsSync(configPath)) {
        return configPath;
      }
    }

    const parent = resolve(dir, "..");
    if (parent === dir) {
      // Reached root
      return null;
    }

    return searchUpTree(parent);
  };

  const cwd = process.cwd();
  const foundInTree = searchUpTree(cwd);
  if (foundInTree) {
    return foundInTree;
  }

  // 3. Check explicit startDir if provided
  if (startDir) {
    const files = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];
    for (const filename of files) {
      const path = resolve(startDir, filename);
      if (existsSync(path)) {
        return path;
      }
    }
  }

  // 4. Check home directory locations
  const homePaths = [
    resolve(homedir(), ".agent-orchestrator.yaml"),
    resolve(homedir(), ".agent-orchestrator.yml"),
    resolve(homedir(), ".config", "agent-orchestrator", "config.yaml"),
  ];

  for (const path of homePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** Find config file path (exported for use in hash generation) */
export function findConfig(startDir?: string): string | null {
  return findConfigFile(startDir);
}

/** Load and validate config from a YAML file */
export function loadConfig(configPath?: string): OrchestratorConfig {
  // Priority: 1. Explicit param, 2. Search (including AO_CONFIG_PATH env var)
  // findConfigFile handles AO_CONFIG_PATH validation, so delegate to it
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new Error("No agent-orchestrator.yaml found. Run `ao init` to create one.");
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const config = validateConfig(parsed, path);

  // Set the config path in the config object for hash generation
  config.configPath = path;

  return config;
}

/** Load config and return both config and resolved path */
export function loadConfigWithPath(configPath?: string): {
  config: OrchestratorConfig;
  path: string;
} {
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new Error("No agent-orchestrator.yaml found. Run `ao init` to create one.");
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const config = validateConfig(parsed, path);

  // Set the config path in the config object for hash generation
  config.configPath = path;

  return { config, path };
}

/** Validate a raw config object */
export function validateConfig(raw: unknown, configPath = "<inline config>"): OrchestratorConfig {
  let validated: OrchestratorConfig;
  try {
    validated = OrchestratorConfigSchema.parse(raw) as OrchestratorConfig;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const details = err.issues.map((issue) => {
        const pathLabel = issue.path.length > 0 ? issue.path.join(".") : "<root>";
        return `${pathLabel}: ${issue.message}`;
      });
      throw formatConfigValidationError(configPath, details);
    }
    throw err;
  }

  let config = validated as OrchestratorConfig;
  config = expandPaths(config);
  config = applyProjectDefaults(config);
  config = applyDefaultReactions(config);

  try {
    // Validate project uniqueness and prefix collisions
    validateProjectUniqueness(config);

    // Validate cross-reference integrity for new schema blocks
    validateSchemaReferences(config, configPath);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.startsWith("Config validation failed at ")) {
        throw err;
      }
      throw formatConfigValidationError(configPath, [err.message]);
    }
    throw err;
  }

  return config;
}

/** Get the default config (useful for `ao init`) */
export function getDefaultConfig(): OrchestratorConfig {
  return validateConfig(
    {
      projects: {},
    },
    "<default config>",
  );
}
