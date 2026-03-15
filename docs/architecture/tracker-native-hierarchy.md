# Tracker Native Hierarchy Evaluation

**Status:** Decision
**Date:** 2026-03-15
**Context:** Task F04 - Evaluate native parent/child issue hierarchy support for GitHub and GitLab trackers

## Executive Summary

**Recommendation:** Do NOT implement native hierarchy support for GitHub or GitLab trackers at this time.

The current cross-platform baseline (lineage artifacts + issue-body linkage) provides better maintainability, consistency, and programmatic access than platform-specific native implementations would.

## Background

The Agent Orchestrator supports task decomposition where complex issues are recursively broken into atomic subtasks. The decomposer creates an in-memory task hierarchy with lineage tracking (ancestor relationships). The question is whether to map this hierarchy to native tracker features (GitHub sub-issues, Linear parent/child relationships, etc.) or continue with the current approach.

### Current Implementation

The system currently uses a **cross-platform baseline approach**:

1. **Lineage artifacts**: Task hierarchy stored in decomposition plans
   ```typescript
   interface TaskNode {
     id: string;           // hierarchical: "1", "1.2", "1.2.3"
     lineage: string[];    // ancestor descriptions root→parent
     children: TaskNode[];
     issueId?: string;     // tracker issue created for this subtask
   }
   ```

2. **Issue-body linkage**: Parent/child relationships embedded in issue descriptions
   - Cross-references via issue URLs
   - Markdown formatting shows hierarchy
   - Works across all trackers (GitHub, Linear, GitLab, etc.)

3. **Prompt context**: Agents receive lineage information regardless of tracker
   ```typescript
   formatLineage(lineage, current) // provides "where you fit" context
   formatSiblings(siblings, current) // provides "parallel work" awareness
   ```

### What "Native Hierarchy" Would Mean

Implementing native hierarchy would mean using tracker-specific APIs to create first-class parent/child relationships:
- GitHub: sub-issues feature
- Linear: parent/child issue linkage
- GitLab: issue hierarchies (if available)

## Research Findings

### GitHub Issues: Sub-Issues Feature

**UI Capabilities (2026):**
- ✅ Native sub-issue support in GitHub UI
- ✅ Up to 8 levels of nested sub-issues
- ✅ Parent issue and sub-issue progress tracking
- ✅ Projects v2 fields: "Parent issue" and "Sub-issue progress"
- ✅ Filtering by parent issue: `parent-issue:OWNER/REPO#NUMBER`

**API Access:**
- ❌ **No REST API parameter** for parent issue in `/repos/{owner}/{repo}/issues` endpoint
- ❌ **No gh CLI support** for sub-issue creation (no `--parent` flag)
- ❌ **No documented GraphQL mutation** for parent/child relationships
- ⚠️ Likely UI-only feature or undocumented API

