# Task Plan Format

`ao workflow plan <project> <parent-issue>` now targets a structured YAML task-plan artifact instead of a free-form Markdown note.

Use this format when creating or reviewing planner output:

```yaml
version: 1
parentIssue: INT-42
specPath: docs/specs/example-spec.md # or null
adrPath: docs/adr/0001-example.md # or null
childTasks:
  - title: Define the task slice
    summary: Short explanation of the work and why it matters.
    acceptanceCriteria:
      - Concrete, testable outcome
    dependencies: []
    suggestedFiles:
      - src/example.ts
    labels:
      - backend
```

## Required fields

- `version`: schema version. Current value is `1`.
- `parentIssue`: the parent issue or initiative being planned.
- `specPath`: repo-relative spec path, or `null` when no spec applies.
- `adrPath`: repo-relative ADR path, or `null` when no ADR applies.
- `childTasks`: non-empty list of child implementation tasks.

Each `childTasks[]` entry must include:

- `title`
- `summary`
- `acceptanceCriteria`
- `dependencies`
- `suggestedFiles`
- `labels`

## Authoring rules

- Write YAML only. Do not wrap the artifact itself in Markdown fences.
- Keep `dependencies`, `suggestedFiles`, and `labels` present even when empty.
- Use repo-relative paths for `specPath`, `adrPath`, and `suggestedFiles`.
- Keep each child task independently actionable and reviewable.
- Put concrete verification steps in `acceptanceCriteria`.

## Validation

Use the CLI validator before handing the plan to downstream automation:

```bash
ao workflow validate-plan docs/plans/int-42.task-plan.yaml
```

Validation checks both YAML parsing and schema completeness.

Create child tracker issues from a validated plan with:

```bash
ao workflow create-issues my-app docs/plans/int-42.task-plan.yaml
```

That command creates one tracker issue per `childTasks[]` entry and writes a lineage artifact next to the plan by default:

- `docs/plans/int-42.lineage.yaml`

The lineage artifact records the created issue IDs, URLs, labels, and dependencies for each child task.
As sessions and PRs attach to those child issues, AO extends the same lineage file with planning,
implementation, review, branch, worktree, and PR links.

## Sample

See [task-plan.example.yaml](examples/task-plan.example.yaml) for a concrete example artifact.
See [task-lineage.example.yaml](examples/task-lineage.example.yaml) for the lineage output produced after issue creation.
See [Workflow Lineage](workflow-lineage.md) for the full relationship model.
