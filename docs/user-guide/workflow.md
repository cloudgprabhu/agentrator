# Workflow

The fork introduces a planner -> implementer -> reviewer workflow on top of the base AO session model.

## Required workflow config

```yaml
roles:
  planner:
    modelProfile: planner-model
  implementer:
    modelProfile: implementer-model
  reviewer:
    modelProfile: reviewer-model
  fixer:
    modelProfile: fixer-model

workflow:
  default:
    parentIssueRole: planner
    childIssueRole: implementer
    reviewRole: reviewer
    ciFixRole: fixer

projects:
  my-app:
    workflow: default
```

## End-to-end flow

### 1. Plan the parent issue

```bash
ao workflow plan my-app INT-123
```

This launches the configured `parentIssueRole` and asks it to create a structured task-plan YAML artifact.

Validate the result:

```bash
ao workflow validate-plan docs/plans/int-123.task-plan.yaml
```

### 2. Create child issues

```bash
ao workflow create-issues my-app docs/plans/int-123.task-plan.yaml
```

This creates one tracker issue per `childTasks[]` entry and writes a lineage artifact, usually `docs/plans/int-123.lineage.yaml`.

### 3. Start implementer sessions

```bash
ao workflow implement my-app INT-123
ao workflow implement my-app INT-123 --concurrency 2
```

This resolves the configured `childIssueRole`, skips completed or already-active child issues, and starts implementer sessions for the eligible tasks.

### 4. Review child work

```bash
ao workflow review my-app #101
ao workflow review my-app https://github.com/acme/my-app/pull/88
```

AO resolves the child issue through lineage using either the issue ref or the PR ref, loads the matching task-plan entry, and starts the configured `reviewRole`.

If SCM webhooks are configured, PR `opened` and `synchronize` events can trigger the same reviewer handoff automatically.

### 5. Record review outcomes

```bash
ao workflow review-outcome my-app #101 --outcome approve --summary "Looks good to merge."
ao workflow review-outcome my-app #101 --outcome request_changes --summary "Add regression coverage."
ao workflow review-outcome my-app #101 --outcome create_follow_up --summary "Document rollout." --follow-up-title "Add rollout docs"
ao workflow review-outcome my-app #101 --outcome update_parent_summary --summary "Implementation is ready; rollout docs remain."
```

These outcomes update lineage state and publish a first-class PR review when the linked SCM supports it, with tracker comments as fallback. `request_changes` can message an active implementer or spawn a new implementer session. `create_follow_up` appends a new child task and issue.

## Lineage

Inspect lineage at any time:

```bash
ao workflow lineage my-app INT-123
ao workflow lineage my-app INT-123 --json
```

The lineage artifact tracks:

- parent issue
- task plan path
- child issues
- implementation sessions
- review sessions
- PR linkage
- child workflow state

Current child states include:

- `queued`
- `in_progress`
- `blocked`
- `pr_opened`
- `waiting_review`
- `changes_requested`
- `approved`
- `done`

## Operational notes

- Workflow review depends on the task-plan file referenced by lineage still existing.
- AO now protects lineage writes against mismatched parent/task-plan/child-reference overwrites.
- Same-process webhook dedupe now suppresses repeated PR update bursts by PR ref plus SHA, but multi-instance web deployments still need shared idempotency.
