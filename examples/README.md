# Agent Orchestrator Config Examples

This directory now includes both the older upstream-style examples and fork-specific examples for provider/auth/role/workflow setups.

## Quick Start

Copy an example and customize:

```bash
cp examples/local-browser-dual.yaml agent-orchestrator.yaml
ao auth status
ao start my-app
ao status --verbose
```

## Fork-specific examples

### [local-browser-dual.yaml](./local-browser-dual.yaml)

Short note: local personal setup with both Claude browser auth and Codex browser auth.

Use this if:

- you want local interactive login only
- planner/reviewer and implementer roles should switch providers
- you do not want API keys in the config file

### [mixed-local-api.yaml](./mixed-local-api.yaml)

Short note: mixed browser-auth plus API-key setup.

Use this if:

- planning or review should run with a local browser-auth account
- implementation should use a stable API-key-backed model
- you want role-based separation between local and automated credentials

### [team-api-cloud.yaml](./team-api-cloud.yaml)

Short note: team-oriented setup using API-key and cloud auth only.

Use this if:

- browser login is not appropriate for your environment
- your team runs on env-managed credentials or shared AWS profiles
- you want Linear tracking and Slack notifications in the same example

### [shared-repo-multi-project.yaml](./shared-repo-multi-project.yaml)

Short note: multiple logical AO projects sharing the same repository path.

Use this if:

- planner, implementer, and reviewer need distinct AO project IDs
- several logical projects point at one repo path
- you want to test canonical project identity instead of path-derived identity

## Existing examples

### [simple-github.yaml](./simple-github.yaml)

Short note: minimal legacy-compatible single-project GitHub setup.

### [linear-team.yaml](./linear-team.yaml)

Short note: lightweight Linear-only example without the full fork workflow schema.

### [multi-project.yaml](./multi-project.yaml)

Short note: multiple repositories with different trackers and notification routing.

### [auto-merge.yaml](./auto-merge.yaml)

Short note: aggressive automation example centered on reactions and merge handling.

### [codex-integration.yaml](./codex-integration.yaml)

Short note: older example focused on selecting Codex as the agent plugin.

## Common environment variables

```bash
export OPENAI_API_KEY="..."
export ANTHROPIC_API_KEY="..."
export LINEAR_API_KEY="..."
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
```

## Next Steps

After copying an example:

1. Update repo paths, session prefixes, and tracker settings.
2. Run `ao auth status` to confirm the selected auth profiles are usable.
3. Run `ao start <project>` or `ao workflow plan <project> <issue>`.
4. Use `ao status --verbose` to confirm the resolved role, model, provider, and auth profile.
