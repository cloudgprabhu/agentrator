# Config Migration Guide

This guide explains how to migrate legacy `agent-orchestrator.yaml` files to the new
provider/auth/model/role/workflow schema using the CLI.

## Command

```bash
ao config migrate [path]
ao config relocate-session-metadata [path]
```

- If `path` is omitted, AO uses normal config discovery (`agent-orchestrator.yaml`/`yml`).
- By default, migration output is written to a new file next to the source:
  - `agent-orchestrator.yaml` -> `agent-orchestrator.migrated.yaml`
- The original file is preserved by default.

## Output behavior

- The migrated file includes a comment header with:
  - warnings about legacy path-derived assumptions
  - manual actions still required
- Existing `projects` and `defaults` are preserved.
- Canonical runtime project identity now uses the config key under `projects:`.
  - Example: `projects.planner` and `projects.implementer` are distinct project IDs even if they share the same `path`.
- New schema maps are added if missing:
  - `providers`
  - `authProfiles`
  - `modelProfiles`
  - `roles`
  - `workflow`

## Options

```bash
ao config migrate --output /tmp/new-config.yaml
ao config migrate --force
ao config migrate --in-place
```

- `--output` writes to a specific path.
- `--force` allows overwriting an existing output file.
- `--in-place` explicitly overwrites the source config (opt-in only).

## Session metadata relocation

Legacy installs may still have active or archived metadata under a path-derived directory like:

```text
~/.agent-orchestrator/{hash}-{pathBasename}/sessions
```

Move that metadata into canonical project-key storage with:

```bash
ao config relocate-session-metadata [path]
```

- AO inspects each legacy metadata file and archive entry and routes it to:
  `~/.agent-orchestrator/{hash}-{projectId}/sessions`
- When a metadata file already carries `project` or `projectId`, that explicit project wins.
- If a legacy directory maps to only one configured project, AO falls back to that project.
- If multiple projects share the same old path-derived directory and a file does not declare a
  project, AO skips that file instead of guessing.
- Already-migrated duplicate files are deduped when the source and target contents match.

## Manual follow-up after migration

The migration helper cannot infer all semantic mappings safely. You should review and set:

1. `authProfiles` for browser/API/cloud auth strategies.
2. `modelProfiles` linking model + agent + auth profile.
3. `roles` mapping (planner/implementer/reviewer/fixer).
4. `workflow` definitions and each `projects.<id>.workflow` reference.
5. Run `ao config relocate-session-metadata` if you still have old metadata under a
   path-derived sessions directory.
6. Verify that any skipped relocation entries either declare `projectId`/`project` or are archived
   manually before removing old directories.

## Ambiguous shared-path installs

**When this happens:** Multiple projects in your config share the same `path` (a common pattern
when a single repository hosts several logical roles, such as `planner` and `implementer`).
If a legacy metadata file does not declare a `project` or `projectId` field, AO cannot safely
determine which project owns it and skips the file.

**What you will see:**

```
Skipped entries (not moved — manual action required):
  - ~/.agent-orchestrator/{hash}-shared/sessions/pla-1
    Reason: ambiguous project ownership across planner, implementer
    Candidates: planner, implementer
    Fix: open the file and add a line like  project: planner
    Then re-run: ao config relocate-session-metadata
```

**How to fix each skipped file:**

1. Open the skipped file in a text editor.
2. Inspect its content — the session prefix or branch name usually identifies the owning project
   (e.g. `branch=feat/PLAN-1` belongs to `planner`; `branch=feat/IMP-1` belongs to `implementer`).
3. Add a line declaring the correct project ID:
   ```
   project: planner
   ```
4. Save the file and re-run:
   ```bash
   ao config relocate-session-metadata
   ```
5. Repeat for each skipped file. Files that still cannot be attributed should be archived or
   deleted manually once you confirm they are no longer needed.

**Safety guarantee:** AO will never guess ownership. A file that cannot be unambiguously
attributed is always skipped rather than moved to the wrong project directory.

## Legacy assumptions warnings

Migration emits warnings when it detects path-derived legacy behavior, for example:

- Project has no explicit `sessionPrefix` (legacy auto-derivation from path basename).
- Project key equals path basename (legacy scripts may assume path-derived identity).
- Multiple projects share the same path basename.

Review these warnings before adopting config-key-based project identity conventions.