**Source:** GitHub documentation (https://github.com/github/docs), gh CLI version check, REST API docs

### Linear Issues

**Current Implementation:**
- ❌ **No native hierarchy in Linear tracker plugin**
- The `packages/plugins/tracker-linear/src/index.ts` implements standard `Issue` interface
- No parent/child fields, no hierarchy-specific GraphQL queries
- Uses same cross-platform approach as GitHub

**Linear API Capabilities:**
Linear's GraphQL API DOES support parent/child relationships, but:
- Not currently implemented in the plugin
- Would require significant additional complexity
- Limited operator value given existing lineage system

### GitLab Issues

**Status:** Not researched in detail for this evaluation.

**Expected:** Likely similar to GitHub - may have UI features but limited programmatic API access for hierarchy management.

## Evaluation Criteria

To justify implementing native hierarchy for a tracker, ALL of the following must be true:

1. **Programmatic API access**: Clean, documented API for creating parent/child relationships
2. **gh/CLI tool support**: Can be implemented using standard CLI tools (gh, glab, etc.)
3. **Operator value**: Provides tangible benefits over current lineage + body linkage approach
4. **Maintenance cost**: Implementation complexity is proportional to value gained
5. **Cross-platform consistency**: Doesn't create confusing behavior differences between trackers

## Decision Rationale

### Why NOT Implement GitHub Native Hierarchy

1. **No programmatic API access** (criterion #1 fails)
   - GitHub's sub-issues appear to be a UI-only feature
   - Would require undocumented APIs or web scraping
   - High risk of breakage on GitHub changes

2. **gh CLI doesn't support it** (criterion #2 fails)
   - Current implementation relies on `gh` CLI
   - No `gh issue create --parent` or similar
   - Would need to drop down to raw GraphQL with authentication complexity

3. **Limited incremental value** (criterion #3 fails)
   - Current lineage artifacts already provide:
     - Full hierarchy tracking
     - Lineage context in agent prompts
     - Sibling awareness
     - Cross-tracker consistency
   - Native hierarchy would add:
     - UI visualization (marginal - markdown links already work)
     - Projects v2 filtering (nice-to-have, not essential)

4. **High maintenance cost** (criterion #4 fails)
   - Implementing undocumented APIs is brittle
   - Would need fallback logic when API unavailable
   - Testing complexity (mocking GitHub's sub-issue behavior)
   - Ongoing maintenance as GitHub evolves the feature

5. **Breaks cross-platform consistency** (criterion #5 fails)
   - GitHub agents would behave differently than Linear/GitLab agents
   - Operators need to understand two different systems
   - Migration between trackers becomes harder

### Why NOT Implement Linear Native Hierarchy

Same reasoning as GitHub, plus:
- Linear API access is better documented but still requires custom implementation
- Current cross-platform approach already works for Linear users
- Would diverge from other trackers unnecessarily

### Why the Current Approach Is Better

**Strengths of lineage artifacts + issue-body linkage:**

1. **Universal**: Works identically across all trackers
2. **Simple**: Markdown links and descriptions are universally supported
3. **Maintainable**: No tracker-specific complexity
4. **Flexible**: Can represent any hierarchy depth
5. **Reliable**: Not dependent on undocumented APIs
6. **Sufficient**: Agents get full context regardless of tracker backend

**Example issue body with lineage:**
```markdown
## Subtask: Implement Stripe webhook handler

**Parent:** #123 Build payment processing system
**Lineage:** Root → Payment system → Webhook integration → This task

**Siblings (parallel work):**
- Subtask 2.2: Build subscription management UI
- Subtask 2.3: Add payment error handling

## Description
[actual task description]
```

This provides:
- Clear hierarchy visibility
- Clickable navigation
- Works in all trackers
- No API dependencies

## Recommendation

### Immediate Action (F04)

**Do NOT implement native hierarchy** for GitHub or GitLab.

**Keep the current approach:**
- Lineage artifacts in decomposition plans
- Issue-body linkage for human-readable hierarchy
- Lineage context in agent prompts

### Future Criteria

Native hierarchy should ONLY be added to a tracker if:

1. **Official programmatic API** with stable, documented endpoints
2. **CLI tool support** (gh/glab/etc.) makes implementation trivial
3. **Significant operator value** beyond current lineage system (e.g., automation, reporting, governance)
4. **Low maintenance burden** (< 100 LOC, no custom auth, no API reverse engineering)

### Example: When Native Hierarchy Would Be Worth It

If GitHub released:
```bash
gh issue create --title "Subtask" --parent 123
```

And:
```bash
gh issue list --parent 123 --json number,title,state
```

Then native hierarchy would meet criteria #1 and #2, and we could reassess.

## Alternative Considered: Hybrid Approach

**Considered:** Implement native hierarchy where available, fall back to lineage artifacts elsewhere.

**Rejected because:**
- Doubles implementation complexity (both systems must work)
- Creates inconsistent operator experience
- Agents need to handle both approaches
- Fallback logic adds edge cases and testing burden
- Violates "one way to do it" principle

## Implementation Notes

### If GitHub API Becomes Available

If GitHub later exposes sub-issue APIs:

1. Add optional `parentIssue?: string` to `CreateIssueInput` type
2. Implement in `tracker-github` plugin only if gh CLI supports it
3. Document the behavior difference in tracker plugin docs
4. Ensure lineage artifacts remain the source of truth

### Current System Components

Files that implement the current lineage approach:
- `packages/core/src/decomposer.ts` - Task hierarchy and lineage
- `packages/core/src/prompt-builder.ts` - Injects lineage into agent prompts
- `packages/core/src/types.ts` - `Issue` interface (no hierarchy fields)
- `packages/plugins/tracker-github/src/index.ts` - Issue-body linkage
- `packages/plugins/tracker-linear/src/index.ts` - Issue-body linkage

## References

- GitHub sub-issues docs: https://github.com/github/docs/blob/main/content/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues.md
- GitHub REST API: https://docs.github.com/en/rest/issues/issues
- Completion backlog F04: `docs/completion-backlog.md`
- PR #365: Task decomposition and lineage implementation
- Commit 4edf19d: Lifecycle manager and decomposition feature

## Appendix: GitLab Research (Future)

If GitLab evaluation is needed:

1. Check `glab issue create --help` for parent/child flags
2. Review GitLab GraphQL API for issue hierarchy mutations
3. Test UI capabilities for nested issues/epics
4. Apply same evaluation criteria as GitHub

Expected outcome: Likely similar to GitHub (UI features exist, programmatic access limited).
