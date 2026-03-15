# Plugin And Surface Map

Use this file when deciding where a feature belongs.

## Core surfaces

- `packages/core/src/types.ts`
  Owns shared interfaces, config contracts, session types, and plugin slot contracts.
- `packages/core/src/config.ts`
  Owns config parsing, validation, defaults, and migration-sensitive schema changes.
- `packages/core/src/session-manager.ts`
  Owns spawn, restore, send, cleanup, runtime wiring, and metadata persistence.
- `packages/core/src/lifecycle-manager.ts`
  Owns polling, reactions, escalations, and status transitions.

## CLI surfaces

- `packages/cli/src/index.ts`
  Registers commands and top-level CLI entry points.
- `packages/cli/src/commands/*.ts`
  Own individual command behavior.
- `packages/cli/src/lib/create-session-manager.ts`
  Wires CLI code to the core services and plugin registry.
- `packages/cli/src/lib/plugins.ts`
  Statically imports the built-in plugins used by the CLI.

## Web surfaces

- `packages/web/src/app/api/**/*.ts`
  Own route handlers and backend API behavior.
- `packages/web/src/lib/types.ts`
  Owns serialized dashboard view models.
- `packages/web/src/lib/serialize.ts`
  Maps core objects into dashboard-facing data.
- `packages/web/src/components/*.tsx`
  Own rendered dashboard behavior.

## Plugin package pattern

- Place new plugins in `packages/plugins/<slot>-<name>/`.
- Use `src/index.ts` as the main module.
- Export `manifest` plus `create()` and default-export a `PluginModule`.
- Copy the structure from the nearest existing plugin in the same slot before inventing new layout.

## Typical feature routes

- New config field:
  `packages/core/src/types.ts`, `packages/core/src/config.ts`, relevant consumer package, `agent-orchestrator.yaml.example`, `examples/*.yaml`, tests.
- New CLI command or flag:
  `packages/cli/src/index.ts`, one command file, supporting lib helpers if needed, CLI tests, docs.
- New dashboard card, badge, or filter:
  API route or serializer, web types, component, tests.
- New plugin:
  plugin package, consumer wiring (`packages/cli/src/lib/plugins.ts` and/or web service setup), docs, tests.
- New orchestration behavior:
  `packages/core/src/session-manager.ts` or `packages/core/src/lifecycle-manager.ts`, then propagate any new metadata/status to CLI and web.
