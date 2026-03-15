# Configuration

The fork keeps the upstream project config model and adds optional provider/auth/model/role/workflow blocks.

## Minimal legacy-compatible config

This is still valid:

```yaml
defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree

projects:
  my-app:
    name: My App
    repo: org/my-app
    path: ~/src/my-app
    defaultBranch: main
    sessionPrefix: app
```

With that config, `ao start my-app` and `ao spawn my-app INT-123` continue to work in the legacy single-agent mode.

## Canonical project identity

The key under `projects:` is now the canonical project ID.

```yaml
projects:
  planner:
    path: ~/src/shared-repo
  reviewer:
    path: ~/src/shared-repo
```

In this example, `planner` and `reviewer` are distinct AO projects even though they share the same repository path.

## Role-based config

The new schema is layered:

```yaml
providers:
  openai:
    kind: openai
  anthropic:
    kind: anthropic

authProfiles:
  codex-browser:
    type: browser-account
    provider: openai
    accountType: chatgpt-plus

  claude-api:
    type: api-key
    provider: anthropic
    credentialEnvVar: ANTHROPIC_API_KEY

modelProfiles:
  planner-model:
    provider: openai
    agent: codex
    authProfile: codex-browser
    model: o3

  implementer-model:
    provider: anthropic
    agent: claude-code
    authProfile: claude-api
    model: claude-sonnet-4-20250514
    rulesFile: .ao/model-rules.md
    promptPrefix: "Keep changes small."
    guardrails:
      - "Never commit secrets"

roles:
  planner:
    modelProfile: planner-model

  implementer:
    modelProfile: implementer-model
    rulesFile: .ao/implementer-rules.md
    promptPrefix: "Start with a short implementation plan."
    guardrails:
      - "Run tests before pushing"

workflow:
  default:
    parentIssueRole: planner
    childIssueRole: implementer
    reviewRole: reviewer
    ciFixRole: fixer

projects:
  my-app:
    name: My App
    repo: org/my-app
    path: ~/src/my-app
    defaultBranch: main
    sessionPrefix: app
    workflow: default
```

## Model selection

Runtime selection follows this chain:

1. project workflow role
2. `roles.<key>.modelProfile`
3. `modelProfiles.<key>`
4. provider, auth profile, model, runtime settings, and prompt policy

Useful commands:

```bash
ao spawn --role planner my-app INT-123
ao spawn-role my-app implementer INT-456
```

If no role is supplied, AO still preserves the legacy behavior and uses the default project/agent config or workflow defaults where configured.

## Prompt policy fields

Both `modelProfiles` and `roles` can set:

- `rulesFile`
- `promptPrefix`
- `guardrails`

These are merged into the final prompt used by the selected agent.

## Webhook reviewer handoff storage

Reviewer handoff dedupe defaults to claim files under each project's local `.ao/` state directory.
Keep that default when all web instances already share the same project-local storage.

If you deploy multiple web instances that do not share project-local state, move reviewer handoff
claims to a shared filesystem path:

```yaml
projects:
  my-app:
    repo: org/my-app
    path: ~/src/my-app
    defaultBranch: main
    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: GITHUB_WEBHOOK_SECRET
        reviewerHandoffStore:
          provider: shared-filesystem
          pathEnvVar: AO_SHARED_REVIEW_HANDOFF_DIR
          keyPrefix: prod-web
```

Notes:

- `provider: shared-filesystem` requires either `path` or `pathEnvVar`
- relative `path` values resolve from the directory containing `agent-orchestrator.yaml`
- `keyPrefix` is optional and helps isolate multiple deployments sharing the same backing path

## Migration from upstream config

Use the migration helper first:

```bash
ao config migrate
```

Then review these items manually:

1. Add explicit `authProfiles` for browser, API, or cloud auth.
2. Add `modelProfiles` that bind provider + agent + auth + model.
3. Add `roles` for planner/implementer/reviewer/fixer.
4. Add `workflow` mappings and point each project at the correct workflow key.
5. Confirm that any old session metadata has moved to the canonical `{hash}-{projectId}` directory layout.

## Validation expectations

AO now rejects:

- unknown provider, auth profile, model profile, or role references
- incompatible provider/agent/model combinations
- invalid or unavailable resolved auth profiles at spawn time
- broken lineage overwrites when workflow parent/child references drift

If config fails to load, start with:

```bash
ao auth status
ao status --verbose
```
