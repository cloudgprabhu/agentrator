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

## Remaining follow-up backlog

These are the still-open items that remain after `B01-B16`.

### F01. Improve ambiguous legacy migration diagnostics

Priority: `P0`

Scope:

- keep the migration guide current for ambiguous legacy installs
- consider stronger diagnostics or a guided cleanup flow for shared-path session metadata that AO cannot safely infer
- preserve the current safety rule that ambiguous files are skipped instead of guessed

Definition of done:

- operators have a clearer supported path when legacy shared-path metadata cannot be migrated automatically

### F02. Parallelize auth profile status checks

Priority: `P1`

Scope:

- reduce operator wait time when many auth profiles are configured
- parallelize or batch `ao auth status` profile health checks without weakening error reporting clarity

Definition of done:

- auth inspection latency scales better with profile count while preserving existing status output and warnings

### F03. Keep explicit provider-model catalogs current

Priority: `P1`

Scope:

- extend explicit Anthropic/OpenAI/Bedrock compatibility data as new supported model IDs are adopted
- keep the current narrow fallback behavior for cases like OpenAI fine-tune IDs and Bedrock ARNs

Definition of done:

- newly supported model IDs no longer depend on ad hoc heuristic fixes

### F04. Expand native tracker hierarchy only where justified

Priority: `P2`

Scope:

- evaluate whether GitHub, GitLab, or future trackers justify native parent/child issue linkage
- keep lineage artifacts and issue-body linkage as the cross-platform baseline

Definition of done:

- additional tracker-native hierarchy is added only where the platform support and operator value justify the maintenance cost

### F05. Keep lineage repair scope safe while exploring stronger recovery

Priority: `P1`

Scope:

- keep ambiguous task-plan relocation explicit instead of guessed
- only broaden repair behavior if there is a safe way to reconstruct missing lineage references from tracker state

Definition of done:

- lineage repair remains conservative by default, with any broader recovery backed by deterministic reconstruction rules

### F06. Externalize webhook idempotency if deployments outgrow shared project storage

Priority: `P2`

Scope:

- move reviewer-handoff dedupe from project-local filesystem claims to an external shared store only if deployment topology no longer shares project-local storage

Definition of done:

- duplicate PR webhook deliveries remain suppressed across the actual deployment topology in use

### F07. Expand native SCM review publishing where worth it

Priority: `P2`

Scope:

- extend native review publishing to additional SCM plugins only where platform support and operator value justify it
- add inline PR/MR comment publishing if workflow review outcomes need file-level comments instead of summary-only reviews

Definition of done:

- supported SCMs can publish the level of review detail the operators actually need, with clear fallback behavior where they cannot

## Suggested execution order

### Phase 1

- `F01` Improve ambiguous legacy migration diagnostics
- `F02` Parallelize auth profile status checks
- `F05` Keep lineage repair scope safe while exploring stronger recovery

Exit gate:

- the remaining safety and operator-friction gaps are reduced without weakening current conservative behavior

### Phase 2

- `F03` Keep explicit provider-model catalogs current
- `F04` Expand native tracker hierarchy only where justified
- `F07` Expand native SCM review publishing where worth it

Exit gate:

- platform-specific enhancements are added only where they materially improve operator experience

### Phase 3

- `F06` Externalize webhook idempotency if deployments outgrow shared project storage

Exit gate:

- deployment-specific scaling work is matched to the actual production topology

## Recommended next task

Implement `F01` first.

Reason:

- it is the clearest remaining gap against the fork's migration-safety completion criteria
- the current migration behavior is intentionally safe, but operators still need stronger diagnostics or guided cleanup when AO cannot infer ambiguous legacy metadata automatically
