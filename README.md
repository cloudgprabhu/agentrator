<h1 align="center">Agent Orchestrator — The Orchestration Layer for Parallel AI Agents</h1>

<p align="center">
<a href="https://platform.composio.dev/?utm_source=Github&utm_medium=Banner&utm_content=AgentOrchestrator">
  <img width="800" alt="Agent Orchestrator banner" src="docs/assets/agent_orchestrator_banner.png">
</a>
</p>

<div align="center">

Spawn parallel AI coding agents, each in its own git worktree. Agents autonomously fix CI failures, address review comments, and open PRs — you supervise from one dashboard.

[![GitHub stars](https://img.shields.io/github/stars/ComposioHQ/agent-orchestrator?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![PRs merged](https://img.shields.io/badge/PRs_merged-61-brightgreen?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/pulls?q=is%3Amerged)
[![Tests](https://img.shields.io/badge/test_cases-3%2C288-blue?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/releases/tag/metrics-v1)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/P9BytfBj)

</div>

---

Agent Orchestrator manages fleets of AI coding agents working in parallel on your codebase. Each agent gets its own git worktree, its own branch, and its own PR. When CI fails, the agent fixes it. When reviewers leave comments, the agent addresses them. You only get pulled in when human judgment is needed.

**Agent-agnostic** (Claude Code, Codex, Aider) · **Runtime-agnostic** (tmux, Docker) · **Tracker-agnostic** (GitHub, Linear)

<div align="center">

## See it in action

<a href="https://x.com/agent_wrapper/status/2026329204405723180">
  <img src="docs/assets/demo-video-tweet.png" alt="Agent Orchestrator demo — AI agents building their own orchestrator" width="560">
</a>
<br><br>
<a href="https://x.com/agent_wrapper/status/2026329204405723180"><img src="docs/assets/btn-watch-demo.png" alt="Watch the Demo on X" height="48"></a>
<br><br><br>
<a href="https://x.com/agent_wrapper/status/2025986105485733945">
  <img src="docs/assets/article-tweet.png" alt="The Self-Improving AI System That Built Itself" width="560">
</a>
<br><br>
<a href="https://x.com/agent_wrapper/status/2025986105485733945"><img src="docs/assets/btn-read-article.png" alt="Read the Full Article on X" height="48"></a>

</div>

## Quick Start

**Option A — From a repo URL (fastest):**

```bash
# Install
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator && bash scripts/setup.sh

# One command to clone, configure, and launch
ao start https://github.com/your-org/your-repo
```

Auto-detects language, package manager, SCM platform, and default branch. Generates `agent-orchestrator.yaml` and starts the dashboard + orchestrator.

**Option B — From an existing local repo:**

```bash
cd ~/your-project && ao init --auto
ao start
```

Then spawn agents:

```bash
ao spawn my-project 123    # GitHub issue, Linear ticket, or ad-hoc
ao spawn --role planner my-project 123
ao spawn-role my-project planner 123
```

Dashboard opens at `http://localhost:3000`. Run `ao status` for the CLI view.

## How It Works

```
ao spawn my-project 123
```

1. **Workspace** creates an isolated git worktree with a feature branch
2. **Runtime** starts a tmux session (or Docker container)
3. **Agent** launches Claude Code (or Codex, or Aider) with issue context
4. Agent works autonomously — reads code, writes tests, creates PR
5. **Reactions** auto-handle CI failures and review comments
6. **Notifier** pings you only when judgment is needed

### Plugin Architecture

Eight slots. Every abstraction is swappable.

| Slot      | Default     | Alternatives             |
| --------- | ----------- | ------------------------ |
| Runtime   | tmux        | docker, k8s, process     |
| Agent     | claude-code | codex, aider, opencode   |
| Workspace | worktree    | clone                    |
| Tracker   | github      | linear                   |
| SCM       | github      | —                        |
| Notifier  | desktop     | slack, composio, webhook |
| Terminal  | iterm2      | web                      |
| Lifecycle | core        | —                        |

All interfaces defined in [`packages/core/src/types.ts`](packages/core/src/types.ts). A plugin implements one interface and exports a `PluginModule`. That's it.

## Configuration

```yaml
# agent-orchestrator.yaml
port: 3000

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects:
  my-app:
    repo: owner/my-app
    path: ~/my-app
    defaultBranch: main
    sessionPrefix: app

reactions:
  ci-failed:
    auto: true
    action: send-to-agent
    retries: 2
  changes-requested:
    auto: true
    action: send-to-agent
    escalateAfter: 30m
  approved-and-green:
    auto: false # flip to true for auto-merge
    action: notify
```

CI fails → agent gets the logs and fixes it. Reviewer requests changes → agent addresses them. PR approved with green CI → you get a notification to merge.

See [`agent-orchestrator.yaml.example`](agent-orchestrator.yaml.example) for the full reference.

Project IDs come from the keys under `projects:`, not from the repo path basename. That means
configs like `projects: { planner: { path: ~/shared-repo }, implementer: { path: ~/shared-repo } }`
create two distinct logical projects with separate session state, worktrees, and dashboard routing
even though they point at the same checkout path.

## CLI

```bash
ao status                              # Overview of all sessions
ao status --verbose                    # Include role/model/auth/workflow metadata
ao spawn <project> [issue]             # Spawn an agent
ao spawn --role <role> <project> [issue]
ao spawn-role <project> <role> [issue] # Spawn with explicit role resolution
ao workflow plan <project> <issue>     # Spawn the planner and verify a valid task-plan artifact
ao workflow validate-plan <file>       # Validate a YAML task-plan artifact
ao workflow create-issues <project> <file> # Create child tracker issues from a task plan
ao workflow implement <project> <issue>    # Spawn implementer sessions for eligible child issues
ao workflow review <project> <ref>         # Spawn reviewer session for a child issue or PR
ao workflow review-outcome <project> <ref> # Record reviewer outcome and route follow-up work
ao workflow set-state <project> <ref> <state> # Manually move a workflow child issue between valid states
ao workflow relocate-task-plan <project> <issue> <path> # Persist a moved task-plan path into lineage
ao workflow lineage <project> <issue>  # Show workflow lineage for a parent issue
ao workflow audit-lineage <project> [issue]  # Audit or repair workflow lineage artifacts
ao auth list                           # List configured auth profiles
ao auth status                         # Check auth state for each profile
ao auth status --json                  # Emit machine-readable auth status for scripts and dashboards
ao auth status --live                  # Run opt-in live validation where supported
ao auth login <profile>                # Run provider-specific login flow
ao auth logout <profile>               # Run provider-specific logout flow
ao send <session> "Fix the tests"      # Send instructions
ao session ls                          # List sessions
ao session kill <session>              # Kill a session
ao session restore <session>           # Revive a crashed agent
ao dashboard                           # Open web dashboard
```

When both `--role` and `--agent` are provided, `--agent` takes precedence for agent plugin
selection, while provider/auth/model/runtime settings still resolve from the selected role.

Workflow child issue creation always preserves cross-platform linkage in lineage artifacts and issue
bodies. Trackers that support native issue hierarchy can also attach child issues to the parent
issue directly; the current repo implements that natively for Linear.

Auth commands only show profile names, types, providers, and reference presence. They do not print
inline secrets, tokens, or credential values.

Verbose status output adds resolved session metadata such as `projectId`, `role`, `agent`,
`provider`, `model`, `authProfile`, `authMode`, `issueId`, and workflow lineage context when the
issue participates in a task-plan lineage.

Example:

```text
My App
  Session       Branch                  PR    CI    Rev   Thr Activity Age
  ──────────────────────────────────────────────────────────────────────────
  app-7         feat/status-metadata    #88   pass  ok    0   ready    2m
                project=my-app  role=reviewer  agent=codex  provider=openai  model=gpt-5-codex  authProfile=openai-browser  authMode=browser-account  issueId=INT-42-1  workflow=waiting_review  relation=child of INT-42
```

## Why Agent Orchestrator?

Running one AI agent in a terminal is easy. Running 30 across different issues, branches, and PRs is a coordination problem.

**Without orchestration**, you manually: create branches, start agents, check if they're stuck, read CI failures, forward review comments, track which PRs are ready to merge, clean up when done.

**With Agent Orchestrator**, you: `ao spawn` and walk away. The system handles isolation, feedback routing, and status tracking. You review PRs and make decisions — the rest is automated.

## Prerequisites

- Node.js 20+
- Git 2.25+
- tmux (for default runtime)
- `gh` CLI (for GitHub integration)

## Development

```bash
pnpm install && pnpm build    # Install and build all packages
pnpm test                      # Run tests (3,288 test cases)
pnpm dev                       # Start web dashboard dev server
```

See [CLAUDE.md](CLAUDE.md) for code conventions and architecture details.

## Documentation

| Doc                                   | What it covers                                               |
| ------------------------------------- | ------------------------------------------------------------ |
| [Setup Guide](SETUP.md)               | Detailed installation and configuration                      |
| [Examples](examples/)                 | Config templates (GitHub, Linear, multi-project, auto-merge) |
| [CLAUDE.md](CLAUDE.md)                | Architecture, conventions, plugin pattern                    |
| [Troubleshooting](TROUBLESHOOTING.md) | Common issues and fixes                                      |
| [Workflow Planning](docs/workflow-planning.md) | Planner-session workflow and plan artifact usage            |
| [Task Plan Format](docs/task-plan-format.md) | Canonical YAML schema for planner output                    |
| [Workflow Lineage](docs/workflow-lineage.md) | Parent/child/session/PR lineage model and query surface     |
| [Completion Backlog](docs/completion-backlog.md) | Ordered implementation backlog for remaining open project work |
| [Test Strategy](docs/testing/test-strategy.md) | Fork-wide test pyramid, ownership, fixtures, and CI recommendations |
| [Unit Test Cases](docs/testing/unit-test-cases.md) | Detailed unit-level case catalog for fork-specific behavior |
| [Integration Test Cases](docs/testing/integration-test-cases.md) | End-to-end and multi-module scenario catalog for the fork   |
| [Manual Smoke Tests](docs/testing/manual-smoke-tests.md) | Operator checklist for local end-to-end verification on real setups |

## Contributing

Contributions welcome. The plugin system makes it straightforward to add support for new agents, runtimes, trackers, and notification channels. Every plugin is an implementation of a TypeScript interface — see [CLAUDE.md](CLAUDE.md) for the pattern.

## License

MIT
