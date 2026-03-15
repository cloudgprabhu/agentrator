# Agent Orchestrator Fork Code Map

This document maps the current codebase modules that own orchestration behavior relevant to this fork.
It is based on repository inspection and uses exact file paths.

## Repo shape (relevant)

- Core runtime and orchestration: `packages/core/src/*`
- CLI: `packages/cli/src/*`
- Dashboard (Next.js): `packages/web/src/*`
- Plugins: `packages/plugins/*/src/index.ts`

Note: `docs/architecture/` did not previously exist in this fork; this map is added there.

## 1) Config parsing/loading modules

- `packages/core/src/config.ts`
  - Owns YAML discovery/loading (`findConfigFile`, `loadConfig`, `loadConfigWithPath`), Zod validation, defaults, and reaction defaults.
  - Applies project defaults and uniqueness checks.
- `packages/core/src/types.ts`
  - Defines `OrchestratorConfig`, `ProjectConfig`, `ReactionConfig`, `AgentSpecificConfig`.
- `packages/core/src/paths.ts`
  - Defines project/session naming primitives used during config defaulting (`generateSessionPrefix`, `generateProjectId`).
- `packages/core/src/index.ts`
  - Re-exports config APIs used by CLI/web.

## 2) Shared types/interfaces for core plugins

- `packages/core/src/types.ts`
  - Plugin contracts: `Runtime`, `Agent`, `Workspace`, `Tracker`, `SCM`, `Notifier`, `PluginModule`, `PluginManifest`.
  - Session/lifecycle contracts: `Session`, `SessionManager`, `LifecycleManager`, event and reaction types.
- `packages/core/src/plugin-registry.ts`
  - Built-in plugin registration map and loading strategy (`createPluginRegistry`).

## 3) CLI command entrypoints (spawn/start/status)

- `packages/cli/src/index.ts`
  - Main CLI entrypoint (`ao`), registers all commands.
- `packages/cli/src/commands/spawn.ts`
  - `ao spawn`, batch spawn, decomposition path, preflight checks.
- `packages/cli/src/commands/start.ts`
  - `ao start` and `ao stop`; onboarding flow and orchestrator startup.
- `packages/cli/src/commands/status.ts`
  - `ao status`; groups sessions per project and enriches with agent/SCM info.
- `packages/cli/src/lib/create-session-manager.ts`
  - Factory wiring CLI to core session/lifecycle managers and plugin registry.

## 4) Session creation and metadata persistence

- `packages/core/src/session-manager.ts`
  - Primary orchestration logic for spawn/spawnOrchestrator/list/get/send/kill/restore/cleanup/claimPR/remap.
  - Builds `AgentLaunchConfig`, creates runtime handles, writes metadata, handles cleanup and retries.
- `packages/core/src/metadata.ts`
  - Flat-file key/value metadata persistence (`writeMetadata`, `updateMetadata`, `listMetadata`, `reserveSessionId`, archive helpers).
- `packages/core/src/paths.ts`
  - Project base dirs, session dirs, worktree dirs, hash-based namespacing.
- `packages/core/src/atomic-write.ts`
  - Atomic write primitive used by metadata and other key-value stores.
- `packages/core/src/key-value.ts`
  - Parsing key/value metadata files.

## 5) Reaction/lifecycle/event handling

- `packages/core/src/lifecycle-manager.ts`
  - Polling loop, status transitions, reaction execution, escalation behavior, PR auto-detection, metadata updates.
- `packages/core/src/feedback-tools.ts`
  - Structured feedback report contracts and persistence (`bug_report`, `improvement_suggestion`).
- `packages/cli/src/commands/lifecycle-worker.ts`
  - Dedicated lifecycle worker command.
- `packages/web/src/app/api/events/route.ts`
  - SSE endpoint for dashboard snapshots.
- `packages/web/src/hooks/useSessionEvents.ts`
  - Frontend SSE consumer and session refresh logic.

## 6) Dashboard backend and frontend modules

Backend/API:

- `packages/web/src/lib/services.ts`
  - Next.js-side singleton wiring config, registry, session manager, lifecycle manager; starts lifecycle polling and backlog poller.
- `packages/web/src/app/api/sessions/route.ts`
  - Session list API; project filtering; metadata/PR enrichment.
- `packages/web/src/app/api/events/route.ts`
  - SSE stream endpoint.
- `packages/web/src/app/api/spawn/route.ts`
  - Session spawn API.
- `packages/web/src/app/api/webhooks/[...slug]/route.ts`
  - SCM webhook ingress, verification, event parsing, lifecycle checks.
- `packages/web/src/app/api/sessions/[id]/send/route.ts`
  - Send message API.
- `packages/web/src/app/api/sessions/[id]/kill/route.ts`
  - Kill session API.
- `packages/web/src/app/api/sessions/[id]/restore/route.ts`
  - Restore session API.

Frontend:

- `packages/web/src/app/page.tsx`
  - Dashboard SSR entrypoint; loads sessions and initial enrichment.
- `packages/web/src/components/Dashboard.tsx`
  - Main dashboard client component and action handlers.
- `packages/web/src/hooks/useSessionEvents.ts`
  - Live state synchronization via SSE.
- `packages/web/src/lib/serialize.ts`
  - Session-to-dashboard mapping and enrichment helpers.
- `packages/web/src/lib/types.ts`
  - Dashboard view models and attention logic.
- `packages/web/src/lib/project-utils.ts`
  - Project filter matching and orchestrator session lookup.
- `packages/web/src/lib/project-name.ts`
  - Primary project and project list resolution for UI.

## 7) Tracker/GitHub integration modules

- `packages/plugins/tracker-github/src/index.ts`
  - Issue tracker implementation (read/list/update/create issue, prompt generation) via `gh` CLI.
