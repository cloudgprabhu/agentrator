# Unit Test Cases

This document enumerates detailed unit-level test cases for the fork-specific behavior added on top of the upstream Agent Orchestrator codebase.

Use it as a supplement to [test-strategy.md](test-strategy.md). The strategy document explains what to test and why; this document gives concrete unit-case definitions.

## 1. Config schema parsing

### Test name

`parses_additive_provider_auth_model_role_workflow_schema`

Purpose:

- verify that the fork’s additive top-level schema loads successfully when all new blocks are present

Setup:

- create a minimal config object or YAML fixture with `providers`, `authProfiles`, `modelProfiles`, `roles`, `workflow`, and one project

Inputs:

- valid config with one provider, one auth profile, one model profile, one role, and one workflow mapping

Expected result:

- config parses successfully
- normalized defaults are applied where expected

Edge cases:

- omit optional maps entirely
- include empty objects for additive maps

### Test name

`rejects_unknown_top_level_field_in_fork_schema`

Purpose:

- prove that unexpected config fields fail clearly instead of being silently ignored

Setup:

- create a config fixture with one invalid top-level key

Inputs:

- config containing an unsupported top-level field such as `providerProfiles`

Expected result:

- parse/validation fails with a clear field-specific error

Edge cases:

- typo close to a valid field name
- invalid field nested under an otherwise valid block

## 2. Config reference validation

### Test name

`rejects_model_profile_with_unknown_auth_profile_reference`

Purpose:

- verify cross-reference validation between `modelProfiles` and `authProfiles`

Setup:

- valid config except `modelProfiles.<key>.authProfile` points to a missing profile

Inputs:

- config with one broken model-profile auth reference

Expected result:

- validation fails with a path-specific error mentioning the missing auth profile

Edge cases:

- missing provider and missing auth profile in the same profile
- role references the broken model profile

### Test name

`rejects_workflow_with_unknown_role_reference`

Purpose:

- ensure workflow role slots do not accept missing role keys

Setup:

- config with a valid project and workflow block but a missing `reviewRole`

Inputs:

- `workflow.default.reviewRole: missing-reviewer`

Expected result:

- validation fails before runtime use

Edge cases:

- only one workflow slot is broken
- multiple workflow slots reference the same missing role

## 3. Config migration

### Test name

`migrates_legacy_single_project_config_without_dropping_existing_defaults`

Purpose:

- confirm migration preserves the original usable parts of an upstream-style config

Setup:

- provide a legacy config fixture with `defaults` and one project only

Inputs:

- legacy YAML file

Expected result:

- migrated file preserves project/default fields
- additive blocks are created if missing
- original source file remains unchanged unless `--in-place` is used

Edge cases:

- source file omits `defaults`
- project lacks explicit `sessionPrefix`

### Test name

`refuses_to_overwrite_existing_output_without_force`

Purpose:

- ensure migration output is safe by default

Setup:

- existing destination file present on disk

Inputs:

- `ao config migrate --output existing.yaml`

Expected result:

- command fails unless `--force` or `--in-place` is explicitly provided

Edge cases:

- default migrated output path already exists
- `--in-place` with source path equal to destination

## 4. Canonical project ID resolution

### Test name

`uses_project_map_key_as_canonical_project_id`

Purpose:

- prove that AO uses the `projects.<key>` identifier rather than the repo path basename

Setup:

- config with `projects.planner.path: ~/repo` and `projects.reviewer.path: ~/repo`

Inputs:

- load config and derive session/storage paths for each project

Expected result:

- planner and reviewer resolve to different project IDs and separate AO storage paths

Edge cases:

- same `sessionPrefix` accidentally reused
- path basename matches one project key but not the others

### Test name

`loads_legacy_single_project_yaml_through_normal_loader_path`

Purpose:

- preserve old config behavior through the real loader path, not just direct validator calls

Setup:

- write a minimal upstream-style YAML file to disk

Inputs:

- `loadConfig()` or equivalent loader call

Expected result:

- config loads successfully with the expected canonical project key

Edge cases:

- file named `.yml` instead of `.yaml`
- config discovered through default lookup instead of explicit path

## 5. Auth profile resolution

### Test name

`resolves_auth_profile_and_provider_for_valid_profile_key`

Purpose:

- verify `resolveAuthProfile()` returns the expected profile and provider pair

Setup:

- config with one `authProfiles` entry and matching `providers` entry

Inputs:

- profile key string

Expected result:

- resolved auth profile contains the correct provider key and provider metadata

Edge cases:

- provider kind declared only via provider metadata
- browser and api-key profiles under the same provider

### Test name

`rejects_inline_secret_like_fields_in_auth_profile`

Purpose:

- keep secrets out of config files

Setup:

- config with `authProfiles.bad.token` or `authProfiles.bad.apiKey`

Inputs:

- profile key for the invalid auth profile

Expected result:

