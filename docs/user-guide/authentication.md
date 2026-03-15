# Authentication

This fork supports four auth profile types:

- `browser-account`
- `api-key`
- `aws-profile`
- `console`

Auth config should store references, not secrets.

## Browser login flow

Use browser auth when the provider is backed by a local CLI login flow.

OpenAI / Codex example:

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
    accountType: chatgpt-plus
```

Anthropic / Claude example:

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
    accountType: claude-pro
```

Check status and log in:

```bash
ao auth list
ao auth status
ao auth login codex-browser
ao auth login claude-browser
```

Notes:

- AO delegates browser login to the local provider CLI.
- `ao auth status` prints warnings when login is attempted from unsupported environments such as CI or a Linux session without a display.
- Session spawn now fails early if the resolved auth profile is invalid or unavailable.

## API/cloud auth flow

Use reference fields for API keys:

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

Use AWS profile auth for Bedrock:

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

- API-key profiles are treated as configured when `credentialEnvVar` or `credentialRef` is present.
- AWS profile auth checks static env credentials first, then AWS shared profile references.
- AO does not print secret values in CLI output.

## Common commands

```bash
ao auth list
ao auth status
ao auth login <profile>
ao auth logout <profile>
```

`ao auth status` is intended for humans. It prints the normalized auth state:

- `authenticated`
- `not_authenticated`
- `unavailable`
- `unsupported_environment`

## Using auth profiles with roles

Auth is normally selected through `modelProfiles`:

```yaml
modelProfiles:
  planner-model:
    provider: openai
    agent: codex
    authProfile: codex-browser
    model: o3
```

When a session spawns through a role, AO resolves the role, model profile, provider, and auth profile together. If that auth profile is not usable, the spawn is blocked before the runtime starts.

## Security rules

- Do not place `token`, `apiKey`, `secret`, or `password` values directly in YAML.
- Use `credentialEnvVar`, `credentialRef`, or provider-specific reference fields instead.
- Treat provider CLI output as untrusted; AO already sanitizes its auth messages, but your local environment still controls the login flow.
