# RFC 0001: Fork Scope and v1 Boundaries

- Status: Draft
- Owner: Fork Maintainers
- Created: 2026-03-11
- Target: v1 planning baseline

## Background

This fork extends Agent Orchestrator from a single-agent-session orchestration model toward
multi-role workflows with explicit planning, implementation, review, and fix loops.

Current repository capabilities already provide:

- plugin-based runtime/agent/tracker/SCM architecture,
- issue-driven session spawning,
- session metadata and lineage-adjacent primitives,
- CLI and dashboard surfaces for session state.

This RFC defines the scope for a fork-specific v1 that stays backward-compatible with existing
core patterns while adding workflow and auth/provider/model controls.

## Repository Findings

Repository inspection found four implementation constraints that shape this fork:

1. Config ownership is centralized in `packages/core/src/config.ts` and `packages/core/src/types.ts`,
   so new workflow/provider/auth/model concepts should extend those contracts rather than bypass them.
2. Project identity is currently derived from path basename in `packages/core/src/paths.ts` and
   enforced in `packages/core/src/config.ts`, which is the current source of shared-repo collision risk.
3. Session creation, metadata persistence, and lifecycle reactions already flow through
   `packages/core/src/session-manager.ts`, `packages/core/src/metadata.ts`, and
   `packages/core/src/lifecycle-manager.ts`, so role and lineage support must fit those paths.
4. CLI and dashboard visibility are already split across `packages/cli/src/commands/status.ts`,
   `packages/cli/src/commands/spawn.ts`, `packages/web/src/app/api/sessions/route.ts`,
   `packages/web/src/lib/serialize.ts`, and dashboard components, so observability changes are
   cross-surface even when the core feature is configuration-driven.

## Problem Statement

The upstream design is optimized for "spawn agent per issue" workflows. Fork users need richer,
policy-driven orchestration:

1. multi-role logical workflows,
2. config-driven provider/auth/model profile selection,
3. browser and API/cloud authentication modes,
4. parent-child issue orchestration with review cycles,
5. multiple logical projects mapping to one repo path without project-id collisions,
6. visibility of workflow and auth/model/provider state in CLI and dashboard.

## Goals (v1)

1. Support logical workflow roles:
   - planner
   - implementer
   - reviewer
   - fixer

2. Support config-driven profile selection:
   - provider profile
   - auth profile
   - model profile

3. Support browser-based auth for:
   - Claude Code Pro/Max users
   - ChatGPT Plus/Pro users

4. Support API/cloud auth as a first-class alternative.

5. Support orchestration chain:
   - parent issue -> child issue -> implementation -> review

6. Support multiple logical projects pointing to the same repo path without project-id collision.

7. Expose workflow, lineage, model, provider, and auth details in:
   - CLI status/inspection surfaces
   - dashboard session and detail views

## Non-Goals (v1)

- Cross-repo orchestration.
- No-code workflow builder.
- Jira/Linear parity on day one.
- Mid-session model switching unless explicitly approved in a later RFC.

## Scope Boundaries

In scope for this RFC:

- functional boundary definition,
- terminology and constraints,
- milestone and acceptance criteria definitions.

Out of scope for this RFC:

- runtime implementation details,
- migration scripts,
- UI wireframes,
- plugin API breaking changes.

## Glossary

- Workflow Role: Logical responsibility for a session stage (planner/implementer/reviewer/fixer).
- Provider Profile: Named configuration describing provider selection (for example, Claude or OpenAI).
- Auth Profile: Named credential/auth mode configuration (browser-based or API/cloud).
- Model Profile: Named model selection and policy bundle (model id, limits, defaults).
- Lineage: Relationship metadata linking parent issue, child issues, and spawned sessions.
- Logical Project: Configured project identity used for orchestration/routing; may share repo path.
- Implementation Session: Session assigned to execute a child issue.
- Review Session: Session assigned to review/validate implementation output.
- Fix Session: Session assigned to address review findings.

## Constraints

1. Backward compatibility first.
   - Existing single-project, single-role configs must continue to work unchanged.

2. Reuse existing architecture.
   - Extend current plugin/config/session abstractions instead of introducing parallel systems.

3. Minimal viable complexity for v1.
   - Prefer additive metadata and optional config fields over mandatory schema replacement.

4. Explicit auth-mode boundaries.
   - Browser and API/cloud modes must be represented explicitly in config and session metadata.

5. Collision-safe logical project identity.
   - Same repo path across multiple logical projects must remain disambiguated at runtime and in UI.

6. Observable orchestration.
   - Workflow role, lineage, provider, auth profile, and model profile must be queryable and visible.

7. No implicit mid-session model switching.
   - Model profile is stable per session in v1 unless overridden by approved future policy.

## Milestones

### M1: Schema and Identity Foundation

- Define additive config structures for workflow/provider/auth/model profiles.
- Define logical project identity rules for shared-repo-path configurations.
- Define lineage metadata contract for parent/child issue orchestration.

Exit criteria:

- Config schema draft approved.
- Backward compatibility strategy documented.

### M2: Workflow Orchestration Surface

- Map planner/implementer/reviewer/fixer roles to orchestrated session lifecycle states.
- Define parent->child->implementation->review flow transitions and failure paths.

Exit criteria:

- Transition graph approved.
- Role and lineage metadata fields finalized.

### M3: Auth and Provider/Model Profile Resolution

- Define resolution order for provider/auth/model profiles (defaults, project overrides, session overrides).
- Define browser-auth and API/cloud-auth capability matrix and fallback behavior.

Exit criteria:

- Deterministic resolution rules documented.
- Capability matrix approved for Claude and OpenAI paths.

### M4: CLI and Dashboard Visibility Contract

- Define required CLI fields and dashboard fields for workflow/lineage/provider/auth/model data.
- Define behavior when metadata is partially unavailable.

Exit criteria:

- UI/API data contract approved.
- Backward-compatible rendering defaults documented.

## Acceptance Criteria (Fork v1 Scope)

1. Role Coverage
   - System supports planner/implementer/reviewer/fixer as explicit workflow roles.

2. Profile-Driven Selection
   - Provider, auth, and model profile selection is config-driven and deterministic.

3. Auth Mode Support
   - Browser-based auth paths are supported for Claude Code Pro/Max and ChatGPT Plus/Pro users.
   - API/cloud auth paths are supported in parallel.

4. Lineage-Oriented Orchestration
   - Parent issue -> child issue -> implementation -> review flow is representable and traceable.

5. Shared-Repo Logical Projects
   - Multiple logical projects can target one repo path without project-id collision.

6. Visibility Requirements
   - CLI and dashboard expose workflow, lineage, model, provider, and auth details per session.

7. Backward Compatibility
   - Existing configs and baseline workflows remain functional without mandatory migration.

## Safety and Compatibility Decisions

- Safest backward-compatible option selected for v1: additive, optional configuration and metadata.
- No runtime behavior changes are introduced by this RFC document itself.
- Breaking changes, if needed later, require follow-up RFCs with migration plans.

## Known Dependencies

- Existing plugin architecture and session metadata contracts in core packages.
- Existing CLI and dashboard data paths for session/status display.
- Existing config loading/validation patterns.

## Open Questions for Follow-Up RFCs

1. Exact config field names and validation schema for provider/auth/model profiles.
2. Canonical role-to-agent mapping strategy (default per role vs project-specific).
3. Priority rules when role policy and explicit user override conflict.
4. UX policy for displaying mixed auth modes across sessions.
