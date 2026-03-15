# Troubleshooting

This page covers the most common operator issues in the fork.

## Config migration issues

### `ao config migrate` completed, but the project still does not behave correctly

The migration helper preserves structure, but it cannot infer every semantic mapping. Review:

- `authProfiles`
- `modelProfiles`
- `roles`
- `workflow`

Also verify that any legacy session metadata has moved away from old path-derived locations. AO now expects canonical project-key directories.

### Sessions appear under the wrong project

Check the key under `projects:`. That key is the canonical AO project ID, even when multiple projects share the same repo path.

## Auth issues

### `ao auth status` says `unavailable`

Common causes:

- the provider CLI is not installed
- the referenced credential env var is missing
- the AWS profile or shared credential file is not readable

Run:

```bash
ao auth status
```

Then fix the missing provider CLI or credential reference.

### `ao auth status` warns about unsupported browser auth environment

Browser login requires a local interactive environment. Typical causes:

- running in CI
- running on Linux without `DISPLAY`

Fix the environment first, then rerun:

```bash
ao auth login <profile>
```

### Spawn fails before the session starts with an auth-profile error

That is expected now. AO blocks session creation if the resolved auth profile is invalid or unavailable. Check:

```bash
ao auth status
ao status --verbose
```

Then confirm the role or model profile points to the intended auth profile.

## Role and model resolution issues

### `Unknown role`, `Unknown model profile`, or provider compatibility errors

Check the chain:

1. `projects.<id>.workflow`
2. `workflow.<key>`
3. `roles.<key>.modelProfile`
4. `modelProfiles.<key>`
5. `authProfiles.<key>` and `providers.<key>`

Also confirm the provider supports the selected agent and model family.

## Workflow issues

### `No lineage found for parent issue`

Run the earlier workflow steps first:

```bash
ao workflow plan my-app INT-123
ao workflow create-issues my-app docs/plans/int-123.task-plan.yaml
```

### Workflow review fails because the task plan is missing

The lineage file stores a path to the task-plan artifact. If that file was moved or deleted, review-context resolution fails. Restore the file or repair the path before retrying.

### Duplicate reviewer sessions were still created

Same-process PR-burst dedupe is in place, but multi-process or multi-instance web deployments still need a shared idempotency store. This remains an open follow-up in `open-risk.md`.

### Lineage merge fails with parent/task-plan mismatch

AO now rejects lineage overwrites that would corrupt existing parent-child references. Check whether:

- the wrong lineage file was reused
- the task-plan path changed without updating lineage
- a child issue entry was dropped during manual edits

Restore the correct lineage/task-plan pair and retry.

## Useful commands

```bash
ao auth status
ao status --verbose
ao workflow validate-plan docs/plans/int-123.task-plan.yaml
ao workflow lineage my-app INT-123 --json
```
