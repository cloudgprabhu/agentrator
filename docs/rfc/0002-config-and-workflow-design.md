# RFC 0002: Config, Identity, Auth, and Workflow Design

- Status: Draft
- Owner: Fork Maintainers
- Created: 2026-03-11
- Depends on: `docs/rfc/0001-fork-scope.md`, `docs/architecture/code-map.md`

## Background

RFC 0001 defines fork scope: multi-role workflows, config-driven provider/auth/model selection,
browser and API/cloud auth support, lineage-aware orchestration, shared-repo logical projects,
and visibility in CLI/dashboard.

This RFC defines the technical design for those contracts without changing runtime behavior in
this document itself.

Current code ownership for these concerns:

- Config and schema:
  - `packages/core/src/config.ts`
  - `packages/core/src/types.ts`
- Project identity:
  - `packages/core/src/paths.ts`
  - `packages/core/src/config.ts`
- Session/workflow orchestration:
  - `packages/core/src/session-manager.ts`
  - `packages/core/src/lifecycle-manager.ts`
- Auth subsystem:
  - `packages/core/src/auth-profile-resolver.ts`
  - `packages/core/src/auth-manager.ts`
  - `packages/core/src/auth-adapters/*.ts`
  - `packages/core/src/provider-registry.ts`
- Model/profile resolution:
  - `packages/core/src/model-profile-resolution.ts`
- CLI visibility:
  - `packages/cli/src/commands/spawn.ts`
  - `packages/cli/src/commands/status.ts`
  - `packages/cli/src/commands/auth.ts`
- Dashboard visibility:
  - `packages/web/src/app/api/sessions/route.ts`
  - `packages/web/src/lib/serialize.ts`
  - `packages/web/src/lib/types.ts`

## Goals

1. Define new config objects:
   - `providers`
   - `authProfiles`
   - `modelProfiles`
   - `roles`
   - `workflow`
2. Make canonical project identity use the config key instead of path basename.
3. Define an explicit auth subsystem for browser-account and API/cloud auth modes.
4. Define deterministic provider/auth/model resolution.
5. Define a workflow role engine for planner/implementer/reviewer/fixer style flows.
6. Define a lineage model spanning parent issue, child issue, session, branch, and PR.
7. Define CLI/dashboard visibility requirements for resolved runtime identity and lineage.
8. Preserve backward compatibility.
9. Define migration from legacy config to the fork schema.

## Non-Goals

- Runtime implementation details.
- UI wireframes or visual design.
- Cross-repo orchestration.
- Mid-session model switching policy changes.
- Mandatory breaking config changes in v1.

## Design Principles

1. Additive first.
   - New schema objects must be optional.
2. Reuse existing contracts.
   - Extend `ProjectConfig`, session metadata, and existing CLI/web surfaces instead of creating parallel systems.
3. Config-key identity.
   - Logical project identity must not depend on repo path basename.
4. Explicit auth.
   - Auth mode and auth profile selection must be represented explicitly and safely.
5. Deterministic resolution.
   - A given session spawn path must resolve to one provider, agent, auth profile, and model.

## Proposed Configuration Model

All new objects are additive and optional at the top level of `agent-orchestrator.yaml`.

### Top-level additions

```yaml
providers:
  <providerKey>: ProviderConfig

authProfiles:
  <authProfileKey>: AuthProfileConfig

modelProfiles:
  <modelProfileKey>: ModelProfileConfig

roles:
  <roleKey>: RoleConfig

workflow:
  <workflowKey>: WorkflowConfig
```

Projects opt in by setting `projects.<projectKey>.workflow: <workflowKey>`.

### ProviderConfig

Matches the current core contract in `packages/core/src/types.ts`.

```yaml
kind: anthropic | openai | bedrock | azure-openai | google | custom
displayName: string?
defaultAgentPlugin: string?
capabilities:
  browserAuth: boolean?
  apiAuth: boolean?
  supportsRoleOverride: boolean?
options:
  ...
```

Responsibilities:

