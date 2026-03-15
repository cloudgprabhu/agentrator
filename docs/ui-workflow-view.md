# UI Workflow View Notes

Task `29` adds workflow lineage visibility to the existing dashboard without changing the overall dashboard layout.

## Session cards

- Cards now show resolved runtime badges for `role`, `agent`, `provider`, `model`, and `authProfile` when that metadata exists.
- Cards also show workflow badges for the current lineage state and relationship, such as `waiting_review` and `child of INT-42`.
- Expanding a card shows:
  - parent issue summary,
  - a compact child issue list with state badges,
  - PR/review linkage counts,
  - the latest workflow event label.

## Session detail view

- The session detail page now includes a dedicated `Workflow` panel between the PR card and terminal.
- That panel shows:
  - parent issue summary with title when the tracker can resolve it,
  - full child issue list with state badges,
  - PR/review linkage for the current child issue,
  - latest workflow event/activity,
  - task-plan and lineage artifact paths.

## Backend data flow

- Workflow and runtime metadata are enriched through the shared web serializer used by:
  - the dashboard SSR page,
  - `GET /api/sessions`,
  - `GET /api/sessions/:id`.
- This keeps the dashboard and session detail page on the same payload shape.

## Development notes

- No separate mock page was added.
- Existing component and API tests were extended with workflow-aware fixtures instead.
