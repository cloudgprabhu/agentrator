# Completion Backlog

This document tracks the remaining follow-up backlog for completing the current Agent Orchestrator fork.

The original implementation backlog items `B01-B16` are complete. The remaining work below is derived from the still-open items in [open-risk.md](../open-risk.md).

## Completion criteria

Treat the project as complete for the current fork when all of the following are true:

1. Normal verification is green:
   - `pnpm run test:automated`
   - `pnpm -r typecheck` or an explicitly documented scoped equivalent
2. Legacy installs can migrate safely without silent session or metadata loss.
3. Workflow planning, implementation, review, and lineage operations fail clearly instead of drifting silently.
4. Multi-instance web deployments do not duplicate reviewer handoff on the same PR update burst.
5. CLI and dashboard expose enough machine-readable runtime and workflow state for operators to trust the system in production.

## Completed implementation backlog

The following implementation backlog items are done:

- `B01-B16`

Those items covered:

- typecheck closure and verification stability
- legacy session metadata relocation and normalization
- workflow artifact enforcement, lineage audit/repair, blocked-state management, and task-plan relocation support
- tracker-native hierarchy where worth the platform-specific complexity
- auth JSON output, live validation, and browser adapter compatibility coverage
- prompt policy provenance, SSE enrichment, shared webhook dedupe, native GitHub review publishing, provider-model data expansion, and prompt dedupe/normalization

## Completed follow-up backlog

These follow-up items have been implemented and merged:

- **F01** Improve ambiguous legacy migration diagnostics — PR [#1](https://github.com/cloudgprabhu/agentrator/pull/1)
- **F02** Parallelize auth profile status checks — PR [#2](https://github.com/cloudgprabhu/agentrator/pull/2)
- **F04** Expand native tracker hierarchy only where justified — PR [#4](https://github.com/cloudgprabhu/agentrator/pull/4) (keep lineage baseline; add native hierarchy only where platform support is strong enough)
- **F05** Keep lineage repair scope safe while exploring stronger recovery — PR [#3](https://github.com/cloudgprabhu/agentrator/pull/3)

## Remaining follow-up backlog

These items remain open after `B01-B16` and `F01/F02/F04/F05`.

### F03. Keep explicit provider-model catalogs current

Priority: `P1`
Tracking: [#7](https://github.com/cloudgprabhu/agentrator/issues/7)

Scope:

- extend explicit Anthropic/OpenAI/Bedrock compatibility data as new supported model IDs are adopted
- keep the current narrow fallback behavior for cases like OpenAI fine-tune IDs and Bedrock ARNs

Definition of done:

- newly supported model IDs no longer depend on ad hoc heuristic fixes

### F06. Externalize webhook idempotency if deployments outgrow shared project storage

Priority: `P2`
Tracking: [#8](https://github.com/cloudgprabhu/agentrator/issues/8)

Scope:

- move reviewer-handoff dedupe from project-local filesystem claims to an external shared store only if deployment topology no longer shares project-local storage

Definition of done:

- duplicate PR webhook deliveries remain suppressed across the actual deployment topology in use

### F07. Expand native SCM review publishing where worth it

Priority: `P2`
Tracking: [#9](https://github.com/cloudgprabhu/agentrator/issues/9)

Scope:

- extend native review publishing to additional SCM plugins only where platform support and operator value justify it
- add inline PR/MR comment publishing if workflow review outcomes need file-level comments instead of summary-only reviews

Definition of done:

- supported SCMs can publish the level of review detail the operators actually need, with clear fallback behavior where they cannot

## Suggested execution order

### Phase 1 — COMPLETE

- ~~`F01` Improve ambiguous legacy migration diagnostics~~ — merged via PR #1
- ~~`F02` Parallelize auth profile status checks~~ — merged via PR #2
- ~~`F05` Keep lineage repair scope safe while exploring stronger recovery~~ — merged via PR #3

### Phase 2

- `F03` Keep explicit provider-model catalogs current — [#7](https://github.com/cloudgprabhu/agentrator/issues/7)
- ~~`F04` Expand native tracker hierarchy only where justified~~ — merged via PR #4
- `F07` Expand native SCM review publishing where worth it — [#9](https://github.com/cloudgprabhu/agentrator/issues/9)

Exit gate:

- platform-specific enhancements are added only where they materially improve operator experience

### Phase 3

- `F06` Externalize webhook idempotency if deployments outgrow shared project storage — [#8](https://github.com/cloudgprabhu/agentrator/issues/8)

Exit gate:

- deployment-specific scaling work is matched to the actual production topology

## Recommended next task

Implement `F03` next.

Reason:

- it is the highest-priority remaining item (P1)
- keeping provider-model catalogs current prevents operators from depending on ad hoc heuristic fixes for newly supported models