- identify the provider platform,
- describe capability hints used for validation,
- provide a default agent plugin where role/model profiles do not override it.

### AuthProfileConfig

```yaml
type: browser-account | api-key | aws-profile | console
provider: <providerKey>?
displayName: string?
credentialEnvVar: string?
credentialRef: string?
accountType: claude-pro | claude-max | chatgpt-plus | chatgpt-pro | string?
options:
  ...
```

Responsibilities:

- define how credentials are obtained,
- bind auth to a provider when needed,
- keep secrets out of YAML by using references only.

### ModelProfileConfig

```yaml
provider: <providerKey>?
agent: string?
authProfile: <authProfileKey>?
model: string
runtime:
  approvalPolicy: permissionless | default | auto-edit | suggest?
  reasoningEffort: low | medium | high?
  ...
rulesFile: string?
promptPrefix: string?
guardrails: string | [string]
options:
  ...
```

Responsibilities:

- define the provider-native model id,
- carry runtime tuning and prompt-layering hints,
- optionally pre-bind agent and auth profile defaults.

### RoleConfig

```yaml
description: string?
modelProfile: <modelProfileKey>
provider: <providerKey>?
authProfile: <authProfileKey>?
agent: string?
rulesFile: string?
promptPrefix: string?
guardrails: string | [string]
permissions: permissionless | default | auto-edit | suggest?
promptPolicy:
  systemAppend: string?
  rulesFile: string?
options:
  ...
```

Responsibilities:

- map a workflow role to a model profile,
- optionally override provider/auth/agent selection,
- carry prompt and permission policy specific to the role.

Canonical built-in logical role keys for this fork:

- `planner`
- `implementer`
- `reviewer`
- `fixer`

### WorkflowConfig

```yaml
parentIssueRole: string
childIssueRole: string
reviewRole: string
ciFixRole: string
options:
  ...
```

Responsibilities:

- define which role handles parent issue orchestration,
- define which role handles child issue implementation,
- define which role is used for review and fix loops.

This aligns with the current fork contract and keeps workflow transitions role-based rather than
embedding a second transition DSL in config.

## Canonical Project ID Behavior

### Current problem

Current identity derivation is path-based:

- `packages/core/src/paths.ts`
  - `generateProjectId(projectPath)`
- `packages/core/src/config.ts`
  - `validateProjectUniqueness`

That model prevents multiple logical projects from safely targeting the same repo path when the
basename matches.

### Proposed behavior

Canonical project ID = the config key under `projects:`.

Rules:

1. `projects.<key>` is the canonical project ID for metadata, CLI, dashboard, and lineage.
2. `project.path` is an execution location, not an identity source.
3. Multiple project keys may reference the same `path`.
4. `sessionPrefix` remains the human/runtime session namespace and must stay unique.
5. Path basename may remain a compatibility hint, but not the canonical identifier.

### Backward-compatible interpretation

- Existing configs continue to work unchanged.
- If project key and basename currently match, observed behavior remains effectively unchanged.
- Migration tooling should warn when old assumptions depend on path-derived identity.

## Auth Subsystem Design

Auth is explicit, profile-driven, and provider-aware.

### Core modules

- `packages/core/src/auth-profile-resolver.ts`
  - resolve auth profiles and reject inline secret values.
- `packages/core/src/auth-manager.ts`
  - provide status/login/logout/health orchestration.
- `packages/core/src/auth-adapters/anthropic-claude-browser.ts`
  - Claude browser-account adapter.
- `packages/core/src/auth-adapters/openai-codex-browser.ts`
  - OpenAI/Codex browser-account adapter.
- `packages/core/src/auth-adapters/non-browser-auth.ts`
  - API-key, AWS-profile, and console auth adapters.
- `packages/core/src/provider-registry.ts`
  - provider capabilities and compatibility metadata.

### Supported auth profile types

- `browser-account`
- `api-key`
- `aws-profile`
- `console`

### Auth contract

