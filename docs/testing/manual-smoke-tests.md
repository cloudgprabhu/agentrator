# Manual Smoke Tests

This checklist is for operator-level manual verification of the fork on a real local setup. It complements the automated strategy in [test-strategy.md](test-strategy.md), [unit-test-cases.md](unit-test-cases.md), and [integration-test-cases.md](integration-test-cases.md).

Run these checks after significant changes to auth, workflow orchestration, canonical project identity, or dashboard visibility.

## 1. macOS setup with Claude browser login

### Preconditions

- macOS workstation
- Claude CLI installed and on `PATH`
- browser-capable local session
- config with an Anthropic `browser-account` auth profile

### Exact commands

```bash
cp examples/local-browser-dual.yaml agent-orchestrator.yaml
ao auth status
ao auth login claude-browser
ao auth status
```

### Expected results

- initial status shows `not_authenticated` or `authenticated`
- `ao auth login claude-browser` opens or delegates to the local login flow
- final status shows the Claude browser profile as usable

### Troubleshooting notes

- if status is `unavailable`, confirm `claude` is installed and executable
- if status is `unsupported_environment`, confirm you are not in CI and have a usable local browser session

## 2. macOS setup with Codex browser login

### Preconditions

- macOS workstation
- Codex CLI installed and on `PATH`
- config with an OpenAI `browser-account` auth profile

### Exact commands

```bash
cp examples/local-browser-dual.yaml agent-orchestrator.yaml
ao auth status
ao auth login codex-browser
ao auth status
```

### Expected results

- Codex profile becomes `authenticated` or otherwise clearly usable
- no secret values are printed

### Troubleshooting notes

- if `codex` is missing, install the local CLI first
- if output remains `unavailable`, verify CLI version and shell environment

## 3. Local API-key auth validation

### Preconditions

- local config using API-key auth profiles
- corresponding env vars exported in the shell

### Exact commands

```bash
cp examples/mixed-local-api.yaml agent-orchestrator.yaml
export OPENAI_API_KEY="test-value"
ao auth status
```

### Expected results

- API-key profile resolves as configured and usable
- CLI output shows profile name, provider, and status only

### Troubleshooting notes

- if the profile is `not_authenticated`, confirm the env var is present in the current shell
- if the wrong profile appears, verify `modelProfiles.<key>.authProfile`

## 4. Same repo path multi-project config

### Preconditions

- one local repo path available
- config with multiple logical projects sharing that path

### Exact commands

```bash
cp examples/shared-repo-multi-project.yaml agent-orchestrator.yaml
ao spawn planner INT-101
ao spawn reviewer INT-102
ao status --verbose
```

### Expected results

- two sessions are created under distinct project IDs
- `ao status --verbose` shows separate `projectId` values and separate session IDs
- sessions do not collapse into one logical project

### Troubleshooting notes

- if sessions collide, check `sessionPrefix` values
- if one project is missing, verify the `projects.<key>` names used in the command

## 5. Planner flow

### Preconditions

- project configured with `workflow.parentIssueRole`
- auth profiles for the planner role are usable

### Exact commands

```bash
ao workflow plan my-app INT-123
ao workflow lineage my-app INT-123
```

### Expected results

- planner session is created
- output shows artifact and session info
- lineage query shows a `planningSession` entry for the parent issue

### Troubleshooting notes

- if planning fails before spawn, run `ao auth status`
- if workflow config is missing, verify `projects.<id>.workflow` and `workflow.<key>.parentIssueRole`

## 6. Child issue creation flow

### Preconditions

- valid task-plan file exists
- tracker integration is configured and reachable

### Exact commands

```bash
ao workflow validate-plan docs/plans/int-123.task-plan.yaml
ao workflow create-issues my-app docs/plans/int-123.task-plan.yaml
ao workflow lineage my-app INT-123
```

### Expected results

- plan validates successfully
- one child issue is created per `childTasks[]` entry
- lineage shows queued child issues with IDs, labels, and URLs

### Troubleshooting notes

- if tracker creation fails, verify tracker plugin config and credentials
- if lineage is missing, confirm the plan path and default lineage output location

## 7. Implementer spawn flow

### Preconditions

- lineage file already exists for the parent issue
- child issues exist in the tracker

### Exact commands

```bash
ao workflow implement my-app INT-123
ao status --verbose
ao workflow lineage my-app INT-123
```

### Expected results

- eligible child issues start implementation sessions
- completed or already-active children are skipped
- status and lineage reflect implementation state and session linkage

### Troubleshooting notes

- if nothing starts, inspect tracker completion state and active sessions
- if the wrong role is used, verify `workflow.childIssueRole`

## 8. Reviewer auto-handoff flow

### Preconditions

- workflow review role configured
- lineage child already linked to a PR
- webhook route configured and reachable

### Exact commands

```bash
curl -X POST http://localhost:3000/api/webhooks/github \
  -H 'Content-Type: application/json' \
  -H 'x-github-event: pull_request' \
  -H 'x-github-delivery: smoke-test-review-1' \
  -d '{"action":"opened"}'

ao status --verbose
ao workflow lineage my-app INT-123
```

### Expected results

- webhook response indicates either a spawned reviewer session or a clear skip reason
- reviewer session appears for the correct child issue
- lineage/status reflect review activity

### Troubleshooting notes

- if nothing spawns, confirm lineage can resolve the PR back to a child issue
- if duplicates appear, check whether the web server is single-process or multi-process

## 9. Status/dashboard verification

### Preconditions

- at least one role-aware or workflow-linked session exists
- dashboard server is running

### Exact commands

```bash
ao status --verbose
open http://localhost:3000
```

### Expected results

- CLI verbose output shows `role`, `agent`, `provider`, `model`, `authProfile`, `authMode`, and workflow context
- dashboard cards and detail views show runtime and lineage metadata

### Troubleshooting notes

- if CLI lacks fields, confirm the session was spawned through a role-aware path
- if dashboard lacks workflow details, refresh after confirming the session APIs include enriched fields

## 10. Recovery from failed auth

### Preconditions

- config resolves a session through an auth profile that is intentionally unavailable

### Exact commands

```bash
ao auth status
ao spawn --role planner my-app INT-999
```

### Expected results

- auth status reports the profile as unavailable or unsupported
- spawn fails before runtime/session creation
- no new session metadata appears

### Troubleshooting notes

- if spawn proceeds unexpectedly, confirm the selected role actually resolves to the broken auth profile
- if the failure is unclear, inspect `modelProfiles.<key>.authProfile`

## 11. Recovery from invalid lineage

### Preconditions

- lineage file manually edited or intentionally corrupted

### Exact commands

```bash
ao workflow lineage my-app INT-123
ao workflow review my-app #101
```

### Expected results

- AO fails clearly instead of silently corrupting state further
- errors mention missing lineage references, missing task-plan entries, or invalid lineage structure

### Troubleshooting notes

- restore the last valid lineage artifact
- confirm the referenced task-plan file still exists
- avoid dropping existing child entries during manual edits

## 12. Backward compatibility verification

### Preconditions

- upstream-style config without fork-specific schema blocks

### Exact commands

```bash
cp examples/simple-github.yaml agent-orchestrator.yaml
ao start
ao spawn my-app ISSUE-123
ao status
```

### Expected results

- legacy config still loads
- orchestrator and basic spawn flow still work
- status and session detail remain usable without workflow metadata

### Troubleshooting notes

- if startup fails, compare the config against `agent-orchestrator.yaml.example`
- if the UI hangs on enrichment, confirm the session APIs still return base session data