- `packages/plugins/scm-github/src/index.ts`
  - SCM implementation (PR detection, CI/reviews/mergeability, merge/close, webhook verify/parse).
- `packages/web/src/lib/scm-webhooks.ts`
  - Webhook path-to-project matching and affected-session discovery.
- `packages/web/src/app/api/webhooks/[...slug]/route.ts`
  - API entrypoint invoking SCM webhook verification/parsing.

## 8) Agent plugin modules for Claude and Codex

- `packages/plugins/agent-claude-code/src/index.ts`
  - Launch/env construction, activity detection, session summary/cost extraction, restore command, workspace hook setup.
- `packages/plugins/agent-codex/src/index.ts`
  - Launch/env construction, model/reasoning flags, permission handling, activity/session parsing, restore command, wrapper setup.
- `packages/plugins/agent-codex/src/app-server-client.ts`
  - Codex app-server integration client.

## 9) Project ID derivation logic

- `packages/core/src/paths.ts`
  - `generateProjectId(projectPath)` derives ID from path basename.
  - `generateInstanceId(configPath, projectPath)` combines hash and derived project ID.
- `packages/core/src/config.ts`
  - Uses `basename(project.path)` to derive session prefix defaults.
  - `validateProjectUniqueness` rejects duplicate basename-derived project IDs and duplicate session prefixes.

## 10) Existing model, auth, and agentConfig support

- `packages/core/src/types.ts`
  - Defines legacy `ProjectConfig.agentConfig` and additive fork contracts for `ProviderConfig`, `AuthProfileConfig`, `ModelProfileConfig`, `RoleConfig`, and `WorkflowConfig`.
- `packages/core/src/config.ts`
  - Validates legacy `agentConfig` fields plus top-level `providers`, `authProfiles`, `modelProfiles`, `roles`, and `workflow`.
- `packages/core/src/provider-registry.ts`
  - Provider compatibility registry for agent/provider/model/auth-profile validation.
- `packages/core/src/auth-profile-resolver.ts`
  - Resolves auth profile references and rejects inline secrets in config.
- `packages/core/src/auth-manager.ts`
  - Central auth subsystem entrypoint for profile status, login, logout, and health checks.
- `packages/core/src/auth-adapters/anthropic-claude-browser.ts`
  - Browser-account adapter for Claude Code style interactive auth.
- `packages/core/src/auth-adapters/openai-codex-browser.ts`
  - Browser-account adapter for Codex/OpenAI interactive auth.
- `packages/core/src/auth-adapters/non-browser-auth.ts`
  - Non-browser auth adapters for API-key, AWS profile, and console-driven flows.
- `packages/core/src/model-profile-resolution.ts`
  - Resolves role/provider/auth/model selections into the normalized runtime config passed into session launch.
- `packages/core/src/session-manager.ts`
  - Applies resolved role/provider/auth/model settings at spawn time and persists role/provider/auth/model metadata to sessions.
- `packages/core/src/index.ts`
  - Re-exports auth/profile-resolution APIs used by CLI and other packages.
- `packages/cli/src/commands/auth.ts`
  - CLI entrypoint for listing auth profiles and running provider-specific status/login/logout flows.
- `packages/plugins/agent-claude-code/src/index.ts`
  - Maps resolved `model` and permission mode to Claude CLI flags and launch environment.
- `packages/plugins/agent-codex/src/index.ts`
  - Maps resolved `model`, permission mode, and reasoning settings to Codex CLI flags.

## Best insertion points for new features

1. Config schema extensions

- `packages/core/src/types.ts` (new config/type contracts)
- `packages/core/src/config.ts` (validation/defaulting)

2. Workflow role/lineage orchestration

- `packages/core/src/session-manager.ts` (spawn metadata and launch config)
- `packages/core/src/lifecycle-manager.ts` (role-aware transitions/reactions)

3. Provider/auth/model profile resolution

- `packages/core/src/config.ts` (profile schema + merge rules)
- `packages/core/src/provider-registry.ts` (compatibility and capability checks)
- `packages/core/src/auth-manager.ts` / `packages/core/src/auth-profile-resolver.ts` (auth profile lifecycle and validation)
- `packages/core/src/model-profile-resolution.ts` (normalized runtime resolution)
- `packages/core/src/session-manager.ts` (resolved profile application at launch)
- Agent plugins (`packages/plugins/agent-claude-code/src/index.ts`, `packages/plugins/agent-codex/src/index.ts`) for provider-specific command/env mappings

4. Shared-repo logical project identity

- `packages/core/src/paths.ts` (identity derivation/namespacing)
- `packages/core/src/config.ts` (`validateProjectUniqueness` behavior)

5. CLI visibility for new metadata

- `packages/cli/src/commands/status.ts`
- `packages/cli/src/commands/spawn.ts` (input surface if needed)

6. Dashboard visibility for workflow/lineage/provider/auth/model

- `packages/web/src/lib/types.ts` (view model)
- `packages/web/src/lib/serialize.ts` (mapping/enrichment)
- `packages/web/src/app/api/sessions/route.ts` (API response shape)
- `packages/web/src/components/Dashboard.tsx` and session detail components for rendering

7. Auth profile UX and diagnostics

- `packages/cli/src/commands/auth.ts` (operator-facing auth flows)
- `packages/core/src/auth-manager.ts` (health/status orchestration)
- `packages/core/src/auth-adapters/*.ts` (provider-specific auth environment handling)

## Quick dependency flow

- CLI/Web load config via `@composio/ao-core` (`loadConfig`)
- Plugin registry resolves runtime/agent/tracker/scm implementations
- Session manager creates sessions and persists metadata
- Lifecycle manager polls sessions and applies reactions
- Web APIs read from session manager and expose dashboard/SSE/webhook surfaces
