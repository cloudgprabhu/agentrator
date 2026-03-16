import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Issue, OrchestratorConfig, Session, SessionManager, Tracker } from "@composio/ao-core";

const { mockExec, mockSessionManager, mockRegistry } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockSessionManager: {
    list: vi.fn(),
    spawn: vi.fn(),
  },
  mockRegistry: {
    get: vi.fn(),
  },
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getPluginRegistry: async () => mockRegistry,
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as unknown as SessionManager,
}));

import { autoSpawnOpenIssues, spawnIssuesWithDedup } from "../../src/lib/auto-spawn.js";

function makeConfig(overrides: Record<string, unknown> = {}): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      app: {
        name: "App",
        repo: "org/app",
        path: "/tmp/app",
        defaultBranch: "main",
        sessionPrefix: "app",
        tracker: { plugin: "github" },
        ...overrides,
      },
    },
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as OrchestratorConfig;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "app",
    status: "working",
    activity: null,
    branch: "feat/1",
    issueId: "1",
    pr: null,
    workspacePath: "/tmp/worktrees/app-1",
    runtimeHandle: { id: "tmux-app-1", runtimeName: "tmux", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeIssue(id: string): Issue {
  return {
    id,
    title: `Issue ${id}`,
    description: "",
    url: `https://example.com/${id}`,
    state: "open",
    labels: [],
  };
}

beforeEach(() => {
  mockExec.mockReset();
  mockSessionManager.list.mockReset();
  mockSessionManager.spawn.mockReset();
  mockRegistry.get.mockReset();
});

describe("spawnIssuesWithDedup", () => {
  it("skips active duplicates, ignores terminal sessions, and de-dupes same-run issues", async () => {
    mockSessionManager.list.mockResolvedValue([
      makeSession({ id: "app-1", issueId: "1", status: "working" }),
      makeSession({ id: "app-2", issueId: "2", status: "merged" }),
    ]);
    mockSessionManager.spawn
      .mockResolvedValueOnce(makeSession({ id: "app-3", issueId: "2" }))
      .mockResolvedValueOnce(makeSession({ id: "app-4", issueId: "3" }));

    const summary = await spawnIssuesWithDedup({
      config: makeConfig(),
      projectId: "app",
      issues: ["1", "2", "2", "3"],
      delayMs: 0,
      sessionManager: mockSessionManager as unknown as SessionManager,
    });

    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(2);
    expect(mockSessionManager.spawn).toHaveBeenNthCalledWith(1, { projectId: "app", issueId: "2" });
    expect(mockSessionManager.spawn).toHaveBeenNthCalledWith(2, { projectId: "app", issueId: "3" });
    expect(summary.created).toEqual([
      { issue: "2", session: "app-3" },
      { issue: "3", session: "app-4" },
    ]);
    expect(summary.skipped).toEqual([
      { issue: "1", existing: "app-1" },
      { issue: "2", existing: "(this batch)" },
    ]);
  });

  it("opens tabs for created sessions when requested", async () => {
    mockSessionManager.list.mockResolvedValue([]);
    mockSessionManager.spawn.mockResolvedValue(
      makeSession({ id: "app-5", issueId: "5", runtimeHandle: { id: "tmux-app-5", runtimeName: "tmux", data: {} } }),
    );

    await spawnIssuesWithDedup({
      config: makeConfig(),
      projectId: "app",
      issues: ["5"],
      delayMs: 0,
      openTabs: true,
      sessionManager: mockSessionManager as unknown as SessionManager,
    });

    expect(mockExec).toHaveBeenCalledWith("open-iterm-tab", ["tmux-app-5"]);
  });
});

describe("autoSpawnOpenIssues", () => {
  it("spawns open tracker issues that do not already have active sessions", async () => {
    const tracker: Tracker = {
      name: "github",
      getIssue: vi.fn(),
      isCompleted: vi.fn(),
      issueUrl: vi.fn(),
      branchName: vi.fn(),
      generatePrompt: vi.fn(),
      listIssues: vi.fn().mockResolvedValue([makeIssue("10"), makeIssue("11")]),
    };
    mockRegistry.get.mockReturnValue(tracker);
    mockSessionManager.list.mockResolvedValue([makeSession({ id: "app-10", issueId: "10" })]);
    mockSessionManager.spawn.mockResolvedValue(makeSession({ id: "app-11", issueId: "11" }));

    const summary = await autoSpawnOpenIssues(makeConfig(), "app", {
      delayMs: 0,
      sessionManager: mockSessionManager as unknown as SessionManager,
    });

    expect(tracker.listIssues).toHaveBeenCalledWith(
      { state: "open", limit: 200 },
      expect.objectContaining({ name: "App" }),
    );
    expect(mockSessionManager.spawn).toHaveBeenCalledWith({ projectId: "app", issueId: "11" });
    expect(summary.openIssues).toEqual(["10", "11"]);
    expect(summary.created).toEqual([{ issue: "11", session: "app-11" }]);
    expect(summary.skipped).toEqual([{ issue: "10", existing: "app-10" }]);
  });

  it("fails when the tracker cannot list issues", async () => {
    const tracker: Tracker = {
      name: "github",
      getIssue: vi.fn(),
      isCompleted: vi.fn(),
      issueUrl: vi.fn(),
      branchName: vi.fn(),
      generatePrompt: vi.fn(),
    };
    mockRegistry.get.mockReturnValue(tracker);

    await expect(autoSpawnOpenIssues(makeConfig(), "app")).rejects.toThrow(
      'Tracker plugin "github" does not support listing issues.',
    );
  });
});
