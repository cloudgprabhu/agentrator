# Backward Compatibility Notes

Task `30` audits the newer provider/auth/workflow additions against the original single-agent flows.

## Preserved legacy workflows

The following legacy workflows continue to work without defining `providers`, `authProfiles`,
`modelProfiles`, `roles`, or `workflow`:

- `ao start`
- `ao spawn <project> <issue>`
- basic dashboard and session detail loading
- legacy single-project configs that only define `projects.<id>.repo/path/defaultBranch`

## Compatibility behavior

- Config loading still defaults the additive top-level blocks to empty objects.
- Project defaults still derive `name`, `sessionPrefix`, `scm`, and `tracker` for legacy configs.
- Model/runtime resolution still falls back to legacy `project.agent` and `project.agentConfig`
  when no role/workflow model resolution is configured.
- Dashboard APIs now treat metadata enrichment as best-effort for session detail views so basic
  session data still renders even if tracker or lineage enrichment is slow or unavailable.

## Regression coverage

The task30 regression coverage adds explicit tests for:

- `ao start` on a legacy single-agent config without workflow schema
- `ao spawn <project> <issue>` on a legacy single-agent config without role/provider schema
- `GET /api/sessions/:id` returning basic session detail for legacy sessions
- `GET /api/sessions/:id` falling back to basic detail when metadata enrichment stalls
