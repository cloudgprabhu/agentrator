---
name: agent-orchestrator-feature-development
description: Repository-specific workflow for adding or extending features in the Agent Orchestrator monorepo. Use when working in this repository on new CLI commands, config fields, orchestration behavior, dashboard or API changes, plugin implementations, or contributor-facing docs, especially when changes must remain backward compatible and keep tests and examples aligned.
---

# Agent Orchestrator Feature Development

## Quick Start

- Read `AGENTS.md`, `README.md`, and `docs/architecture/code-map.md` before changing code.
- Map the request to the smallest affected surface: core config/types, session lifecycle, CLI, web, or a plugin package.
- Preserve backward compatibility unless the request explicitly allows a breaking change.
- Update tests for every behavior change and update docs/examples for every user-visible or config-visible change.
- Use the repo response format from `AGENTS.md` when reporting results.

## Route The Request

### Config or schema changes

- Update `packages/core/src/types.ts` and `packages/core/src/config.ts` together.
- Keep defaults, migrations, and validation behavior aligned.
- If the new field is visible to users, update `agent-orchestrator.yaml.example` and the most relevant file under `examples/`.
- Check whether CLI, web API, and serialization layers need the new field exposed.

### Session, lifecycle, or metadata changes

- Start in `packages/core/src/session-manager.ts`, `packages/core/src/lifecycle-manager.ts`, and the metadata/path helpers they use.
- Review existing tests in `packages/core/src/__tests__/` before adding new behavior; extend the nearest suite instead of creating unrelated coverage.
- If the change surfaces in status views or SSE updates, propagate it through CLI/web consumers.

### CLI changes

- Update `packages/cli/src/index.ts` for command registration and the targeted file in `packages/cli/src/commands/`.
- Reuse existing command parsing, output formatting, and preflight helpers from `packages/cli/src/lib/`.
- Add or update tests under `packages/cli/__tests__/commands/` or `packages/cli/__tests__/lib/`.

### Dashboard or API changes

- Update the route under `packages/web/src/app/api/` first, then keep `packages/web/src/lib/types.ts`, `packages/web/src/lib/serialize.ts`, and the relevant component props in sync.
- Preserve server/client boundaries in Next.js code; do not move logic into client components unless the UI truly needs it.
- Add route or component tests in `packages/web/src/**/__tests__/`.

### Plugin additions or extensions

- Follow the plugin package pattern in `references/plugin-and-surface-map.md`.
- Keep plugin manifests, package names, and slot contracts consistent with `packages/core/src/types.ts`.
- Wire the plugin into the CLI or web consumer only where that slot is resolved today; do not add dynamic loading if the repo already uses static imports.

## Execution Workflow

1. Inspect the current implementation in the target package and copy the prevailing pattern.
2. Identify all coupled surfaces before editing: types, validation, runtime wiring, docs, examples, and tests.
3. Change the smallest set of files that makes the feature coherent end-to-end.
4. Add or update tests in the touched package first; add integration coverage only when the change crosses process, tmux, or real-binary boundaries.
5. Run targeted verification from `references/verification-matrix.md`.
6. If the feature introduces new user-facing configuration, commands, or dashboard behavior, update the matching docs before finishing.

## Guardrails

- Prefer existing types, config loaders, and command helpers over introducing parallel abstractions.
- Do not invent config fields without updating types, validation, examples, docs, and tests together.
- Do not rename or refactor unrelated modules while implementing a feature.
- Keep changes backward compatible by default.
- Build before running the web dev server; this repo expects built workspace packages.

## References

- Read [references/plugin-and-surface-map.md](references/plugin-and-surface-map.md) for insertion points by feature area.
- Read [references/verification-matrix.md](references/verification-matrix.md) before choosing validation commands.

## Example Triggers

- "Use $agent-orchestrator-feature-development to add a new notifier plugin."
- "Use $agent-orchestrator-feature-development to extend the config schema and expose it in the dashboard."
- "Use $agent-orchestrator-feature-development to add a new `ao` command and the tests/docs it needs."