1. A session resolves to at most one effective auth profile.
2. If `authProfile.provider` is set, it must resolve to a valid provider entry.
3. Provider capability metadata gates whether a profile type is valid for that provider.
4. Secrets are never stored inline in config; only references are allowed.
5. Session metadata records the resolved auth profile and auth mode/type for visibility.

### Auth status model

Normalized CLI/runtime auth status values:

- `authenticated`
- `not_authenticated`
- `unavailable`
- `unsupported_environment`

### Security requirements

1. Reject inline secret material in auth profiles.
2. Permit only references such as `credentialEnvVar`, `credentialRef`, or provider-specific reference fields.
3. Redact credential-bearing information in CLI and dashboard surfaces.

## Model, Provider, and Agent Resolution Design

Resolution produces a normalized runtime selection for each spawned session.

### Resolution inputs

- `project.agent`
- `project.agentConfig`
- `projects.<project>.workflow`
- `workflow.<key>`
- `roles.<role>`
- `modelProfiles.<key>`
- `authProfiles.<key>`
- `providers.<key>`
- explicit CLI spawn overrides such as `--role` and `--agent`

### Deterministic precedence

1. Explicit `spawn --agent` override for agent plugin selection.
2. Explicit `spawn --role` when provided.
3. Workflow-derived role from `projects.<project>.workflow`:
   - child sessions use `childIssueRole`
   - orchestrator sessions use `parentIssueRole`
4. Role-level overrides:
   - `roles.<role>.provider`
   - `roles.<role>.authProfile`
   - `roles.<role>.agent`
5. Model-profile defaults:
   - `modelProfiles.<key>.provider`
   - `modelProfiles.<key>.authProfile`
   - `modelProfiles.<key>.agent`
   - `modelProfiles.<key>.model`
   - `modelProfiles.<key>.runtime`
6. Provider defaults:
   - `providers.<key>.defaultAgentPlugin`
7. Legacy fallback:
   - `project.agent`
   - `project.agentConfig.model`
   - `project.agentConfig.permissions`
   - `defaults.agent`

### Compatibility validation

Validation must reject:

- unknown role/model/auth/provider references,
- incompatible provider/agent combinations,
- incompatible provider/model combinations,
- unsupported runtime settings for the selected agent.

### Normalized resolved output

Per session, the resolver should yield:

- `roleKey`
- `modelProfileKey`
- `providerKey`
- `providerKind`
- `authProfileKey`
- `agent`
- `model`
- `runtimeSettings`
- `promptSettings`

That shape already matches the direction of `packages/core/src/model-profile-resolution.ts`.

## Workflow Role Engine

### Core concept

Workflow is a role assignment contract layered on top of the existing session and lifecycle model.

### Minimum v1 semantics

1. Each session has one effective workflow role.
2. Parent issue orchestration resolves through `workflow.parentIssueRole`.
3. Child implementation sessions resolve through `workflow.childIssueRole`.
4. Review loops resolve through `workflow.reviewRole`.
5. CI fix loops resolve through `workflow.ciFixRole`.
6. Role selection happens at spawn/transition boundaries, not via implicit mid-session switching.

### Integration points

- `packages/core/src/session-manager.ts`
  - resolve role/provider/auth/model at session creation time.
- `packages/core/src/lifecycle-manager.ts`
  - trigger review/fix role transitions in future implementation.

### Scope boundary for v1

This RFC defines role-to-session contracts. It does not require a general-purpose transition DSL
or arbitrary workflow expressions in v1.

## Lineage Model

Lineage must connect planning and delivery artifacts end-to-end.

### Required entities

- root objective / parent issue
- child issue
- execution session
- branch
- PR

### Required lineage fields

The exact storage format may be flat metadata initially, but the logical model should include:

- `lineage.rootIssueId`
- `lineage.parentIssueId`
- `lineage.childIssueId`
- `lineage.role`
- `lineage.sessionId`
- `lineage.branch`
- `lineage.prNumber`
- `lineage.prUrl`
- `lineage.attempt`
- `lineage.parentSessionId` when a session is created from review/fix follow-up

### Storage strategy

