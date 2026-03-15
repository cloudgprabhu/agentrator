# Integration Test Cases

This document enumerates integration and end-to-end scenario cases for the fork-specific behavior in Agent Orchestrator.

Use it with [test-strategy.md](test-strategy.md) and [unit-test-cases.md](unit-test-cases.md). This document focuses on multi-module flows where core, CLI, web, metadata, and workflow artifacts must all agree.

## 1. Legacy config still works

### Scenario name

`legacy_single_agent_config_remains_usable`

System setup:

- upstream-style config with `defaults` and one project only
- no `providers`, `authProfiles`, `modelProfiles`, `roles`, or `workflow`
- mocked runtime, agent, workspace, and tracker plugins

Test steps:

1. load the legacy config through the normal config loader
2. run `ao start` or equivalent orchestrator startup path
3. run `ao spawn <project> <issue>`
4. query session list and session detail

Expected transitions:

- config loads without migration being mandatory
- spawn transitions `spawning -> working` or equivalent normal legacy flow
- no workflow-only paths are required

Expected persisted metadata:

- canonical session metadata still exists
- legacy-compatible fields remain readable
- no provider/auth/model role fields are required for success

Expected CLI/dashboard visibility:

- `ao status` works
- session APIs return the session
- dashboard/session detail loads even if workflow enrichment is absent

## 2. Two logical projects share the same repo path

### Scenario name

`shared_repo_path_projects_stay_isolated_by_project_key`

System setup:

- config with `projects.planner` and `projects.reviewer` sharing the same `path`
- distinct `sessionPrefix` values
- temp AO data directory

Test steps:

1. spawn one session under `planner`
2. spawn one session under `reviewer`
3. list sessions per project
4. inspect on-disk metadata/session directories

Expected transitions:

- each project spawns independently
- no cross-project collision in session allocation or directory lookup

Expected persisted metadata:

- metadata files persist `projectId` as `planner` and `reviewer`
- AO storage paths resolve under separate canonical project-key directories

Expected CLI/dashboard visibility:

- project-scoped status and API routes return the correct sessions only
- shared repo path does not collapse the sessions into one project view

## 3. Browser auth profile available and usable

### Scenario name

`browser_auth_profile_is_available_and_supports_spawn`

System setup:

- config with provider and browser-account auth profile
- browser auth adapter stub returns `authenticated`
- role/model profile resolves through that auth profile

Test steps:

1. run `ao auth status`
2. spawn a role-aware session using the browser-auth profile
3. inspect resulting metadata

Expected transitions:

- auth status reports `authenticated`
- spawn proceeds instead of failing early

Expected persisted metadata:

- `authProfile` and `authMode=browser-account` persist
- resolved `provider`, `model`, and `agent` persist

Expected CLI/dashboard visibility:

- auth status shows usable profile
- `ao status --verbose` and session API payloads include auth/runtime identity fields

## 4. Role-based spawn resolves correct provider/model/auth

### Scenario name

`role_based_spawn_resolves_full_runtime_identity`

System setup:

- config with `providers`, `authProfiles`, `modelProfiles`, and `roles`
- workflow or explicit role selection enabled

Test steps:

1. run `ao spawn --role planner <project> <issue>`
2. inspect launch config passed to the agent plugin
3. read session metadata

Expected transitions:

- role resolves to the intended model profile
- compatible provider/agent/model path is selected

Expected persisted metadata:

- `role`
- `agent`
- `provider`
- `authProfile`
- `authMode`
- `model`

Expected CLI/dashboard visibility:

- verbose CLI and dashboard serialization show the same resolved runtime identity

## 5. Planner creates valid task-plan

### Scenario name

`workflow_planner_session_creates_valid_task_plan_path_and_lineage_seed`

System setup:

- project configured with `workflow.parentIssueRole`
- writable project docs path
- planner session spawn mocked

Test steps:

1. run `ao workflow plan <project> <parent-issue>`
2. verify expected artifact path is announced
3. validate the resulting task-plan path with `ao workflow validate-plan`
4. inspect lineage seed file

Expected transitions:

- planning session created
- lineage file seeded with `planningSession`

Expected persisted metadata:

- planner session metadata contains resolved role/runtime identity
- lineage file contains `parentIssue`, `taskPlanPath`, and `planningSession`

Expected CLI/dashboard visibility:

- planner command prints session/artifact path
- lineage queries can resolve the parent issue after planning

## 6. Child issues are created from task-plan

### Scenario name

`task_plan_creates_tracker_issues_and_lineage_children`

System setup:

- valid task-plan YAML file
- tracker plugin mock with `createIssue`
- existing or seeded lineage file path

Test steps:

