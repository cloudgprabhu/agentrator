# Model Profile Resolution

This document describes how the fork resolves role/model/auth/provider settings into a
normalized runtime config for session spawning.

## Resolution flow

1. Resolve project workflow role (spawn uses `childIssueRole`; orchestrator uses `parentIssueRole`).
2. Resolve role -> `modelProfile`.
3. Resolve model profile -> `authProfile` and `provider`.
4. Validate provider/agent/model compatibility.
5. Normalize runtime settings (`approvalPolicy`, `reasoningEffort`, plus extra runtime options).

## CLI role-aware spawn

You can request explicit role-based resolution at spawn time using either command form:

- `ao spawn --role planner <project> <issue>`
- `ao spawn-role <project> <role> <issue>`

If no role is provided, `ao spawn <project> <issue>` preserves existing behavior and uses workflow
defaults (`childIssueRole`) when configured.

### Precedence when both role and agent override are provided

- `--agent` takes precedence for agent plugin selection.
- Role resolution still determines model profile, provider, auth profile, model, and runtime settings.

## Module

- `packages/core/src/model-profile-resolution.ts`
  - `resolveModelRuntimeConfig(options)` returns normalized config used by `session-manager`.

## Normalized output

The resolver returns:

- `roleKey`
- `modelProfileKey`
- `providerKey` / `providerKind`
- `authProfileKey`
- `agent`
- `model`
- `runtimeSettings`:
  - `approvalPolicy`
  - `reasoningEffort`
  - `extra`
- `promptSettings`:
  - `rulesFiles`
  - `promptPrefix`
  - `guardrails`

## Role/model prompt support

Both `roles.<key>` and `modelProfiles.<key>` can define:

- `rulesFile` (relative to project path)
- `promptPrefix`
- `guardrails` (string or string[])

Resolution behavior:

- `rulesFiles`: model profile rules file first, then role rules file.
- `promptPrefix`: role value wins; falls back to role `promptPolicy.systemAppend`; then model profile value.
- `guardrails`: model profile guardrails first, then role guardrails.

Prompt layering precedence for compatibility:

1. project rules (`agentRules` / `agentRulesFile`)
2. role/model rules (`rulesFile`)
3. role/model prompt prefix + guardrails
4. explicit user prompt (`spawn --prompt`/composed prompt additions)

This preserves existing project-level rules support while allowing role-specific refinements.

## Validation behavior

Clear errors are raised for:

- missing role/model profile references,
- missing referenced auth profile/provider,
- incompatible provider-agent combinations,
- incompatible provider-model combinations,
- unsupported runtime settings for the selected agent.

## Backward compatibility

- If role/workflow model-profile mapping is not configured, resolution falls back to legacy
  project-level `agentConfig.model` behavior.
- Existing projects without role/workflow model profiles continue working unchanged.

## Session metadata persistence

Resolved runtime identity is persisted in session metadata files so lifecycle/recovery and
diagnostics can operate on the same selected runtime context used at spawn time.

Persisted fields include:

- `sessionId`
- `projectId` (with legacy `project` compatibility)
- `issueId` (with legacy `issue` compatibility)
- `role`
- `agent`
- `provider`
- `authProfile`
- `authMode`
- `model`
