# Verification Matrix

Choose the smallest command set that covers the changed surface, then widen if the change crosses package boundaries.

## Baseline repo checks

```bash
pnpm lint
pnpm typecheck
```

## Package-targeted checks

```bash
pnpm --filter @composio/ao-core test
pnpm --filter @composio/ao-core typecheck

pnpm --filter @composio/ao-cli test
pnpm --filter @composio/ao-cli typecheck

pnpm --filter @composio/ao-web test
pnpm --filter @composio/ao-web typecheck
```

## Cross-package or release-shape checks

```bash
pnpm build
pnpm test
```

## Integration checks

Run only when the change affects tmux/process runtime behavior, real agent launch wiring, terminal transport, or notifier/tracker integrations.

```bash
pnpm test:integration
```

## Web development reminder

Build the workspace before starting the dashboard dev server:

```bash
pnpm build
pnpm dev
```