1. run `ao workflow create-issues <project> <plan-file>`
2. inspect tracker create calls
3. read the lineage artifact

Expected transitions:

- one child issue created per `childTasks[]` entry
- child issues initialize as `queued`

Expected persisted metadata:

- lineage child entries include task index, issue id, issue url, issue label, labels, and dependencies

Expected CLI/dashboard visibility:

- command output lists created child issues
- lineage CLI/API shows the created children

## 7. Implement workflow spawns implementer sessions

### Scenario name

`implement_command_starts_sessions_for_eligible_children_only`

System setup:

- lineage file with multiple children
- tracker mock for completion checks
- session manager mock with some active sessions

Test steps:

1. run `ao workflow implement <project> <parent-issue>`
2. repeat with `--concurrency`
3. inspect updated lineage and started sessions

Expected transitions:

- eligible children move toward `in_progress`
- already active children are skipped
- completed children become `done`

Expected persisted metadata:

- new implementation session refs recorded under the correct child
- child states reflect started/skipped/completed paths

Expected CLI/dashboard visibility:

- implement command reports started and skipped children
- lineage/status views show updated child state and session linkage

## 8. Reviewer auto-spawns on PR event

### Scenario name

`pr_webhook_event_auto_handoffs_to_reviewer_once`

System setup:

- lineage file with child issue and PR linkage
- workflow with `reviewRole`
- webhook request fixture for `pull_request opened` or `synchronize`
- session manager mock and existing sessions list

Test steps:

1. post webhook payload to the webhook route
2. verify reviewer spawn
3. repeat the same PR update burst

Expected transitions:

- first event spawns reviewer handoff
- second duplicate burst is skipped safely

Expected persisted metadata:

- reviewer session linkage is associated with the child issue path
- lineage/session state remains consistent after duplicate suppression

Expected CLI/dashboard visibility:

- webhook response includes spawned review session or skip reason
- status/lineage views reflect reviewer activity

## 9. Changes requested loop updates child issue state

### Scenario name

`request_changes_routes_back_to_implementer_and_updates_lineage`

System setup:

- lineage file with child in `waiting_review` or `pr_opened`
- workflow with `childIssueRole`
- tracker mock with update support
- either active implementer session or none

Test steps:

1. run `ao workflow review-outcome <project> <ref> --outcome request_changes --summary "..."`
2. inspect tracker update
3. inspect lineage child state
4. inspect send/spawn behavior for implementer routing

Expected transitions:

- child becomes `changes_requested`
- implementer receives feedback by `send()` or new spawn

Expected persisted metadata:

- lineage state updates persist
- implementer session linkage remains associated with the child

Expected CLI/dashboard visibility:

- review-outcome command shows routed follow-up work
- lineage/status views surface the changed child state

## 10. Approved flow marks lineage/workflow complete

### Scenario name

`approve_and_completion_path_marks_child_complete`

System setup:

- lineage file with child under review
- tracker mock with update support
- optional PR metadata already attached

Test steps:

1. run `ao workflow review-outcome --outcome approve`
2. if your flow includes a later completion step, run the completion/implement reconciliation path
3. re-read lineage

Expected transitions:

- child first moves to `approved`
- downstream completion path may move to `done` when the workflow considers the item complete

Expected persisted metadata:

- child state reflects approval/completion
- PR/session linkage remains intact

Expected CLI/dashboard visibility:

- lineage output shows the final child state
- dashboard badges reflect approved/done status

## 11. Invalid config fails early with clear errors

### Scenario name

`invalid_config_never_reaches_runtime_creation`

System setup:

- broken config fixture with invalid provider/auth/model/role/workflow references
- runtime mock that would fail the test if called

Test steps:

1. load config or invoke the CLI path that uses it
2. observe the resulting failure

Expected transitions:

- config path fails before workspace/runtime/session creation

Expected persisted metadata:

- no session metadata or lineage artifacts are written

Expected CLI/dashboard visibility:

- CLI prints field-specific validation errors
- dashboard startup/config-dependent routes fail clearly instead of hanging

## 12. Unavailable auth profile blocks session creation safely

### Scenario name

`unavailable_resolved_auth_profile_blocks_spawn_before_runtime_launch`

System setup:

- role/model profile resolves to an auth profile
- auth manager path reports that profile as unavailable or unsupported
- runtime mock that should not be called

Test steps:

1. run role-aware spawn or orchestrator spawn
2. inspect error
3. confirm no runtime/workspace side effects occurred

Expected transitions:

- spawn fails early
- no session is launched

Expected persisted metadata:

- no new session metadata is written
- no lineage/session link is created

Expected CLI/dashboard visibility:

- CLI error clearly names the resolved auth profile and failure reason
- auth status command surfaces the same profile as unavailable
