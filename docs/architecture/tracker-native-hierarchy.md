# Tracker Native Hierarchy Evaluation

**Status:** Decision
**Date:** 2026-03-15
**Context:** Task F04 - Evaluate native parent/child issue hierarchy support for GitHub and GitLab trackers

## Executive Summary

**Recommendation:** Keep lineage artifacts and issue-body linkage as the cross-platform source of truth, and add native hierarchy only where the platform support is official and cheap to maintain.

That means:

- keep the existing best-effort native hierarchy in Linear
- add best-effort native hierarchy for GitHub
- keep GitLab on the lineage-plus-body baseline for now

## Current Implementation

The workflow system always preserves hierarchy in tracker-agnostic ways:

1. **Lineage artifacts** store the machine-readable parent/child model.
2. **Issue bodies** include parent context and sibling context for humans.
3. **Prompt context** gives agents the same lineage information regardless of tracker.

On top of that baseline, native hierarchy is allowed only when it does not become the source of truth and does not add disproportionate tracker-specific maintenance.

## Evaluation Criteria

To justify native hierarchy for a tracker, all of the following should be true:

1. There is a documented API for creating the relationship.
2. The relationship can be driven through the repo's existing CLI/auth path.
3. The operator gets real value beyond markdown linkage alone.
4. The implementation can remain best-effort and stay small.
5. Lineage artifacts can remain authoritative when the native call fails.

## Findings

### Linear

Linear already meets the bar for a small best-effort implementation:

- its GraphQL API supports parent/child linkage
- the existing tracker plugin already resolves `parentIssueId` to Linear's `parentId`
- the implementation is isolated to issue creation and does not replace lineage artifacts

Decision: keep Linear native hierarchy support.

### GitHub

GitHub now meets the bar as well:

- GitHub has official sub-issues REST endpoints
- `gh issue create` still does not expose a `--parent` flag
- `gh api` can call the official REST endpoint using the same authenticated CLI transport the plugin already depends on
- native sub-issues add useful UI progress tracking and parent filtering for GitHub-heavy operators

Decision: implement GitHub native hierarchy as a best-effort follow-up call after issue creation.

This keeps the implementation small and safe:

- create the child issue normally
- try to attach it to the parent via `gh api`
- if the attach step fails, keep the issue and rely on lineage artifacts plus issue bodies

### GitLab

GitLab does not meet the bar yet for this repo's standard issue flow:

- GitLab documents child items and work item hierarchy concepts
- the current `glab issue create` flow does not expose a stable parent/child flag
- the work item APIs are separate enough from the current plugin path that adding support would increase product-specific complexity
- the operator value does not justify adding a second bespoke implementation while lineage already preserves the relationship

Decision: do not add GitLab native hierarchy at this time.

## Decision

Native hierarchy is justified only for trackers where the implementation stays small and official.

Current repo stance:

- **Linear:** supported, best-effort
- **GitHub:** supported, best-effort
- **GitLab:** not supported natively; lineage-plus-body baseline only

In every case, lineage artifacts remain the source of truth.

## Implementation Notes

- `CreateIssueInput.parentIssueId` remains optional.
- Unsupported trackers may ignore `parentIssueId`.
- Supported trackers should never fail issue creation solely because the native parent/child attach step failed.

Relevant files:

- `packages/core/src/types.ts`
- `packages/cli/src/commands/workflow.ts`
- `packages/plugins/tracker-linear/src/index.ts`
- `packages/plugins/tracker-github/src/index.ts`
- `packages/plugins/tracker-gitlab/src/index.ts`

## References

- GitHub sub-issues user docs: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
- GitHub REST sub-issues API: https://docs.github.com/en/rest/issues/sub-issues?apiVersion=2022-11-28
- GitHub CLI issue create help: https://cli.github.com/manual/gh_issue_create
- GitLab child items docs: https://docs.gitlab.com/user/work_items/child_items/
- GitLab work items GraphQL reference: https://docs.gitlab.com/api/graphql/work_items_reference/