1. Persist additive lineage metadata in session metadata files.
2. Preserve backward compatibility with existing flat metadata keys.
3. Expose structured lineage in CLI JSON and dashboard APIs even if it is backed by flat storage initially.

## CLI and Dashboard Visibility Requirements

Per session, operator surfaces must expose:

1. workflow role,
2. workflow id,
3. project id,
4. lineage summary,
5. provider,
6. agent plugin,
7. auth profile,
8. auth mode/type,
9. model profile,
10. resolved model.

### CLI requirements

- `ao status`
  - concise role/provider/model/auth summary in human-readable output.
- `ao status --json`
  - full resolved runtime identity plus lineage fields.
- `ao spawn --role`
  - explicit role selection must remain visible in resulting session metadata.
- `ao auth *`
  - auth profile state must stay decoupled from runtime code paths and remain safe to print.

### Dashboard requirements

- Session list/card:
  - role, provider, auth, and model summary.
- Session detail:
  - expanded lineage chain,
  - resolved runtime identity,
  - transition/review context where available.
- API route:
  - `packages/web/src/app/api/sessions/route.ts` must expose structured fields rather than only opaque metadata for the new concepts.

## Backward Compatibility Strategy

1. All new top-level objects are optional.
2. Existing `project.agent`, `project.agentConfig`, and default-agent behavior remain valid.
3. Existing single-project, single-role workflows continue to work without defining `providers`, `authProfiles`, `modelProfiles`, `roles`, or `workflow`.
4. Existing session metadata remains readable; new keys are additive.
5. CLI and dashboard must tolerate partial data during transition.

## Migration Strategy From Current Config

### Phase 0: compatibility mode

- Existing configs load unchanged.
- Legacy fields remain authoritative when new objects are absent.

### Phase 1: additive opt-in

Users may add:

- `providers`
- `authProfiles`
- `modelProfiles`
- `roles`
- `workflow`

without removing legacy config.

### Phase 2: project workflow binding

- Each project may opt in by setting `projects.<key>.workflow`.
- Canonical project identity becomes the project config key for new metadata and tooling.

### Phase 3: migration tooling and warnings

Migration tooling should:

- generate additive schema objects from legacy config where safe,
- preserve source config by default,
- emit warnings for path-derived project identity assumptions,
- require manual review for role/auth/model mappings that cannot be inferred safely.

### Legacy bridge mapping

- `project.agent`
  - fallback agent when no role/model profile selects one.
- `project.agentConfig.model`
  - fallback resolved model when no model profile is configured.
- `project.agentConfig.permissions`
  - fallback permission policy when no role override is configured.
- path-derived project id assumptions
  - replaced by project-key identity, with warnings during migration.

This is consistent with the separate migration note in `docs/migration-guide.md`.

## Sample YAML: Personal Developer Usage With Browser Login

```yaml
defaults:
  runtime: tmux
  workspace: worktree
  agent: claude-code

providers:
  anthropic:
    kind: anthropic
    displayName: "Anthropic"
    defaultAgentPlugin: claude-code
    capabilities:
      browserAuth: true
      apiAuth: true
      supportsRoleOverride: true

authProfiles:
  claude-browser:
    type: browser-account
    provider: anthropic
    displayName: "Claude Browser Login"
    accountType: claude-pro

modelProfiles:
  claude-dev:
    provider: anthropic
    agent: claude-code
    authProfile: claude-browser
    model: claude-sonnet-4-20250514

roles:
  implementer:
    modelProfile: claude-dev
    permissions: auto-edit

workflow:
  solo-dev:
    parentIssueRole: implementer
    childIssueRole: implementer
    reviewRole: implementer
    ciFixRole: implementer

projects:
  ao-fork:
    repo: my-org/agent-orchestrator
    path: ~/code/agent-orchestrator
    defaultBranch: main
    sessionPrefix: aof
    workflow: solo-dev
```

## Sample YAML: Team Usage With API/Cloud Auth

