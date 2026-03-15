# Open Risks / Follow-ups (Tasks 01-38)

This file tracks only the items that are still open after tasks `01` through `38`.
Items that were explicitly fixed or superseded later are intentionally omitted.

The original implementation backlog in [docs/completion-backlog.md](./docs/completion-backlog.md) is complete through `B16`. The items below are the remaining follow-ups that still matter for production hardening and longer-term platform polish.

## Cross-cutting

### Workspace hygiene

- The worktree is still dirty with many modified and untracked files across docs, core, CLI, and web.
- Follow-up: stage and review task-scoped changes carefully before committing so unrelated draft work does not get bundled together.

## Outstanding by task area

### Tasks 06-08: migration and canonical project identity

- The config migration command preserves structure but cannot safely infer semantic mappings for `authProfiles`, `modelProfiles`, `roles`, and `workflow`.
- `ao config relocate-session-metadata` now migrates legacy path-derived session metadata into canonical project-key storage, but files from shared-path installs that carry no `project`/`projectId` are still skipped instead of guessed.
- Follow-up: keep the migration guide current and consider stronger diagnostics or a guided cleanup flow for ambiguous legacy files if operators need bulk migration help.

### Tasks 09-13: auth subsystem and CLI auth commands

- Auth validation now blocks session spawn when the resolved auth profile is invalid or unavailable, and `ao auth status --live` performs opt-in live validation for supported env-backed API-key profiles. Opaque external secret references still remain warning-only in live mode because AO cannot safely dereference third-party secret stores itself.
- `ao auth status --json` now exposes machine-readable auth state for scripts and dashboards, but profile checks still run sequentially.
- Follow-up:
  - parallelize or batch status checks if auth profile counts grow enough for sequential auth inspection to become noticeably slow.

### Tasks 14-18: provider/model/runtime resolution and prompt policy

- Provider-model compatibility now uses explicit known-model data for Anthropic, OpenAI, and Bedrock, with narrow fallback handling for cases like OpenAI fine-tune IDs and Bedrock ARNs.
- Follow-up:
  - expand the explicit provider model catalogs as new supported model IDs are adopted.

### Tasks 19-21: workflow planning, task-plan artifacts, and lineage creation

- Parent/child linkage is now preserved in lineage artifacts and issue bodies for all trackers, with best-effort native hierarchy added where it is worth the platform-specific complexity. The current repo implements native parent/child linkage for Linear; GitHub and GitLab remain lineage-plus-body only.
- Follow-up:
  - extend native hierarchy support to additional trackers only if their APIs and operator value justify the extra platform-specific behavior.

### Tasks 22-25: lineage state model and review workflow

- Review commands can now auto-resolve a moved task-plan file when there is exactly one valid matching replacement for the same parent issue, and `ao workflow relocate-task-plan` can persist the new path into lineage explicitly.
- `ao workflow audit-lineage` now gives operators a supported way to detect and safely repair missing lineage metadata, legacy child-state aliases, parent drift, and explicit task-plan overrides, but it intentionally does not invent missing child issue references or guess ambiguous task-plan relocations.
- Follow-up:
  - keep ambiguous task-plan relocation resolution explicit rather than guessed,
  - keep repair scope conservative unless there is a safe way to reconstruct missing lineage references from tracker state.

### Tasks 26 and 31: webhook-driven reviewer handoff and runtime guardrails

- Auto-review suppression now uses shared filesystem-backed claim files under each project's `.ao` state directory, keyed by PR ref plus SHA.
- Follow-up:
  - move webhook idempotency to an external shared store only if the deployment model stops sharing project-local filesystem state across web instances.

### Task 27: reviewer outcome handling

- Reviewer outcomes can now publish first-class SCM reviews on supported platforms. The current repo implements native review publishing for GitHub; other SCMs still fall back to tracker issue comments.
- Follow-up:
  - extend native review publishing to additional SCM plugins only where the platform support and operator value justify it,
  - add inline PR/MR comment publishing if review outcomes need file-level comments instead of summary-only reviews.

## Tasks with no remaining open items called out here

The following task ranges had risks at the time but those items were later fixed or superseded, so they are not repeated above:

- `01-05`
- `07`
- `15` bug fix itself
- `17`
- `23`
- `30`
- `32`
- `33`
- `34`
- `35`
- `36`
- `37`
- `28-29`
- `38` items `B01-B16` backlog fixes
