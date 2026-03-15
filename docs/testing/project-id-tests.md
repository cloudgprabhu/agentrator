# Project ID Regression Tests

This note tracks automated regression coverage for canonical project identity behavior.

## Covered scenarios

1. Two logical projects with different config keys and the same repo path.
2. Two logical projects with different roles using the same repo path.
3. Legacy single-project config still validates and works.
4. `spawn`/`status` resolve the requested logical project key.

## Test locations

- Core config/path identity behavior:
  - `packages/core/src/__tests__/config-validation.test.ts`
  - `packages/core/src/__tests__/paths.test.ts`
  - `packages/core/src/__tests__/session-manager.test.ts`
- CLI command resolution behavior:
  - `packages/cli/__tests__/commands/spawn.test.ts`
  - `packages/cli/__tests__/commands/status.test.ts`

## Execution

```bash
pnpm --filter @composio/ao-core test -- src/__tests__/config-validation.test.ts src/__tests__/paths.test.ts src/__tests__/session-manager.test.ts
pnpm --filter @composio/ao-cli test -- __tests__/commands/spawn.test.ts __tests__/commands/status.test.ts
```

Notes:

- Core config tests cover shared-path logical projects, shared-path role-based projects, and legacy single-project YAML loading through the real config loader.
- Core session-manager tests cover collision-free runtime isolation when two logical projects share one repo path.
- CLI tests assert that user-provided project IDs drive `spawn` and `status` routing, independent of shared repo path, including explicit `--role` usage.
