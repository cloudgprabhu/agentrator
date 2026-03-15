# Auth Architecture

This document defines the auth profile subsystem introduced in the fork.

## Goals

- Support auth profile types:
  - `browser-account`
  - `api-key`
  - `aws-profile`
  - `console`
- Keep secrets out of config files (references only).
- Provide health/status checks for auth configuration quality.
- Allow provider-specific auth adapters to be plugged in without changing core APIs.

## Core modules

- `packages/core/src/auth-profile-resolver.ts`
  - Resolves an auth profile key from config.
  - Validates provider linkage.
  - Detects forbidden inline secret values.
- `packages/core/src/auth-manager.ts`
  - `createAuthManager()` facade for resolution + health checks.
  - Supports adapter injection for provider-specific checks.
- `packages/core/src/auth-adapters/anthropic-claude-browser.ts`
  - Anthropic/Claude browser-account adapter.
  - Delegates `status/login/logout` to local Claude CLI.
  - Emits safe, CLI-friendly auth status values.
- `packages/core/src/auth-adapters/openai-codex-browser.ts`
  - OpenAI/Codex browser-account adapter.
  - Delegates `status/login/logout` to local Codex CLI.
  - Supports `chatgpt-plus` and `chatgpt-pro` account hints.
  - Emits safe, CLI-friendly auth status values.
- `packages/core/src/auth-adapters/non-browser-auth.ts`
  - OpenAI API-key adapter (env/reference validation).
  - Anthropic API-key adapter (env/reference validation).
  - AWS Bedrock profile adapter (env/shared-credentials/profile validation).
  - Optional console auth hook adapter for custom integration points.
- `packages/core/src/provider-registry.ts`
  - Canonical provider metadata registry for:
    - supported provider kinds,
    - capability flags,
    - compatible agent mappings.
  - Shared by validation and UI-oriented metadata consumers.
- `packages/core/src/types.ts`
  - Shared contracts:
    - `ResolvedAuthProfile`
    - `AuthHealthCheckResult`
    - `AuthProviderAdapter`
    - `AuthManager`

## Security model

Auth profiles must store references, not secret material.

Allowed reference fields:

- `credentialEnvVar`
- `credentialRef`
- provider-specific references under `options` (for example `options.profileRef`)

Disallowed inline secret patterns are rejected (for example `token`, `apiKey`, `secret`, `password`).

## Health checks

`AuthManager` exposes:

- `resolveProfile(profileKey)`
- `getProfileStatus(profileKey)`
- `loginProfile(profileKey)`
- `logoutProfile(profileKey)`
- `checkProfileHealth(profileKey)`
- `checkAllProfilesHealth()`

Health states:

- `healthy`
- `degraded`
- `invalid`
- `unconfigured`

Default health behavior is type-aware:

- `api-key`: requires `credentialEnvVar` or `credentialRef`
- `aws-profile`: expects reference fields (or provider-specific profile reference)
- `browser-account`: checks provider capability hints where available
- `console`: treated as interactive/local mode

Auth status values are CLI-compatible and normalized to:

- `authenticated`
- `not_authenticated`
- `unavailable`
- `unsupported_environment`

## Claude browser-account setup

Use browser-account profiles with Anthropic provider and optional account type hints:

```yaml
providers:
  anthropic:
    kind: anthropic
    capabilities:
      browserAuth: true

authProfiles:
  claude-browser:
    type: browser-account
    provider: anthropic
    accountType: claude-pro # or claude-max
```

Runtime behavior:

- Status checks call `claude auth status --json` when available.
- Login delegates to `claude auth login`.
- Logout delegates to `claude auth logout`.

Compatibility coverage:

- AO explicitly tests these Claude status output shapes:
  - JSON `{"authenticated": true|false}`
  - JSON `{"loggedIn": true|false}`
  - JSON `{"status": "authenticated"|"not_authenticated"}`
  - legacy text outputs such as `authenticated`, `not logged in`, `login required`, and `active session`
- AO defines Claude browser-auth support by this output contract rather than by CLI-reported semver negotiation.

Security constraints:

- Do not store secrets/tokens in YAML.
- Keep only references (`credentialRef` / `credentialEnvVar`) for non-browser modes.
- Error messages are sanitized and do not print secret-bearing output.

## API-key auth setup (OpenAI + Anthropic)

Config stores references only:

```yaml
providers:
  openai:
    kind: openai
  anthropic:
    kind: anthropic

authProfiles:
  openai-api:
    type: api-key
    provider: openai
    credentialEnvVar: OPENAI_API_KEY

  anthropic-api:
    type: api-key
    provider: anthropic
    credentialEnvVar: ANTHROPIC_API_KEY
```

Validation behavior:

- If referenced env vars are present, status resolves to `authenticated`.
- If env refs are missing, status resolves to `not_authenticated`.
- If `credentialRef` is provided (external secret store), status is treated as configured without revealing secret values.

## AWS profile / Bedrock auth setup

```yaml
providers:
  bedrock:
    kind: bedrock

authProfiles:
  bedrock-dev:
    type: aws-profile
    provider: bedrock
    options:
      profileRef: dev-profile
```

Validation behavior:

- Checks AWS static env references (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`) first.
- Otherwise checks local AWS credential/config files for the referenced profile.
- Status resolves to `authenticated`, `not_authenticated`, or `unavailable` with sanitized messages.

## Optional console-style auth hook

`createConsoleAuthHookAdapter()` supports custom status/login/logout hooks for environments that
need local interactive auth without provider-specific logic.

## Provider registry and compatibility metadata

Initial supported provider kinds in registry:

- `anthropic`
- `openai`
- `bedrock`

Registry exposes metadata for validation/UI:

- provider display name
- capability flags (`browserAuth`, `apiAuth`, `awsProfileAuth`, `supportsRoleOverride`)
- supported auth profile types
- compatible agent plugins

Validation uses this registry to detect:

- provider kind not in supported registry (except `custom`)
- provider default agent incompatibility
- auth profile type not supported by provider
- model profile provider/agent incompatibility

## CLI auth commands

The CLI exposes auth profile management commands:

```bash
ao auth list
ao auth status
ao auth status --json
ao auth status --live
ao auth login <profile>
ao auth logout <profile>
```

Behavior:

- `ao auth list` shows configured `authProfiles` with type/provider and reference presence only.
- `ao auth status` checks each profile through the auth subsystem and prints safe status values.
- `ao auth status --json` emits machine-readable profile status including provider, mode, availability, warnings, failure reason, next step, and raw health checks.
- `ao auth status --live` performs opt-in live validation for supported env-backed API-key profiles and warns when live validation is unavailable for opaque external secret references or unsupported profile types.
- `ao auth login <profile>` and `ao auth logout <profile>` delegate to provider adapters when supported.
- When status is `not_authenticated`, CLI prints a helpful next step (`ao auth login <profile>`).

Security note:

- CLI output does not print secret values.
- Config must continue using references (`credentialEnvVar` / `credentialRef`) instead of inline credentials.

## Codex browser-account setup

Use browser-account profiles with OpenAI provider and optional account type hints:

```yaml
providers:
  openai:
    kind: openai
    capabilities:
      browserAuth: true

authProfiles:
  codex-browser:
    type: browser-account
    provider: openai
    accountType: chatgpt-plus # or chatgpt-pro
```

Runtime behavior:

- Status checks call `codex auth status --json` when available.
- Login delegates to `codex auth login`.
- Logout delegates to `codex auth logout`.

Compatibility coverage:

- AO explicitly tests these Codex status output shapes:
  - JSON `{"authenticated": true|false}`
  - JSON `{"loggedIn": true|false}`
  - JSON `{"status": "authenticated"|"not_authenticated"}`
  - legacy text outputs such as `authenticated`, `not logged in`, `login required`, and `active session`
- Local verification in this workspace used `codex-cli 0.114.0`.
- AO defines Codex browser-auth support by this output contract rather than by CLI-reported semver negotiation.

Security constraints:

- Do not store secrets/tokens in YAML.
- Keep only references (`credentialRef` / `credentialEnvVar`) for non-browser modes.
- Error messages are sanitized and do not print secret-bearing output.

## Adapter plugin model

Provider-specific logic is pluggable via `AuthProviderAdapter`:

- `supports(context)` decides whether adapter handles a profile/provider pair.
- `checkHealth(context)` returns provider-specific health details.

This allows later integrations (OpenAI, Anthropic, Bedrock, etc.) to add richer checks
without modifying existing call sites.

## Usage sketch

```ts
import { createAuthManager, loadConfig } from "@composio/ao-core";

const config = loadConfig();
const auth = createAuthManager({ config });

const resolved = auth.resolveProfile("team-api");
const health = await auth.checkProfileHealth("team-api");
```