```yaml
defaults:
  runtime: tmux
  workspace: worktree
  agent: codex

providers:
  openai:
    kind: openai
    displayName: "OpenAI"
    defaultAgentPlugin: codex
    capabilities:
      browserAuth: true
      apiAuth: true
      supportsRoleOverride: true
  bedrock:
    kind: bedrock
    displayName: "AWS Bedrock"
    defaultAgentPlugin: claude-code
    capabilities:
      apiAuth: true
      supportsRoleOverride: true

authProfiles:
  openai-prod:
    type: api-key
    provider: openai
    displayName: "OpenAI Production"
    credentialEnvVar: OPENAI_API_KEY
  bedrock-prod:
    type: aws-profile
    provider: bedrock
    displayName: "Bedrock Team Profile"
    options:
      profileRef: engineering-prod

modelProfiles:
  impl-openai:
    provider: openai
    agent: codex
    authProfile: openai-prod
    model: o4-mini
    runtime:
      reasoningEffort: medium
      approvalPolicy: auto-edit
  review-bedrock:
    provider: bedrock
    agent: claude-code
    authProfile: bedrock-prod
    model: anthropic.claude-3-7-sonnet-20250219-v1:0

roles:
  implementer:
    modelProfile: impl-openai
    permissions: auto-edit
  reviewer:
    modelProfile: review-bedrock
    permissions: suggest
  fixer:
    modelProfile: impl-openai
    permissions: auto-edit

workflow:
  backend-team:
    parentIssueRole: reviewer
    childIssueRole: implementer
    reviewRole: reviewer
    ciFixRole: fixer

projects:
  backend-core:
    repo: my-org/backend
    path: /repos/backend
    defaultBranch: main
    sessionPrefix: bec
    workflow: backend-team
```

## Sample YAML: Mixed Role-to-Model Mapping

```yaml
providers:
  anthropic:
    kind: anthropic
    defaultAgentPlugin: claude-code
    capabilities:
      browserAuth: true
      apiAuth: true
      supportsRoleOverride: true
  openai:
    kind: openai
    defaultAgentPlugin: codex
    capabilities:
      browserAuth: true
      apiAuth: true
      supportsRoleOverride: true

authProfiles:
  claude-browser:
    type: browser-account
    provider: anthropic
    accountType: claude-max
  openai-api:
    type: api-key
    provider: openai
    credentialRef: OPENAI_API_KEY

modelProfiles:
  plan-model:
    provider: anthropic
    agent: claude-code
    authProfile: claude-browser
    model: claude-sonnet-4-20250514
    promptPrefix: "Produce a high-confidence plan before implementation."
  impl-model:
    provider: openai
    agent: codex
    authProfile: openai-api
    model: o4-mini
    runtime:
      reasoningEffort: medium
      approvalPolicy: auto-edit
  review-model:
    provider: openai
    agent: codex
    authProfile: openai-api
    model: o3
    runtime:
      reasoningEffort: high
      approvalPolicy: suggest

roles:
  planner:
    modelProfile: plan-model
    permissions: suggest
    guardrails:
      - "Do not change production code while planning."
  implementer:
    modelProfile: impl-model
    permissions: auto-edit
  reviewer:
    modelProfile: review-model
    permissions: suggest
  fixer:
    modelProfile: impl-model
    permissions: auto-edit

workflow:
  pr-loop:
    parentIssueRole: planner
    childIssueRole: implementer
    reviewRole: reviewer
    ciFixRole: fixer

projects:
  app-main:
    repo: my-org/app
    path: /repos/app
    defaultBranch: main
    sessionPrefix: app
    workflow: pr-loop
```

## Open Questions

1. Should workflow config stay as fixed role slots in v1, or eventually support a richer transition graph?
2. Should `reviewRole` and `ciFixRole` be resolved only in lifecycle automation, or also be manually invocable from CLI?
3. How much lineage structure should be materialized into first-class dashboard fields versus kept in metadata?
4. Which migration warnings should become hard validation errors in a later release?

## Implementation Note

This RFC is design-only. No runtime, CLI, dashboard, or migration behavior is changed by this
document itself.
