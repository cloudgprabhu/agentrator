# Current Limitations (Observed in Code)

This document lists present limitations relevant to planned fork features, based on current module behavior.

## 1) Logical workflow roles are minimal

- Evidence:
  - `packages/core/src/session-manager.ts` writes `role=orchestrator` for orchestrator sessions.
  - Worker sessions do not have first-class planner/implementer/reviewer/fixer role semantics.
- Impact:
  - Multi-role workflow orchestration is not a native first-class model yet.

## 2) Project identity collisions still constrained by path basename

- Evidence:
  - `packages/core/src/paths.ts` derives project ID from `basename(project.path)`.
  - `packages/core/src/config.ts` `validateProjectUniqueness` rejects duplicate basename-derived IDs.
- Impact:
  - Multiple logical projects pointing to the same repo path currently conflict unless identity rules are expanded.

## 3) Profile system exists, but compatibility is intentionally curated

- Evidence:
  - `packages/core/src/types.ts` and `packages/core/src/config.ts` now define `providers`, `authProfiles`, `modelProfiles`, `roles`, and `workflow`.
  - `packages/core/src/provider-registry.ts` hard-codes compatibility/capability metadata for `anthropic`, `openai`, and `bedrock`.
- Impact:
  - The fork has first-class profile concepts, but supported combinations are still governed by a finite built-in registry and selected agent plugins.

## 4) Browser-based auth exists, but only for supported local provider flows

- Evidence:
  - `packages/core/src/types.ts` and `packages/core/src/config.ts` model auth profile types including `browser-account`, `api-key`, `aws-profile`, and `console`.
  - `packages/core/src/auth-manager.ts` orchestrates provider-specific auth status/login/logout.
  - Browser adapters are currently limited to:
    - `packages/core/src/auth-adapters/anthropic-claude-browser.ts`
    - `packages/core/src/auth-adapters/openai-codex-browser.ts`
- Impact:
  - Browser auth is a first-class concept now, but only where the local provider CLI and adapter support the environment.

## 5) Mid-session model switching policy is implicit

- Evidence:
  - Session launch resolves model once in `packages/core/src/session-manager.ts` into `AgentLaunchConfig`.
  - No dedicated model-switch lifecycle API in core manager contracts.
- Impact:
  - Model changes are effectively launch-time behavior unless ad-hoc plugin behavior exists.

## 6) Lineage and resolved profile metadata exist, but UI/API exposure is still partial

- Evidence:
  - `packages/cli/src/commands/spawn.ts` passes `lineage` and `siblings` for decomposition leaf sessions.
  - `packages/core/src/session-manager.ts` includes lineage in prompt construction and persists `role`, `provider`, `authProfile`, and related metadata.
  - `packages/web/src/lib/serialize.ts` primarily forwards generic `metadata`, while the dashboard does not yet expose an explicit lineage or resolved-profile view model contract.
- Impact:
  - Parent->child->implementation->review orchestration data exists in core paths, but operator visibility remains incomplete and metadata-driven.

## 7) Web plugin loading is curated, not fully dynamic

- Evidence:
  - `packages/web/src/lib/services.ts` statically imports/registers a subset of plugins due to Next.js bundling constraints.
- Impact:
  - Web runtime may lag behind CLI plugin flexibility unless plugin registration strategy is expanded.

## 8) SCM/tracker parity is uneven across providers

- Evidence:
  - Rich webhook and PR lifecycle logic is concentrated in GitHub modules:
    - `packages/plugins/scm-github/src/index.ts`
    - `packages/plugins/tracker-github/src/index.ts`
  - Other providers exist but parity is not guaranteed in this code path.
- Impact:
  - Feature completeness differs by provider and must be validated before promising parity.

## 9) Dashboard real-time events are polling-based snapshots

- Evidence:
  - `packages/web/src/app/api/events/route.ts` emits periodic snapshot updates on intervals.
  - `packages/web/src/hooks/useSessionEvents.ts` applies patch/reset logic from snapshots.
- Impact:
  - Event granularity is coarse compared with true per-event push streams.

## 10) Reaction engine is still primarily status/event-key driven, not workflow-role aware

- Evidence:
  - `packages/core/src/lifecycle-manager.ts` maps status transitions to event keys and reaction keys.
  - `packages/core/src/session-manager.ts` persists role metadata, but the reaction loop does not yet use a dedicated role-aware policy matrix.
- Impact:
  - Advanced role-specific policies require additive orchestration abstractions.

## Safe, backward-compatible interpretation

- The safest path is additive evolution:
  - keep existing `ProjectConfig` and `agentConfig` behavior stable,
  - add optional profile/role/lineage fields,
  - preserve current CLI commands and dashboard routes while extending payloads.
