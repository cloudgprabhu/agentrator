# Workflow Lineage

Workflow lineage tracks how one parent issue expands into child issues, sessions, worktrees, branches, and PRs.

The current lineage store is a YAML artifact, typically written next to the task plan:

- `docs/plans/<issue>.lineage.yaml`
- `.ao/plans/<issue>.lineage.yaml`

## Relationships

One lineage file models a single parent issue.

- `parentIssue` is the root workflow entity.
- `planningSession` is the planner session that produced the task plan.
- `childIssues[]` contains one entry per created implementation issue.
- Each child issue can accumulate:
  - `state`
  - `implementationSessions[]`
  - `reviewSessions[]`
  - `pr`

This lets AO answer questions like:

- which planner session produced this plan
- which implementation sessions worked on child issue `#101`
- which review session followed that work
- which branch/worktree was used
- which PR belongs to that child issue
- what workflow state each child issue is currently in

## Child States

Each child issue carries a machine-readable `state`:

- `queued`: child issue exists but implementation has not started
- `in_progress`: an implementation session is actively working the issue
- `blocked`: work is paused on an external blocker
- `pr_opened`: implementation opened a PR
- `waiting_review`: review is in progress or pending on the opened PR
- `changes_requested`: review requested follow-up work
- `approved`: review approved the child issue for completion
- `done`: work is complete for this child issue

Allowed transition directions are:

- `queued -> in_progress | blocked | pr_opened | waiting_review | done`
- `in_progress -> blocked | pr_opened | waiting_review | changes_requested | approved | done`
- `blocked -> queued | in_progress | pr_opened | waiting_review | done`
- `pr_opened -> blocked | waiting_review | changes_requested | approved | done`
- `waiting_review -> blocked | changes_requested | approved | done`
- `changes_requested -> blocked | in_progress | pr_opened | waiting_review | done`
- `approved -> blocked | changes_requested | done`
- `done` is terminal

## Querying

CLI:

```bash
ao workflow lineage my-app INT-42
ao workflow lineage my-app INT-42 --json
ao workflow set-state my-app #101 blocked
ao workflow set-state my-app #101 in_progress
ao workflow relocate-task-plan my-app INT-42 docs/archive/INT-42.task-plan.yaml
ao workflow audit-lineage my-app INT-42
ao workflow audit-lineage my-app --lineage docs/plans/INT-42.lineage.yaml --repair
ao workflow review my-app #101
ao workflow review my-app https://github.com/acme/my-app/pull/88
ao workflow review-outcome my-app #101 --outcome request_changes --summary "Add CI regression coverage."
```

Dashboard API:

```bash
GET /api/lineage?project=my-app&parentIssue=INT-42
```

## Manual State Changes

Use `ao workflow set-state` when an operator needs to intervene without editing lineage YAML.

- move a child issue into `blocked` when work is waiting on an external dependency
- move a child issue back out of `blocked` once work can resume
- apply any other valid transition allowed by the lineage state machine

The command validates allowed transitions before writing lineage. For example, `blocked -> in_progress`
is allowed, but `waiting_review -> queued` is rejected with the valid next states.

## Task-Plan Relocation

If a task-plan file has moved, AO now handles relocation in two ways:

- review and reviewer-outcome flows will automatically use the moved plan when there is exactly one valid matching task-plan file for the same parent issue in the project
- `ao workflow relocate-task-plan` updates the lineage artifact so the new path is stored explicitly

Example:

```bash
ao workflow relocate-task-plan my-app INT-42 docs/archive/int-42.task-plan.yaml
```

Ambiguous relocations still require an operator decision. AO will not guess between multiple matching task plans.

## Audit And Repair

Use `ao workflow audit-lineage` to inspect a lineage artifact for:

- parent issue drift against the task plan
- missing or extra child issue references
- missing `version` or `updatedAt`
- legacy child-state aliases
- stale or overridden task-plan paths

Safe repair mode only applies changes AO can make deterministically:

- add missing `version`
- add missing `updatedAt`
- normalize legacy child-state aliases
- align `parentIssue` with the referenced task plan
- persist an explicit `--task-plan` override into the lineage file

It does not invent missing child issues or guess ambiguous task-plan relocations. Those still need an operator decision.

## Update hooks

The lineage store is updated from these workflow hooks:

- `ao workflow plan` records `planningSession`
- `ao workflow create-issues` records created `childIssues` and initializes them as `queued`
- `ao workflow implement` marks tracker-completed child issues as `done` when it encounters them
- `ao workflow review` resolves child issues from either issue refs or PR refs and spawns the configured `reviewRole` with task-plan context
- `ao workflow review-outcome` records reviewer decisions, publishes SCM-native PR reviews where supported (with tracker issue comments as fallback), updates child state, can route changes back to implementers, and can append follow-up child tasks
- `sessionManager.spawn()` records implementation or review sessions when they target a known child issue and moves state to `in_progress` or `waiting_review`
- `sessionManager.claimPR()` records PR linkage for the owning child issue and moves state to `pr_opened`, `changes_requested`, `approved`, or `done` based on PR state
- SCM webhook handling can auto-spawn the configured reviewer role on PR `opened` and `synchronize` events when lineage resolves to a child issue and no reviewer handoff is already active

## Example

See [task-lineage.example.yaml](examples/task-lineage.example.yaml) for a concrete lineage artifact.
