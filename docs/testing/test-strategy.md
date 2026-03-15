# Test Strategy

This document defines the test strategy for the forked Agent Orchestrator codebase.

The goal is not just high test counts. The goal is to keep the fork safe as it adds:

- provider/auth/model profile resolution
- canonical project identity
- workflow planning and lineage
- reviewer auto-handoff
- richer CLI and dashboard visibility
- backward-compatible behavior for older configs and metadata

## Objectives

The test suite should prove:

1. new config surfaces parse and fail clearly
2. canonical project IDs remain stable even for shared repo paths
3. auth profile resolution and health/status behave safely
4. incompatible provider/agent/model combinations are blocked
5. role-based spawn resolves the correct runtime identity
6. parent-child workflow orchestration is deterministic
7. lineage artifacts persist and reject corruption
8. child workflow states transition correctly
9. reviewer auto-handoff avoids duplicate storms
10. older single-agent flows still work
11. CLI and dashboard surfaces show the right metadata
12. failure and recovery paths degrade safely

## Test pyramid

### Unit tests

Primary purpose:

- validate pure resolution, parsing, and state transitions quickly

Best fit for:

- config parsing and validation
- auth profile resolution
- provider registry compatibility
- model-profile resolution
- task-plan parsing
- task-lineage parsing and transition rules
- serializer/view-model helpers

Expected qualities:

- no external services
- deterministic fixtures
- clear source-specific error assertions

### Integration tests

Primary purpose:

- verify module seams across core, CLI, and web

Best fit for:

- `SessionManager.spawn()` resolution and metadata persistence
- workflow CLI commands reading/writing task-plan and lineage artifacts
- tracker/scm adapter interactions via mocked plugins
- session APIs and dashboard serialization
- webhook reviewer handoff

Expected qualities:

- real filesystem temp dirs
- mocked plugin boundaries
- assertion of persisted files, CLI output, and API payloads

### End-to-end and scenario tests

Primary purpose:

- validate operator-facing flows and regressions across multiple packages

Best fit for:

- `ao start` legacy compatibility
- workflow plan -> create-issues -> implement -> review
- dashboard rendering of workflow/runtime metadata
- session recovery and restore behavior

Expected qualities:

- smaller count than unit/integration tests
- representative golden-path flows plus a few critical failure paths

## Coverage areas

### 1. Config parsing and validation

Modules:

- `packages/core/src/config.ts`
- `packages/core/src/types.ts`
- `packages/core/src/config-migration.ts`

Core assertions:

- valid additive schema loads cleanly
- unknown providers/auth profiles/model profiles/roles/workflow refs fail clearly
- inline secret-like fields are rejected
- provider/auth/model compatibility rules fail with path-specific errors
- migration output preserves original data and emits actionable warnings

Primary tests:

- `packages/core/src/__tests__/config-validation.test.ts`
- `packages/core/src/__tests__/config-migration.test.ts`

### 2. Canonical project ID behavior

Modules:

- `packages/core/src/config.ts`
- `packages/core/src/paths.ts`
- `packages/core/src/session-manager.ts`
- CLI spawn/status routing

Core assertions:

- project identity comes from `projects.<key>`
- two logical projects may share the same repo path safely
- session metadata, worktree layout, and APIs route by canonical project ID
- legacy single-project configs still load correctly

Primary tests:

- `packages/core/src/__tests__/paths.test.ts`
- `packages/core/src/__tests__/session-manager.test.ts`
- `packages/cli/__tests__/commands/spawn.test.ts`
- `packages/cli/__tests__/commands/status.test.ts`

### 3. Auth profile resolution and status

Modules:

- `packages/core/src/auth-profile-resolver.ts`
- `packages/core/src/auth-manager.ts`
- browser and non-browser auth adapters
- `packages/cli/src/commands/auth.ts`

Core assertions:

- auth profiles resolve the intended provider
- inline secret values are rejected
- browser auth exposes safe status/login/logout states
- unsupported environments warn clearly
- spawn is blocked when the resolved auth profile is invalid or unavailable

Primary tests:

- `packages/core/src/__tests__/auth-profile-resolver.test.ts`
- `packages/core/src/__tests__/auth-manager.test.ts`
- `packages/core/src/__tests__/openai-codex-browser-auth.test.ts`
- `packages/core/src/__tests__/anthropic-claude-browser-auth.test.ts`
- `packages/core/src/__tests__/non-browser-auth-adapters.test.ts`
- `packages/cli/__tests__/commands/auth.test.ts`

### 4. Provider/model compatibility

Modules:

- `packages/core/src/provider-registry.ts`
- `packages/core/src/model-profile-resolution.ts`

Core assertions:

- supported provider metadata is stable
- agent/provider compatibility is enforced
- model/provider compatibility is enforced
- override precedence does not bypass compatibility checks

Primary tests:

- `packages/core/src/__tests__/provider-registry.test.ts`
- `packages/core/src/__tests__/model-profile-resolution.test.ts`

### 5. Role-based spawn

Modules:

- `packages/core/src/session-manager.ts`
- `packages/cli/src/commands/spawn.ts`

Core assertions:

- role selects the intended model profile
- resolved `role`, `agent`, `provider`, `authProfile`, `authMode`, and `model` persist in metadata
- `--agent` override only changes the agent plugin choice, not the role-derived provider/auth/model defaults
- orchestrator spawn uses `parentIssueRole`

Primary tests:

- `packages/core/src/__tests__/session-manager.test.ts`
- `packages/cli/__tests__/commands/spawn.test.ts`

### 6. Parent-child issue orchestration

Modules:

- `packages/cli/src/commands/workflow.ts`
- task-plan and tracker integration surfaces

Core assertions:

- planner command creates the planning session and lineage seed
- plan validation rejects malformed task-plan YAML
- issue creation creates one tracker issue per child task
- implementation command respects completion and concurrency rules
- review command resolves by issue or PR ref

Primary tests:

- `packages/cli/__tests__/commands/workflow.test.ts`
- `packages/core/src/__tests__/task-plan.test.ts`

### 7. Lineage persistence

Modules:

- `packages/core/src/task-lineage.ts`
- `packages/core/src/session-manager.ts`

Core assertions:

- lineage YAML validates and normalizes cleanly
- planning sessions, implementation sessions, review sessions, and PRs persist
- lineage merges preserve existing references
- mismatched parent/task-plan/child reference overwrites are rejected

Primary tests:

- `packages/core/src/__tests__/task-lineage.test.ts`
- `packages/core/src/__tests__/session-manager.test.ts`

### 8. Implementation workflow state transitions

Modules:

- `packages/core/src/task-lineage.ts`
- workflow CLI outcome handlers

Core assertions:

- allowed transitions match the declared state model
- invalid transitions fail clearly
- implement/review/outcome hooks move child issues into the expected states
- tracker-completed children become `done`

Primary tests:

- `packages/core/src/__tests__/task-lineage.test.ts`
- `packages/cli/__tests__/commands/workflow.test.ts`

### 9. Reviewer auto-handoff

Modules:

- `packages/web/src/lib/workflow-review-handoff.ts`
- webhook route

Core assertions:

- PR `opened` and `synchronize` events resolve lineage correctly
- active reviewer sessions suppress duplicate handoff
- repeated deliveries for the same PR update burst do not spawn duplicate reviewers
- missing lineage or missing task-plan entries fail safely

Primary tests:

- `packages/web/src/__tests__/api-routes.test.ts`
- supporting lineage tests in `packages/core/src/__tests__/task-lineage.test.ts`

### 10. Backward compatibility

Modules:

- config loader
- session manager
- CLI start/spawn/status
- session APIs

Core assertions:

- legacy configs without provider/auth/model/role/workflow blocks still work
- `ao start` and `ao spawn` preserve older operator flows
- session detail/list APIs degrade gracefully when enrichment is unavailable
- legacy archive/session metadata remains readable enough to avoid breaking operators

Primary tests:

- `packages/cli/__tests__/commands/start.test.ts`
- `packages/cli/__tests__/commands/spawn.test.ts`
- `packages/web/src/__tests__/api-routes.test.ts`
- `packages/core/src/__tests__/config-validation.test.ts`

### 11. Dashboard and CLI visibility

