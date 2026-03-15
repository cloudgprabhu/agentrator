/**
 * @composio/ao-core
 *
 * Core library for the Agent Orchestrator.
 * Exports all types, config loader, and service implementations.
 */

// Types — everything plugins and consumers need
export * from "./types.js";

// Config — YAML loader + validation
export {
  loadConfig,
  loadConfigWithPath,
  validateConfig,
  getDefaultConfig,
  findConfig,
  findConfigFile,
} from "./config.js";

// Plugin registry
export { createPluginRegistry } from "./plugin-registry.js";

// Metadata — flat-file session metadata read/write
export {
  readMetadata,
  readMetadataRaw,
  writeMetadata,
  updateMetadata,
  deleteMetadata,
  listMetadata,
} from "./metadata.js";

// tmux — command wrappers
export {
  isTmuxAvailable,
  listSessions as listTmuxSessions,
  hasSession as hasTmuxSession,
  newSession as newTmuxSession,
  sendKeys as tmuxSendKeys,
  capturePane as tmuxCapturePane,
  killSession as killTmuxSession,
  getPaneTTY as getTmuxPaneTTY,
} from "./tmux.js";

// Session manager — session CRUD
export { createSessionManager } from "./session-manager.js";
export type { SessionManagerDeps } from "./session-manager.js";

// Lifecycle manager — state machine + reaction engine
export { createLifecycleManager } from "./lifecycle-manager.js";
export type { LifecycleManagerDeps } from "./lifecycle-manager.js";

// Prompt builder — layered prompt composition
export { buildPrompt, BASE_AGENT_PROMPT } from "./prompt-builder.js";
export type { PromptBuildConfig } from "./prompt-builder.js";

// Decomposer — LLM-driven task decomposition
export {
  decompose,
  getLeaves,
  getSiblings,
  formatPlanTree,
  formatLineage,
  formatSiblings,
  propagateStatus,
  DEFAULT_DECOMPOSER_CONFIG,
} from "./decomposer.js";
export type {
  TaskNode,
  TaskKind,
  TaskStatus,
  DecompositionPlan,
  DecomposerConfig,
} from "./decomposer.js";

// Task lineage — safe lineage repair and validation
export {
  validateLineage,
  repairLineage,
  detectAmbiguousRelocation,
  buildLineageArray,
} from "./task-lineage.js";
export type {
  TaskLineageNode,
  LineageRepairResult,
  AmbiguousRelocationCandidate,
} from "./task-lineage.js";

// Orchestrator prompt — generates orchestrator context for `ao start`
export { generateOrchestratorPrompt } from "./orchestrator-prompt.js";
export type { OrchestratorPromptConfig } from "./orchestrator-prompt.js";

// Global pause constants and utilities
export {
  GLOBAL_PAUSE_UNTIL_KEY,
  GLOBAL_PAUSE_REASON_KEY,
  GLOBAL_PAUSE_SOURCE_KEY,
  parsePauseUntil,
} from "./global-pause.js";

// Shared utilities
export {
  shellEscape,
  escapeAppleScript,
  validateUrl,
  isRetryableHttpStatus,
  normalizeRetryConfig,
  readLastJsonlEntry,
} from "./utils.js";
export {
  getWebhookHeader,
  parseWebhookJsonObject,
  parseWebhookTimestamp,
  parseWebhookBranchRef,
} from "./scm-webhook-utils.js";
export { asValidOpenCodeSessionId } from "./opencode-session-id.js";
export { normalizeOrchestratorSessionStrategy } from "./orchestrator-session-strategy.js";
export type { NormalizedOrchestratorSessionStrategy } from "./orchestrator-session-strategy.js";
export {
  migrateLegacyConfig,
  migrateLegacyConfigFile,
  getDefaultMigratedConfigPath,
  relocateLegacySessionMetadata,
} from "./config-migration.js";
export type {
  ConfigMigrationResult,
  SessionMetadataRelocationProjectResult,
  SessionMetadataRelocationSkippedEntry,
  SessionMetadataRelocationResult,
} from "./config-migration.js";
export { resolveAuthProfile, hasInlineSecretValues } from "./auth-profile-resolver.js";
export { createAuthManager } from "./auth-manager.js";
export type { AuthManagerDeps } from "./auth-manager.js";
export {
  createAnthropicClaudeBrowserAuthAdapter,
  formatAuthStatusForCli,
} from "./auth-adapters/anthropic-claude-browser.js";
export type {
  ClaudeCliCommandResult,
  ClaudeCliRunner,
  AnthropicClaudeBrowserAdapterOptions,
} from "./auth-adapters/anthropic-claude-browser.js";
export {
  createOpenAICodexBrowserAuthAdapter,
  formatCodexAuthStatusForCli,
} from "./auth-adapters/openai-codex-browser.js";
export type {
  CodexCliCommandResult,
  CodexCliRunner,
  OpenAICodexBrowserAdapterOptions,
} from "./auth-adapters/openai-codex-browser.js";
export {
  createOpenAIApiKeyAuthAdapter,
  createAnthropicApiKeyAuthAdapter,
  createAWSBedrockProfileAuthAdapter,
  createConsoleAuthHookAdapter,
} from "./auth-adapters/non-browser-auth.js";
export {
  listSupportedProviders,
  getProviderByKind,
  isAgentCompatibleWithProvider,
  isModelCompatibleWithProvider,
  validateProviderCompatibility,
} from "./provider-registry.js";
export type { ProviderCapabilitiesMetadata, ProviderRegistryEntry } from "./provider-registry.js";
export { resolveModelRuntimeConfig } from "./model-profile-resolution.js";
export type {
  NormalizedModelRuntimeSettings,
  ResolvedModelRuntimeConfig,
  ResolveModelRuntimeConfigOptions,
} from "./model-profile-resolution.js";

