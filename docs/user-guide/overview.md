# User Guide Overview

This fork adds provider-aware auth, role-based model selection, and workflow orchestration on top of the upstream Agent Orchestrator flow.

## What stays the same

- `ao start` still launches the orchestrator for a project.
- `ao spawn <project> <issue>` still works for legacy single-agent setups.
- Existing projects can continue without `providers`, `authProfiles`, `modelProfiles`, `roles`, or `workflow`.

## What is new in this fork

- auth profiles for browser login, API keys, AWS profiles, and console hooks
- provider-aware model/runtime resolution
- role-based config for planner, implementer, reviewer, and CI-fix flows
- structured workflow planning, task-plan artifacts, lineage artifacts, and reviewer handoff

## Core concepts

- `projects.<key>`: the canonical project ID used by the CLI, session metadata, and dashboard
- `providers`: provider metadata such as `openai`, `anthropic`, or `bedrock`
- `authProfiles`: how AO authenticates for a provider
- `modelProfiles`: model + provider + auth + runtime defaults
- `roles`: named execution roles such as `planner` or `reviewer`
- `workflow`: how a project maps parent issues, child work, review, and CI-fix roles

## Recommended onboarding path

1. Start with [Configuration](configuration.md) to define projects, auth profiles, model profiles, and roles.
2. Follow [Authentication](authentication.md) to set up browser login or API/cloud auth.
3. Use [Workflow](workflow.md) if you want planner -> implementer -> reviewer orchestration.
4. Use [Troubleshooting](troubleshooting.md) when config, auth, or workflow resolution fails.

## Quick start

```bash
ao auth status
ao start my-app
ao status --verbose
```

For workflow-driven projects:

```bash
ao workflow plan my-app INT-123
ao workflow validate-plan docs/plans/int-123.task-plan.yaml
ao workflow create-issues my-app docs/plans/int-123.task-plan.yaml
ao workflow implement my-app INT-123
```

## Migrating from upstream

If you are moving from the upstream config shape, use:

```bash
ao config migrate
```

That produces a migrated file with the new top-level schema blocks and leaves the original config in place by default. The helper cannot infer every semantic mapping, so you still need to review:

- `authProfiles`
- `modelProfiles`
- `roles`
- `workflow`

See [Configuration](configuration.md) and [Troubleshooting](troubleshooting.md) for the manual follow-up checklist.
