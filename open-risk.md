# Open Risks / Follow-ups (Tasks 01-38)

This file tracks only the items that are still open after tasks `01` through `38`.
Items that were explicitly fixed or superseded later are intentionally omitted.

The original implementation backlog in [docs/completion-backlog.md](./docs/completion-backlog.md) is complete through `B16`. Follow-up items `F01`, `F02`, `F04`, `F05`, and `F06` have been implemented. The items below are the remaining follow-ups that still matter for production hardening and longer-term platform polish.

## Outstanding by task area

### Tasks 14-18: provider/model/runtime resolution and prompt policy

- Provider-model compatibility now uses explicit known-model data for Anthropic, OpenAI, and Bedrock, with narrow fallback handling for cases like OpenAI fine-tune IDs and Bedrock ARNs.
- Follow-up: expand the explicit provider model catalogs as new supported model IDs are adopted.
- Tracking: [#7](https://github.com/cloudgprabhu/agentrator/issues/7) (F03, P1)

### Task 27: reviewer outcome handling

- Reviewer outcomes can now publish first-class SCM reviews on supported platforms. The current repo implements native review publishing for GitHub; other SCMs still fall back to tracker issue comments.
- Follow-up:
  - extend native review publishing to additional SCM plugins only where the platform support and operator value justify it,
  - add inline PR/MR comment publishing if review outcomes need file-level comments instead of summary-only reviews.
- Tracking: [#9](https://github.com/cloudgprabhu/agentrator/issues/9) (F07, P2)

## Resolved follow-ups

The following items from the original open-risk list have been implemented:

- **F01** Improve ambiguous legacy migration diagnostics — PR [#1](https://github.com/cloudgprabhu/agentrator/pull/1)
- **F02** Parallelize auth profile status checks — PR [#2](https://github.com/cloudgprabhu/agentrator/pull/2)
- **F04** Expand native tracker hierarchy only where justified — PR [#4](https://github.com/cloudgprabhu/agentrator/pull/4)
- **F05** Keep lineage repair scope safe while exploring stronger recovery — PR [#3](https://github.com/cloudgprabhu/agentrator/pull/3)
- **F06** Externalize webhook idempotency when deployments do not share project-local storage

## Tasks with no remaining open items called out here

The following task ranges had risks at the time but those items were later fixed or superseded, so they are not repeated above:

- `01-05`
- `06-08` (resolved by F01)
- `07`
- `09-13` (resolved by F02)
- `15` bug fix itself
- `17`
- `19-21` (resolved by F04)
- `22-25` (resolved by F05)
- `23`
- `26-31` (resolved by F06)
- `28-29`
- `30`
- `32`
- `33`
- `34`
- `35`
- `36`
- `37`
- `38` items `B01-B16` backlog fixes