// Feedback tools — contracts, validation, and report storage
export {
  FEEDBACK_TOOL_NAMES,
  FEEDBACK_TOOL_CONTRACTS,
  BugReportSchema,
  ImprovementSuggestionSchema,
  validateFeedbackToolInput,
  generateFeedbackDedupeKey,
  FeedbackReportStore,
} from "./feedback-tools.js";
export type {
  FeedbackToolName,
  FeedbackToolContract,
  BugReportInput,
  ImprovementSuggestionInput,
  FeedbackToolInput,
  PersistedFeedbackReport,
} from "./feedback-tools.js";
export {
  TASK_PLAN_VERSION,
  TaskPlanChildTaskSchema,
  TaskPlanSchema,
  validateTaskPlan,
  parseTaskPlan,
  readTaskPlanFile,
  taskPlanToYaml,
} from "./task-plan.js";
export type { TaskPlanChildTask, TaskPlan, TaskPlanValidationOptions } from "./task-plan.js";
export {
  TASK_LINEAGE_VERSION,
  TASK_LINEAGE_CHILD_STATES,
  TaskLineageChildStateSchema,
  TaskLineageSessionSchema,
  TaskLineagePRSchema,
  TaskLineageChildIssueSchema,
  TaskLineageSchema,
  validateTaskLineage,
  parseTaskLineage,
  readTaskLineageFile,
  taskLineageToYaml,
  writeTaskLineageFile,
  findTaskLineageByParentIssue,
  findTaskLineageByChildIssue,
  findTaskLineageByChildOrPRRef,
  findTaskLineageByPREvent,
  findTaskLineageBySession,
  auditTaskLineageFile,
  upsertTaskLineagePlanningSession,
  mergeTaskLineageChildIssues,
  createTaskLineageSessionRef,
  getAllowedTaskLineageChildStateTransitions,
  canTransitionTaskLineageChildState,
  summarizeTaskLineageStates,
  recordTaskLineageChildSession,
  recordTaskLineagePR,
  transitionTaskLineageChildState,
  updateTaskLineageTaskPlanPath,
  parseTaskLineageChildState,
} from "./task-lineage.js";
export type {
  TaskLineageAuditSeverity,
  TaskLineageAuditFinding,
  TaskLineageAuditOptions,
  TaskLineageAuditResult,
  TaskLineageParentMatch,
  TaskLineageChildMatch,
  TaskLineageSessionMatch,
  TaskLineageChildOrPRMatch,
  TaskLineageChildState,
  TaskLineageSession,
  TaskLineagePR,
  TaskLineageChildIssue,
  TaskLineage,
} from "./task-lineage.js";

// Path utilities — hash-based directory structure
export {
  generateConfigHash,
  generateProjectId,
  generateInstanceId,
  generateSessionPrefix,
  getProjectBaseDir,
  getSessionsDir,
  getWorktreesDir,
  getFeedbackReportsDir,
  getArchiveDir,
  getOriginFilePath,
  generateSessionName,
  generateTmuxName,
  parseTmuxName,
  expandHome,
  validateAndStoreOrigin,
} from "./paths.js";

// Config generator — auto-generate config from repo URL
export {
  isRepoUrl,
  parseRepoUrl,
  detectScmPlatform,
  detectDefaultBranchFromDir,
  detectProjectInfo,
  generateConfigFromUrl,
  configToYaml,
  isRepoAlreadyCloned,
  resolveCloneTarget,
  sanitizeProjectId,
} from "./config-generator.js";
export type {
  ParsedRepoUrl,
  ScmPlatform,
  DetectedProjectInfo,
  GenerateConfigOptions,
} from "./config-generator.js";
