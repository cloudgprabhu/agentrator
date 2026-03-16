# Workflow Planning

Use the workflow planner command to launch the configured `parentIssueRole` for a project:

```bash
ao workflow plan my-app INT-123
```

Behavior:

- resolves the planner role from `projects.<id>.workflow -> workflow.<key>.parentIssueRole`
- spawns a worker session using that role
- passes the parent issue as the session issue context
- appends planning instructions that ask the planner to create a structured YAML task-plan artifact
- includes repository reference hints from files such as `README.md`, `docs/specs`, `docs/architecture`, and `docs/rfc` when they exist
- waits for a valid task-plan artifact by default and exits non-zero if the planner session ends, times out, or writes an invalid plan

Optional artifact override:

```bash
ao workflow plan my-app INT-123 --artifact docs/plans/checkout-refactor.task-plan.yaml
```

By default, AO waits up to `15s` for a valid task-plan artifact. For intentionally long interactive
planning sessions, you can skip that validation handoff explicitly:

```bash
ao workflow plan my-app INT-123 --no-verify-artifact
ao workflow plan my-app INT-123 --artifact-timeout-ms 30000
```

Default artifact target:

- `docs/plans/<issue>.task-plan.yaml` when the project already has a `docs/` directory
- `.ao/plans/<issue>.task-plan.yaml` otherwise

The planner prompt asks for a structured artifact that includes:

1. `parentIssue`
2. `specPath`
3. `adrPath`
4. `childTasks[]` with task titles, summaries, acceptance criteria, dependencies, suggested files, and labels

Validate a generated plan with:

```bash
ao workflow validate-plan docs/plans/int-123.task-plan.yaml
```

Create child tracker issues from the plan with:

```bash
ao workflow create-issues my-app docs/plans/int-123.task-plan.yaml
```

That command:

- creates one tracker issue per child task
- copies labels from the plan into tracker issue creation
- writes parent/spec/ADR/dependencies into the issue body
- records created issue IDs and URLs in `docs/plans/int-123.lineage.yaml` by default
- uses native parent/child issue linkage when the tracker supports it; the current implementation does this for Linear and GitHub while GitLab continues using lineage plus issue-body linkage

Start implementation sessions for eligible child issues with:

```bash
ao workflow implement my-app INT-123
ao workflow implement my-app INT-123 --concurrency 2
```

That command:

- resolves `childIssueRole` from workflow config
- discovers child issues from the lineage artifact for the parent issue
- skips child issues that already have active sessions
- skips child issues that the tracker reports as completed
- uses `--concurrency` as a cap on total active implementation sessions for that parent issue

Start a reviewer session for a child issue or PR with:

```bash
ao workflow review my-app #101
ao workflow review my-app https://github.com/acme/my-app/pull/88
```

That command:

- resolves `reviewRole` from workflow config
- locates the child issue through workflow lineage using either issue refs or PR refs
- loads the matching task-plan entry for acceptance criteria, dependencies, suggested files, and design artifacts
- auto-resolves a moved task plan when there is exactly one valid matching replacement in the repo
- spawns a reviewer session with structured workflow review context

When SCM webhooks are configured, PR `opened` and `synchronize` events also trigger the same reviewer handoff automatically when AO can resolve the PR back to a workflow child issue through lineage.

Record reviewer outcomes with:

```bash
ao workflow review-outcome my-app #101 --outcome approve --summary "Looks good to merge."
ao workflow review-outcome my-app https://github.com/acme/my-app/pull/88 --outcome request_changes --summary "Add regression coverage for the auth fallback path."
ao workflow review-outcome my-app #101 --outcome create_follow_up --summary "Document the rollout steps for operators." --follow-up-title "Add rollout docs"
ao workflow review-outcome my-app #101 --outcome update_parent_summary --summary "Core implementation is ready; rollout docs remain."
```

That command:

- resolves the workflow child issue through issue refs or PR refs
- publishes a first-class PR review when the linked SCM supports it, otherwise falls back to the relevant tracker issue surface
- updates lineage state to `approved`, `changes_requested`, or `blocked` when applicable
- routes `request_changes` back to the configured `childIssueRole` by sending the active implementer session a message or spawning a new implementer session
- appends a new child task plus tracker issue when the reviewer selects `create_follow_up`

Query the evolving workflow lineage with:

```bash
ao workflow lineage my-app INT-123
```

If an operator needs to pause or resume a child issue manually, use:

```bash
ao workflow set-state my-app #101 blocked
ao workflow set-state my-app #101 in_progress
```

If a task-plan file moved and you want lineage to store the new location explicitly, run:

```bash
ao workflow relocate-task-plan my-app INT-123 docs/archive/int-123.task-plan.yaml
```

See [Task Plan Format](task-plan-format.md) for the canonical schema, [Workflow Lineage](workflow-lineage.md) for the lineage relationships, [task-plan.example.yaml](examples/task-plan.example.yaml) for a sample plan artifact, and [task-lineage.example.yaml](examples/task-lineage.example.yaml) for the resulting lineage artifact.