- resolver throws a clear inline-secret validation error

Edge cases:

- nested secret-like key inside `options`
- safe reference fields such as `credentialEnvVar` still allowed

## 6. Auth adapter status logic

### Test name

`maps_browser_cli_authenticated_output_to_authenticated_status`

Purpose:

- normalize provider CLI output into AO auth status values

Setup:

- stub browser auth adapter runner to return JSON or text indicating an authenticated state

Inputs:

- adapter `getStatus()` call

Expected result:

- status is `authenticated`
- message is sanitized and CLI-safe

Edge cases:

- JSON output vs plain text output
- provider CLI returns success with extra noise in stderr

### Test name

`returns_unsupported_environment_for_browser_login_in_ci`

Purpose:

- prevent browser login attempts in known unsupported environments

Setup:

- adapter configured with `isCi: true`

Inputs:

- adapter `login()` call

Expected result:

- status is `unsupported_environment`
- message does not leak raw CLI output

Edge cases:

- Linux without `DISPLAY`
- CLI binary missing vs environment unsupported

## 7. Provider registry lookup

### Test name

`returns_supported_provider_metadata_without_exposing_mutable_shared_state`

Purpose:

- ensure registry lookups are safe for validation and UI consumers

Setup:

- call `getProviderByKind()` and mutate the returned object in the test

Inputs:

- known provider kind such as `openai`

Expected result:

- subsequent lookups return intact provider metadata

Edge cases:

- mutation of nested capabilities
- `listSupportedProviders()` return values

### Test name

`rejects_unknown_provider_kind_in_lookup_path`

Purpose:

- verify unsupported providers fail clearly at lookup or validation time

Setup:

- call the registry with a missing provider kind

Inputs:

- unknown provider key or kind

Expected result:

- lookup returns `null` or validation throws as expected

Edge cases:

- custom providers
- provider key exists but maps to unsupported kind

## 8. Model profile resolution

### Test name

`resolves_role_to_model_provider_auth_and_runtime_settings`

Purpose:

- verify full role-based runtime resolution

Setup:

- config with one role pointing to one model profile containing provider, auth, model, and runtime settings

Inputs:

- `resolveModelRuntimeConfig({ projectId, roleKey, agent })`

Expected result:

- output contains the expected `roleKey`, `modelProfileKey`, `providerKey`, `authProfileKey`, `model`, prompt settings, and runtime settings

Edge cases:

- role prompt settings override model-profile prompt settings
- no workflow role provided

### Test name

`rejects_incompatible_agent_override_after_role_resolution`

Purpose:

- ensure `--agent` override does not bypass compatibility checks

Setup:

- role resolves to provider/model that are incompatible with the override agent

Inputs:

- resolution call with `agentOverride`

Expected result:

- resolution throws a compatibility error

Edge cases:

- compatible override succeeds
- incompatible model but compatible agent still fails

## 9. Runtime metadata generation

### Test name

`persists_resolved_runtime_identity_fields_in_session_metadata`

Purpose:

- verify spawn writes canonical runtime metadata fields required by lifecycle, CLI, and dashboard

Setup:

- role-aware spawn through `SessionManager`

Inputs:

- spawn config with project, issue, and role

Expected result:

- metadata includes `projectId`, `issueId`, `role`, `agent`, `provider`, `authProfile`, `authMode`, and `model`

Edge cases:

- legacy fields like `project` and `issue` remain compatible
- default agent path without explicit role

### Test name

`restores_archived_session_with_canonical_runtime_fields_intact`

Purpose:

- confirm archive/restore preserves the canonical metadata that newer surfaces depend on

Setup:

- archived metadata fixture containing resolved runtime fields

Inputs:

- restore operation or metadata reconstruction helper

Expected result:

- restored session still exposes the same canonical runtime identity fields

Edge cases:

- older archive missing some newer keys
- restore of terminal vs non-terminal session

## 10. Role resolution

### Test name

`selects_workflow_parent_issue_role_for_orchestrator_spawn`

Purpose:

- verify orchestrator sessions derive from `workflow.parentIssueRole`

Setup:

- project with workflow mapping and explicit parent issue role

Inputs:

- `spawnOrchestrator({ projectId })`

Expected result:

- resolved runtime config uses the planner/parent role metadata

Edge cases:

- project without workflow configured falls back safely
- missing parent role should fail clearly

### Test name

`selects_child_issue_role_when_regular_spawn_uses_workflow_default`

Purpose:

- verify normal workflow-driven spawn chooses `childIssueRole` when no explicit role is passed

Setup:

- project with workflow mapping and child role configured

Inputs:

- `spawn({ projectId, issueId })`

Expected result:

- session metadata and launch config reflect the child role

Edge cases:

- explicit `role` overrides workflow default
- no workflow configured preserves legacy behavior

## 11. Role-aware spawn argument handling

### Test name

