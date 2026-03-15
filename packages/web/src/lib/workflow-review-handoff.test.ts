import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  taskLineageToYaml,
  type OrchestratorConfig,
  type ProjectConfig,
  type SCMWebhookEvent,
  type Session,
  type SessionManager,
  type Tracker,
} from "@composio/ao-core";
import { maybeAutoSpawnWorkflowReviewer } from "./workflow-review-handoff";

const tempDirs: string[] = [];

function makeSession(id: string, role: string): Session {
  return {
    id,
    projectId: "my-app",
    status: "spawning",
    activity: "active",
    branch: "feat/health-check",
    issueId: "101",
    pr: null,
    workspacePath: `/tmp/worktrees/${id}`,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: { role },
  };
}

function setupWorkflowReviewProject(): {
  config: OrchestratorConfig;
  project: ProjectConfig;
  event: SCMWebhookEvent;
} {
  const rootDir = mkdtempSync(join(tmpdir(), "ao-workflow-review-handoff-"));
  tempDirs.push(rootDir);

  mkdirSync(join(rootDir, "docs", "plans"), { recursive: true });
  writeFileSync(
    join(rootDir, "docs", "plans", "int-42.task-plan.yaml"),
    [
      "version: 1",
      "parentIssue: INT-42",
      "specPath: null",
      "adrPath: null",
      "childTasks:",
      "  - title: Review schema",
      "    summary: Review the implementation against the plan.",
      "    acceptanceCriteria:",
      "      - Validation succeeds for well-formed plans",
      "    dependencies: []",
      "    suggestedFiles: []",
      "    labels: []",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(rootDir, "docs", "plans", "int-42.lineage.yaml"),
    taskLineageToYaml({
      version: 1,
      projectId: "my-app",
      parentIssue: "INT-42",
      taskPlanPath: "docs/plans/int-42.task-plan.yaml",
      trackerPlugin: "github",
      createdAt: "2026-03-14T09:00:00.000Z",
      updatedAt: "2026-03-14T09:10:00.000Z",
      planningSession: null,
      childIssues: [
        {
          taskIndex: 0,
          title: "Review schema",
          issueId: "101",
          issueUrl: "https://github.com/acme/my-app/issues/101",
          issueLabel: "#101",
          labels: [],
          dependencies: [],
          state: "pr_opened",
          implementationSessions: [
            {
              sessionId: "backend-7",
              role: "implementer",
              branch: "feat/health-check",
              worktreePath: "/tmp/worktrees/backend-7",
              createdAt: "2026-03-14T09:05:00.000Z",
            },
          ],
          reviewSessions: [],
          pr: {
            number: 432,
            url: "https://github.com/acme/my-app/pull/432",
            branch: "feat/health-check",
            state: "open",
            updatedAt: "2026-03-14T09:10:00.000Z",
          },
        },
      ],
    }),
  );

  const project: ProjectConfig = {
    name: "My App",
    repo: "acme/my-app",
    path: rootDir,
    defaultBranch: "main",
    sessionPrefix: "my-app",
    workflow: "default",
  };
  const config: OrchestratorConfig = {
    configPath: join(rootDir, "agent-orchestrator.yaml"),
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: { "my-app": project },
    workflow: {
      default: {
        parentIssueRole: "planner",
        childIssueRole: "implementer",
        reviewRole: "reviewer",
        ciFixRole: "fixer",
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
  };
  const event: SCMWebhookEvent = {
    provider: "github",
    kind: "pull_request",
    action: "synchronize",
    rawEventType: "pull_request",
    deliveryId: "delivery-1",
    repository: { owner: "acme", name: "my-app" },
    prNumber: 432,
    branch: "feat/health-check",
    sha: "abc123",
    data: {},
  };

  return { config, project, event };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("maybeAutoSpawnWorkflowReviewer", () => {
  it("deduplicates repeated PR bursts using a filesystem-backed claim", async () => {
    const { config, project, event } = setupWorkflowReviewProject();
    const tracker = {
      issueUrl: vi.fn((issueId: string) => `https://github.com/acme/my-app/issues/${issueId}`),
    } as unknown as Tracker;
    const sessionManager = {
      spawn: vi.fn().mockResolvedValue(makeSession("reviewer-1", "reviewer")),
    } as unknown as SessionManager;

    const first = await maybeAutoSpawnWorkflowReviewer({
      config,
      projectId: "my-app",
      project,
      tracker,
      sessionManager,
      sessions: [],
      event,
    });
    const second = await maybeAutoSpawnWorkflowReviewer({
      config,
      projectId: "my-app",
      project,
      tracker,
      sessionManager,
      sessions: [],
      event,
    });

    expect(first?.spawnedSessionId).toBe("reviewer-1");
    expect(second).toEqual({
      skippedReason: "duplicate_delivery",
      childIssueId: "101",
      parentIssue: "INT-42",
    });
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
  });

  it("releases the persisted claim when spawn fails so a retry can succeed", async () => {
    const { config, project, event } = setupWorkflowReviewProject();
    const tracker = {
      issueUrl: vi.fn((issueId: string) => `https://github.com/acme/my-app/issues/${issueId}`),
    } as unknown as Tracker;
    const sessionManager = {
      spawn: vi
        .fn()
        .mockRejectedValueOnce(new Error("spawn failed"))
        .mockResolvedValueOnce(makeSession("reviewer-2", "reviewer")),
    } as unknown as SessionManager;

    let failure: unknown;
    try {
      await maybeAutoSpawnWorkflowReviewer({
        config,
        projectId: "my-app",
        project,
        tracker,
        sessionManager,
        sessions: [],
        event,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("spawn failed");

    const retry = await maybeAutoSpawnWorkflowReviewer({
      config,
      projectId: "my-app",
      project,
      tracker,
      sessionManager,
      sessions: [],
      event,
    });

    expect(retry?.spawnedSessionId).toBe("reviewer-2");
    expect(sessionManager.spawn).toHaveBeenCalledTimes(2);
  });

  it("uses a shared filesystem store when project-local state is not shared across web instances", async () => {
    const first = setupWorkflowReviewProject();
    const second = setupWorkflowReviewProject();
    const sharedStoreDir = mkdtempSync(join(tmpdir(), "ao-shared-review-store-"));
    tempDirs.push(sharedStoreDir);

    first.project.scm = {
      plugin: "github",
      webhook: {
        reviewerHandoffStore: {
          provider: "shared-filesystem",
          path: sharedStoreDir,
          keyPrefix: "prod-web",
        },
      },
    };
    second.project.scm = {
      plugin: "github",
      webhook: {
        reviewerHandoffStore: {
          provider: "shared-filesystem",
          path: sharedStoreDir,
          keyPrefix: "prod-web",
        },
      },
    };
    first.config.projects["my-app"] = first.project;
    second.config.projects["my-app"] = second.project;

    const tracker = {
      issueUrl: vi.fn((issueId: string) => `https://github.com/acme/my-app/issues/${issueId}`),
    } as unknown as Tracker;
    const firstSessionManager = {
      spawn: vi.fn().mockResolvedValue(makeSession("reviewer-3", "reviewer")),
    } as unknown as SessionManager;
    const secondSessionManager = {
      spawn: vi.fn().mockResolvedValue(makeSession("reviewer-4", "reviewer")),
    } as unknown as SessionManager;

    const initial = await maybeAutoSpawnWorkflowReviewer({
      config: first.config,
      projectId: "my-app",
      project: first.project,
      tracker,
      sessionManager: firstSessionManager,
      sessions: [],
      event: first.event,
    });

    const duplicate = await maybeAutoSpawnWorkflowReviewer({
      config: second.config,
      projectId: "my-app",
      project: second.project,
      tracker,
      sessionManager: secondSessionManager,
      sessions: [],
      event: second.event,
    });

    expect(initial?.spawnedSessionId).toBe("reviewer-3");
    expect(duplicate).toEqual({
      skippedReason: "duplicate_delivery",
      childIssueId: "101",
      parentIssue: "INT-42",
    });
    expect(firstSessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(secondSessionManager.spawn).not.toHaveBeenCalled();
  });
});