Modules:

- `packages/cli/src/commands/status.ts`
- `packages/web/src/lib/serialize.ts`
- dashboard components

Core assertions:

- CLI verbose status shows resolved runtime identity and workflow context
- JSON status includes the same fields
- session cards and detail views render runtime and workflow metadata
- session APIs serialize the same enriched shape used by the dashboard

Primary tests:

- `packages/cli/__tests__/commands/status.test.ts`
- `packages/web/src/lib/__tests__/serialize.test.ts`
- `packages/web/src/__tests__/components.test.tsx`
- `packages/web/src/__tests__/api-routes.test.ts`

### 12. Failure and recovery scenarios

Modules:

- `packages/core/src/session-manager.ts`
- webhook and workflow handlers
- web session APIs

Core assertions:

- workspace/runtime creation failures clean up reserved state
- auth/profile/provider failures stop before runtime launch
- restore and archived metadata keep canonical runtime fields
- webhook failures return safe responses and do not corrupt lineage
- missing or stale task-plan references fail with actionable errors

Primary tests:

- `packages/core/src/__tests__/session-manager.test.ts`
- `packages/web/src/__tests__/api-routes.test.ts`
- `packages/cli/__tests__/commands/workflow.test.ts`

## Test ownership

### Core package

Owns:

- config validation
- auth resolution and adapters
- provider/model compatibility
- task-plan and task-lineage schemas
- session manager behavior and metadata persistence

Rule:

- any change to config schema, metadata fields, resolution logic, or lineage/state rules should land with core tests first

### CLI package

Owns:

- user-facing command behavior
- command output and flags
- workflow command orchestration
- backward-compatible CLI surfaces

Rule:

- any new CLI option or command should have command-level tests, not just indirect core coverage

### Web package

Owns:

- API route payloads
- workflow/webhook integration
- dashboard serialization and rendering

Rule:

- if runtime or workflow metadata becomes user-visible in the dashboard, add both serializer and component/API coverage

## Fixture strategy

Preferred fixtures:

- temp directories for project paths, task-plan files, lineage files, and session metadata
- mocked plugin registry boundaries for runtime, agent, tracker, and scm
- representative YAML fixtures embedded directly in tests when small
- session factories for CLI/web tests

Guidelines:

- keep fixtures realistic enough to exercise canonical project IDs, role-based metadata, and lineage paths
- prefer explicit timestamps and stable IDs
- use one-purpose fixtures instead of one giant shared global fixture

## CI recommendations

Minimum CI gates for the fork:

1. `pnpm --filter @composio/ao-core test`
2. `pnpm --filter @composio/ao-cli test`
3. `pnpm --filter @composio/ao-web test`
4. `pnpm --filter @composio/ao-core typecheck`
5. `pnpm --filter @composio/ao-core build`

Recommended additions:

- split core, CLI, and web test jobs for faster feedback
- run a focused smoke matrix on high-risk slices:
  - config/auth/resolution
  - workflow/lineage
  - session-manager
  - web api-routes/serialize/components
- publish junit or similar artifacts for flaky/failure triage

Known CI caveat:

- CLI typecheck is still blocked by plugin declaration issues in `packages/cli/src/lib/plugins.ts`, so it should be treated as a follow-up gate, not a current required gate

## Review checklist for contributors

When a change touches the fork-specific feature set, verify:

1. config parsing and validation changed?
   Add or update core config tests.
2. runtime identity or session metadata changed?
   Add or update session-manager and visibility tests.
3. auth/provider/model resolution changed?
   Add or update auth-manager, resolver, provider-registry, or model-resolution tests.
4. workflow/lineage behavior changed?
   Add or update workflow CLI, lineage, and webhook tests.
5. user-visible dashboard or CLI output changed?
   Add command output or serializer/component/API assertions.
6. backward compatibility claim changed?
   Add an explicit legacy-path regression test.

## Current gaps

The strategy above is broader than today’s automated guarantees. The main remaining gaps are already tracked in `open-risk.md`, especially:

- provider CLI compatibility coverage
- live SSE refresh of enriched dashboard state
- lineage repair tooling
- a clean CLI typecheck gate