`forwards_role_flag_from_spawn_command_to_session_manager`

Purpose:

- ensure CLI parsing does not drop the requested role

Setup:

- CLI command test with mocked session manager

Inputs:

- `ao spawn --role planner my-app INT-123`

Expected result:

- `sessionManager.spawn()` receives `{ role: "planner" }`

Edge cases:

- `--agent` provided alongside `--role`
- no issue ID provided

### Test name

`forwards_role_and_agent_from_spawn_role_command`

Purpose:

- verify `spawn-role` preserves both role and override agent arguments

Setup:

- CLI command test with mocked session manager

Inputs:

- `ao spawn-role my-app planner INT-123 --agent codex`

Expected result:

- `sessionManager.spawn()` receives both `role` and `agent`

Edge cases:

- ad-hoc issue strings
- optional prompt text present

## 12. Task-plan schema validation

### Test name

`accepts_valid_task_plan_yaml_with_required_child_task_fields`

Purpose:

- validate the planner artifact schema

Setup:

- minimal valid YAML task-plan content

Inputs:

- task-plan file or parsed content

Expected result:

- validation succeeds
- normalized task plan exposes all required child task fields

Edge cases:

- `specPath` and `adrPath` set to `null`
- empty arrays for dependencies, suggested files, and labels

### Test name

`rejects_task_plan_missing_acceptance_criteria_or_summary`

Purpose:

- ensure incomplete planner output is rejected before downstream workflow steps

Setup:

- invalid YAML task-plan content

Inputs:

- child task missing `summary` or `acceptanceCriteria`

Expected result:

- validation fails with source/path context

Edge cases:

- malformed YAML syntax
- invalid child task index ordering assumptions

## 13. Lineage entity creation

### Test name

`creates_lineage_planning_session_and_child_issue_entities`

Purpose:

- verify lineage can be seeded and extended safely

Setup:

- create planning session entry, then merge child issues into the same lineage file

Inputs:

- valid planning session ref and child issue list

Expected result:

- lineage file contains `planningSession` plus normalized `childIssues[]`

Edge cases:

- repeated child merge preserves prior sessions and PR data
- projectId omitted from base metadata

### Test name

`rejects_lineage_merge_that_drops_existing_child_reference`

Purpose:

- prevent silent lineage corruption

Setup:

- existing lineage file with two child issues

Inputs:

- merge call containing only one of the existing children

Expected result:

- merge fails with a clear missing-child-reference error

Edge cases:

- mismatched parent issue
- mismatched task plan path

## 14. Workflow state transitions

### Test name

`allows_declared_child_state_transitions_and_rejects_invalid_ones`

Purpose:

- verify the lineage state machine contract

Setup:

- lineage child starting in `queued`

Inputs:

- transition calls across valid and invalid states

Expected result:

- valid transitions succeed
- invalid transitions throw a specific transition error

Edge cases:

- repeated transition to the same state
- terminal `done` state should not reopen implicitly

### Test name

`moves_child_to_done_when_tracker_reports_completion_during_implement_step`

Purpose:

- ensure implementation orchestration respects tracker completion state

Setup:

- lineage with queued child issue and tracker mock returning completed

Inputs:

- `workflow implement`-style decision path

Expected result:

- child state becomes `done`
- no new implementation session is spawned

Edge cases:

- active session exists and tracker also says completed
- concurrency limit present

## 15. Reviewer outcome handling

### Test name

`records_approve_outcome_and_updates_child_state`

Purpose:

- verify happy-path reviewer completion

Setup:

- lineage with child issue in `waiting_review`
- tracker mock with update support

Inputs:

- `review-outcome --outcome approve --summary "..."`

Expected result:

- child state becomes `approved`
- summary comment is written to the child issue surface

Edge cases:

- child already approved
- PR-linked child vs issue-only child

### Test name

`request_changes_routes_feedback_back_to_implementer`

Purpose:

- ensure reviewer feedback returns to implementation flow

Setup:

- lineage with child issue and either an active implementer session or none

Inputs:

- `review-outcome --outcome request_changes --summary "..."`

Expected result:

- child state becomes `changes_requested`
- if active implementer exists, AO sends the request to that session
- otherwise AO spawns a new implementer session

Edge cases:

- missing `childIssueRole`
- tracker update succeeds but implementer handoff fails

### Test name

`create_follow_up_appends_task_plan_issue_and_lineage_entry`

Purpose:

- verify reviewer follow-up generation remains consistent across task plan, tracker, and lineage

Setup:

- existing task-plan file and matching lineage file
- tracker mock with issue creation support

Inputs:

- `review-outcome --outcome create_follow_up --follow-up-title "..."`

Expected result:

- task-plan YAML gains one child task
- tracker creates one follow-up issue
- lineage gains one queued child issue
- original child moves to `blocked`

Edge cases:

- missing follow-up title
- lineage/task-plan path mismatch
