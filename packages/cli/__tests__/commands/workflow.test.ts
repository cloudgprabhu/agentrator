import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type SessionManager, getProjectBaseDir } from "@composio/ao-core";
import { Command } from "commander";
import { readTaskLineageFile } from "../../../core/src/task-lineage.js";

const {
  mockConfigRef,
  mockSessionManager,
  mockEnsureLifecycleWorker,
  mockExec,
  mockRegistry,
  mockTracker,
  mockSCM,
} = vi.hoisted(() => ({
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    spawn: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    send: vi.fn(),
  },
  mockEnsureLifecycleWorker: vi.fn(),
  mockExec: vi.fn(),
  mockRegistry: {
    loadFromConfig: vi.fn(),
    get: vi.fn(),
  },
  mockTracker: {
    name: "github",
    createIssue: vi.fn(),
    isCompleted: vi.fn(),
    issueUrl: vi.fn(),
    issueLabel: vi.fn(),
    updateIssue: vi.fn(),
  },
  mockSCM: {
    name: "github",
    publishReview: vi.fn(),
    resolvePR: vi.fn(),
  },
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  const lineage = await import("../../../core/src/task-lineage.js");
  const taskPlan = await import("../../../core/src/task-plan.js");
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
    createPluginRegistry: () => mockRegistry,
    createTaskLineageSessionRef: lineage.createTaskLineageSessionRef,
    findTaskLineageByChildOrPRRef: lineage.findTaskLineageByChildOrPRRef,
    findTaskLineageByParentIssue: lineage.findTaskLineageByParentIssue,
    getAllowedTaskLineageChildStateTransitions: lineage.getAllowedTaskLineageChildStateTransitions,
    mergeTaskLineageChildIssues: lineage.mergeTaskLineageChildIssues,
    parseTaskLineageChildState: lineage.parseTaskLineageChildState,
    readTaskLineageFile: lineage.readTaskLineageFile,
    taskPlanToYaml: taskPlan.taskPlanToYaml,
    summarizeTaskLineageStates: lineage.summarizeTaskLineageStates,
    transitionTaskLineageChildState: lineage.transitionTaskLineageChildState,
    updateTaskLineageTaskPlanPath: lineage.updateTaskLineageTaskPlanPath,
    upsertTaskLineagePlanningSession: lineage.upsertTaskLineagePlanningSession,
  };
});

vi.mock("@composio/ao-core/task-plan", async () => {
  const { readTaskPlanFile } = await import("../../../core/src/task-plan.js");
  return { readTaskPlanFile };
});

vi.mock("@composio/ao-core/task-lineage", async () => {
  const { taskLineageToYaml, auditTaskLineageFile, updateTaskLineageTaskPlanPath } = await import(
    "../../../core/src/task-lineage.js"
  );
  return { taskLineageToYaml, auditTaskLineageFile, updateTaskLineageTaskPlanPath };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

vi.mock("../../src/lib/lifecycle-service.js", () => ({
  ensureLifecycleWorker: (...args: unknown[]) => mockEnsureLifecycleWorker(...args),
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

vi.mock("../../src/lib/preflight.js", () => ({
  preflight: {
    checkTmux: vi.fn().mockResolvedValue(undefined),
    checkGhAuth: vi.fn().mockResolvedValue(undefined),
  },
}));

import { registerWorkflow } from "../../src/commands/workflow.js";

let tmpDir: string;
let configPath: string;
let program: Command;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-workflow-test-"));
  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  const projectPath = join(tmpDir, "main-repo");
  mkdirSync(join(projectPath, "docs", "specs"), { recursive: true });
  writeFileSync(join(projectPath, "README.md"), "# Project\n");
  writeFileSync(join(projectPath, "docs", "specs", "planning.md"), "# Planning Spec\n");

  mockConfigRef.current = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    workflow: {
      default: {
        parentIssueRole: "planner",
        childIssueRole: "implementer",
        reviewRole: "reviewer",
        ciFixRole: "fixer",
      },
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: projectPath,
        defaultBranch: "main",
        sessionPrefix: "app",
        workflow: "default",
        tracker: { plugin: "github" },
        scm: { plugin: "github" },
      },
    },
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as Record<string, unknown>;

  program = new Command();
  program.exitOverride();
  registerWorkflow(program);

  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockSessionManager.spawn.mockReset();
  mockSessionManager.get.mockReset();
  mockSessionManager.list.mockReset();
  mockSessionManager.send.mockReset();
  mockEnsureLifecycleWorker.mockReset();
  mockExec.mockReset();
  mockRegistry.loadFromConfig.mockReset();
  mockRegistry.get.mockReset();
  mockTracker.createIssue.mockReset();
  mockTracker.isCompleted.mockReset();
  mockTracker.issueUrl.mockReset();
  mockTracker.issueLabel.mockReset();
  mockTracker.updateIssue.mockReset();
  mockSessionManager.get.mockResolvedValue({
    id: "app-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: "feat/INT-42",
    issueId: "INT-42",
    pr: null,
    workspacePath: "/tmp/worktrees/app-1",
    runtimeHandle: { id: "hash-app-1", runtimeName: "tmux", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
  });
  mockSessionManager.list.mockResolvedValue([]);
  mockTracker.isCompleted.mockResolvedValue(false);
  mockTracker.issueUrl.mockImplementation((issueId: string) => `https://tracker.test/issues/${issueId}`);
  mockTracker.issueLabel.mockImplementation((url: string) => {
    const issueId = url.split("/").pop() ?? "unknown";
    return `#${issueId}`;
  });
  mockSCM.publishReview.mockReset();
  mockSCM.resolvePR.mockReset();
  mockSCM.resolvePR.mockImplementation(async (reference: string) => ({
    number: reference.includes("/pull/") ? Number(reference.split("/").pop()) : 88,
    url: reference,
    title: "Review target",
    owner: "org",
    repo: "my-app",
    branch: "feat/101",
    baseBranch: "main",
    isDraft: false,
  }));
  mockRegistry.get.mockImplementation((slot: string) => {
    if (slot === "scm") return mockSCM;
    return mockTracker;
  });
});

afterEach(() => {
  const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "main-repo"));
  if (projectBaseDir) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("workflow command", () => {
  it("spawns the configured planner role with planning context and artifact target", async () => {
    mockSessionManager.spawn.mockImplementation(async () => {
      const planPath = join(tmpDir, "main-repo", "docs", "plans", "int-42.task-plan.yaml");
      mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
      writeFileSync(
        planPath,
        [
          "version: 1",
          "parentIssue: INT-42",
          "specPath: docs/specs/planning.md",
          "adrPath: null",
          "childTasks:",
          "  - title: Define schema",
          "    summary: Add a validator.",
          "    acceptanceCriteria:",
          "      - Validation succeeds for well-formed plans",
          "    dependencies: []",
          "    suggestedFiles:",
          "      - packages/core/src/task-plan.ts",
          "    labels:",
          "      - workflow",
          "",
        ].join("\n"),
      );

      return {
        id: "app-1",
        projectId: "my-app",
        status: "spawning",
        activity: null,
        branch: "feat/INT-42",
        issueId: "INT-42",
        pr: null,
        workspacePath: "/tmp/worktrees/app-1",
        runtimeHandle: { id: "hash-app-1", runtimeName: "tmux", data: {} },
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      };
    });

    await program.parseAsync(["node", "test", "workflow", "plan", "my-app", "INT-42"]);

    expect(mockEnsureLifecycleWorker).toHaveBeenCalledWith(
      expect.objectContaining({ configPath: expect.any(String) }),
      "my-app",
    );
    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "INT-42",
      role: "planner",
      prompt: expect.stringContaining("Parent issue: INT-42"),
    });

    const spawnCall = mockSessionManager.spawn.mock.calls[0]?.[0];
    expect(spawnCall?.prompt).toContain("Workflow role: planner");
    expect(spawnCall?.prompt).toContain("docs/plans/int-42.task-plan.yaml");
    expect(spawnCall?.prompt).toContain("version: 1");
    expect(spawnCall?.prompt).toContain("specPath:");
    expect(spawnCall?.prompt).toContain("childTasks:");
    expect(spawnCall?.prompt).toContain("README.md");
    expect(spawnCall?.prompt).toContain("docs/specs/planning.md");

    const lineage = readTaskLineageFile(join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml"));
    expect(lineage.parentIssue).toBe("INT-42");
    expect(lineage.planningSession?.sessionId).toBe("app-1");
  });

  it("supports overriding the artifact path", async () => {
    mockSessionManager.spawn.mockResolvedValue({
      id: "app-1",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/INT-42",
      issueId: "INT-42",
      pr: null,
      workspacePath: "/tmp/worktrees/app-1",
      runtimeHandle: { id: "hash-app-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    });

    await program.parseAsync([
      "node",
      "test",
      "workflow",
      "plan",
      "my-app",
      "INT-42",
      "--artifact",
      "plans/custom-plan.md",
      "--no-verify-artifact",
    ]);

    const spawnCall = mockSessionManager.spawn.mock.calls[0]?.[0];
    expect(spawnCall?.prompt).toContain("plans/custom-plan.md");
  });

  it("fails workflow planning when the planner exits without producing a valid task-plan artifact", async () => {
    mockSessionManager.spawn.mockResolvedValue({
      id: "app-1",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/INT-42",
      issueId: "INT-42",
      pr: null,
      workspacePath: "/tmp/worktrees/app-1",
      runtimeHandle: { id: "hash-app-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    });
    mockSessionManager.get.mockResolvedValue({
      id: "app-1",
      projectId: "my-app",
      status: "killed",
      activity: "exited",
      branch: "feat/INT-42",
      issueId: "INT-42",
      pr: null,
      workspacePath: "/tmp/worktrees/app-1",
      runtimeHandle: { id: "hash-app-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    });

    await expect(
      program.parseAsync(["node", "test", "workflow", "plan", "my-app", "INT-42"]),
    ).rejects.toThrow("process.exit(1)");

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("ended before producing a valid task plan"),
    );
  });

  it("fails workflow planning when the generated artifact is invalid for the requested parent issue", async () => {
    mockSessionManager.spawn.mockImplementation(async () => {
      const planPath = join(tmpDir, "main-repo", "docs", "plans", "int-42.task-plan.yaml");
      mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
      writeFileSync(
        planPath,
        [
          "version: 1",
          "parentIssue: INT-99",
          "specPath: null",
          "adrPath: null",
          "childTasks:",
          "  - title: Wrong issue",
          "    summary: This should fail validation.",
          "    acceptanceCriteria:",
          "      - Parent issue must match",
          "    dependencies: []",
          "    suggestedFiles: []",
          "    labels: []",
          "",
        ].join("\n"),
      );

      return {
        id: "app-1",
        projectId: "my-app",
        status: "spawning",
        activity: null,
        branch: "feat/INT-42",
        issueId: "INT-42",
        pr: null,
        workspacePath: "/tmp/worktrees/app-1",
        runtimeHandle: { id: "hash-app-1", runtimeName: "tmux", data: {} },
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      };
    });
    mockSessionManager.get.mockResolvedValue({
      id: "app-1",
      projectId: "my-app",
      status: "killed",
      activity: "exited",
      branch: "feat/INT-42",
      issueId: "INT-42",
      pr: null,
      workspacePath: "/tmp/worktrees/app-1",
      runtimeHandle: { id: "hash-app-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    });

    await expect(
      program.parseAsync(["node", "test", "workflow", "plan", "my-app", "INT-42"]),
    ).rejects.toThrow("process.exit(1)");

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("parentIssue must be INT-42"));
  });

  it("validates a well-formed task-plan file", async () => {
    const planPath = join(tmpDir, "docs", "plans", "int-42.task-plan.yaml");
    mkdirSync(join(tmpDir, "docs", "plans"), { recursive: true });
    writeFileSync(
      planPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: docs/specs/planning.md",
        "adrPath: null",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add a validator.",
        "    acceptanceCriteria:",
        "      - Validation succeeds for well-formed plans",
        "    dependencies: []",
        "    suggestedFiles:",
        "      - packages/core/src/task-plan.ts",
        "    labels:",
        "      - workflow",
        "",
      ].join("\n"),
    );

    await program.parseAsync(["node", "test", "workflow", "validate-plan", planPath]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`Valid task plan: ${planPath}`));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Parent issue:"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Child tasks:"));
  });

  it("fails validation for malformed task-plan files", async () => {
    const planPath = join(tmpDir, "invalid.task-plan.yaml");
    writeFileSync(
      planPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: null",
        "adrPath: null",
        "childTasks:",
        "  - title: Missing fields",
        "    summary: This should fail",
        "",
      ].join("\n"),
    );

    await expect(
      program.parseAsync(["node", "test", "workflow", "validate-plan", planPath]),
    ).rejects.toThrow("process.exit(1)");

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid task plan"));
  });

  it("creates child issues from a task-plan file and writes a lineage artifact", async () => {
    const planPath = join(tmpDir, "docs", "plans", "int-42.task-plan.yaml");
    const lineagePath = join(tmpDir, "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "docs", "plans"), { recursive: true });
    writeFileSync(
      planPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: docs/specs/planning.md",
        "adrPath: docs/adr/0001-planning.md",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add a validator.",
        "    acceptanceCriteria:",
        "      - Validation succeeds for well-formed plans",
        "    dependencies: []",
        "    suggestedFiles:",
        "      - packages/core/src/task-plan.ts",
        "    labels:",
        "      - workflow",
        "  - title: Add CLI validation",
        "    summary: Expose the validator in the CLI.",
        "    acceptanceCriteria:",
        "      - CLI exits zero for valid plans",
        "    dependencies:",
        "      - Define schema",
        "    suggestedFiles:",
        "      - packages/cli/src/commands/workflow.ts",
        "    labels:",
        "      - cli",
        "",
      ].join("\n"),
    );

    mockTracker.createIssue
      .mockResolvedValueOnce({
        id: "101",
        title: "Define schema",
        description: "",
        url: "https://tracker.test/issues/101",
        state: "open",
        labels: ["workflow"],
      })
      .mockResolvedValueOnce({
        id: "102",
        title: "Add CLI validation",
        description: "",
        url: "https://tracker.test/issues/102",
        state: "open",
        labels: ["cli"],
      });

    await program.parseAsync([
      "node",
      "test",
      "workflow",
      "create-issues",
      "my-app",
      planPath,
      "--lineage",
      lineagePath,
    ]);

    expect(mockRegistry.loadFromConfig).toHaveBeenCalled();
    expect(mockTracker.createIssue).toHaveBeenCalledTimes(2);
    expect(mockTracker.createIssue).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: "Define schema",
        parentIssueId: "INT-42",
        labels: ["workflow"],
        description: expect.stringContaining("## Parent Issue"),
      }),
      expect.objectContaining({ tracker: { plugin: "github" } }),
    );
    expect(mockTracker.createIssue).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        title: "Add CLI validation",
        parentIssueId: "INT-42",
        labels: ["cli"],
        description: expect.stringContaining("## Dependencies"),
      }),
      expect.objectContaining({ tracker: { plugin: "github" } }),
    );

    const firstDescription = mockTracker.createIssue.mock.calls[0]?.[0]?.description as string;
    expect(firstDescription).toContain("ID: INT-42");
    expect(firstDescription).toContain("docs/specs/planning.md");
    expect(firstDescription).toContain("docs/adr/0001-planning.md");
    expect(firstDescription).toContain("Validation succeeds for well-formed plans");

    const lineage = readTaskLineageFile(lineagePath);
    expect(lineage.parentIssue).toBe("INT-42");
    expect(lineage.taskPlanPath).toBe(planPath);
    expect(lineage.childIssues).toEqual([
      {
        taskIndex: 0,
        title: "Define schema",
        issueId: "101",
        issueUrl: "https://tracker.test/issues/101",
        issueLabel: "#101",
        labels: ["workflow"],
        dependencies: [],
        state: "queued",
        implementationSessions: [],
        reviewSessions: [],
        pr: null,
      },
      {
        taskIndex: 1,
        title: "Add CLI validation",
        issueId: "102",
        issueUrl: "https://tracker.test/issues/102",
        issueLabel: "#102",
        labels: ["cli"],
        dependencies: ["Define schema"],
        state: "queued",
        implementationSessions: [],
        reviewSessions: [],
        pr: null,
      },
    ]);
  });

  it("shows lineage for a parent issue", async () => {
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        "taskPlanPath: docs/plans/int-42.task-plan.yaml",
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "updatedAt: 2026-03-14T10:00:00.000Z",
        "planningSession:",
        "  sessionId: planner-1",
        "  role: planner",
        "  branch: feat/int-42-plan",
        "  worktreePath: /tmp/worktrees/planner-1",
        "  createdAt: 2026-03-14T09:00:00.000Z",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: [workflow]",
        "    dependencies: []",
        "    state: waiting_review",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );

    await program.parseAsync(["node", "test", "workflow", "lineage", "my-app", "INT-42"]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Workflow lineage for INT-42"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("planner-1"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("#101"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("waiting_review=1"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[waiting_review]"));
  });

  it("audits lineage drift and exits non-zero when unrepaired issues remain", async () => {
    const plansDir = join(tmpDir, "main-repo", "docs", "plans");
    const lineagePath = join(plansDir, "int-42.lineage.yaml");
    const taskPlanPath = join(plansDir, "int-42.task-plan.yaml");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      taskPlanPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: null",
        "adrPath: null",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add validator",
        "    acceptanceCriteria:",
        "      - Validator exists",
        "    dependencies: []",
        "    suggestedFiles: []",
        "    labels: []",
        "  - title: Add CLI",
        "    summary: Add command",
        "    acceptanceCriteria:",
        "      - Command works",
        "    dependencies: []",
        "    suggestedFiles: []",
        "    labels: []",
        "",
      ].join("\n"),
    );
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-99",
        "taskPlanPath: docs/plans/int-42.task-plan.yaml",
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: []",
        "    dependencies: []",
        "    state: queued",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );

    await expect(
      program.parseAsync([
        "node",
        "test",
        "workflow",
        "audit-lineage",
        "my-app",
        "--lineage",
        "docs/plans/int-42.lineage.yaml",
      ]),
    ).rejects.toThrow("process.exit(1)");

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Workflow lineage audit for my-app"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("parent_issue_drift"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("missing_child_refs"));
  });

  it("repairs safe lineage issues in place when requested", async () => {
    const plansDir = join(tmpDir, "main-repo", "docs", "plans");
    const lineagePath = join(plansDir, "int-42.lineage.yaml");
    const fixedPlanPath = join(plansDir, "int-42-fixed.task-plan.yaml");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      fixedPlanPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: null",
        "adrPath: null",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add validator",
        "    acceptanceCriteria:",
        "      - Validator exists",
        "    dependencies: []",
        "    suggestedFiles: []",
        "    labels: []",
        "",
      ].join("\n"),
    );
    writeFileSync(
      lineagePath,
      [
        "parentIssue: INT-99",
        "taskPlanPath: docs/plans/stale.task-plan.yaml",
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: []",
        "    dependencies: []",
        "    state: waiting-review",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );

    await program.parseAsync([
      "node",
      "test",
      "workflow",
      "audit-lineage",
      "my-app",
      "--lineage",
      "docs/plans/int-42.lineage.yaml",
      "--task-plan",
      "docs/plans/int-42-fixed.task-plan.yaml",
      "--repair",
    ]);

    const repaired = readTaskLineageFile(lineagePath);
    expect(repaired.parentIssue).toBe("INT-42");
    expect(repaired.taskPlanPath).toBe("docs/plans/int-42-fixed.task-plan.yaml");
    expect(repaired.childIssues[0]?.state).toBe("waiting_review");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("applied safe fixes"));
  });

  it("starts implementation sessions for eligible child issues", async () => {
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        "taskPlanPath: docs/plans/int-42.task-plan.yaml",
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: [workflow]",
        "    dependencies: []",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "  - taskIndex: 1",
        "    title: Add CLI validation",
        "    issueId: '102'",
        "    issueUrl: https://tracker.test/issues/102",
        "    issueLabel: '#102'",
        "    labels: [cli]",
        "    dependencies: []",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );

    mockSessionManager.spawn
      .mockResolvedValueOnce({
        id: "app-201",
        projectId: "my-app",
        status: "spawning",
        activity: null,
        branch: "feat/101",
        issueId: "101",
        pr: null,
        workspacePath: "/tmp/worktrees/app-201",
        runtimeHandle: { id: "hash-app-201", runtimeName: "tmux", data: {} },
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      })
      .mockResolvedValueOnce({
        id: "app-202",
        projectId: "my-app",
        status: "spawning",
        activity: null,
        branch: "feat/102",
        issueId: "102",
        pr: null,
        workspacePath: "/tmp/worktrees/app-202",
        runtimeHandle: { id: "hash-app-202", runtimeName: "tmux", data: {} },
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      });

    await program.parseAsync(["node", "test", "workflow", "implement", "my-app", "INT-42"]);

    expect(mockSessionManager.list).toHaveBeenCalledWith("my-app");
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(2);
    expect(mockSessionManager.spawn).toHaveBeenNthCalledWith(1, {
      projectId: "my-app",
      issueId: "101",
      role: "implementer",
    });
    expect(mockSessionManager.spawn).toHaveBeenNthCalledWith(2, {
      projectId: "my-app",
      issueId: "102",
      role: "implementer",
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Workflow implementation for INT-42"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("#101"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("#102"));
    expect(readTaskLineageFile(lineagePath).childIssues.map((child) => child.state)).toEqual([
      "queued",
      "queued",
    ]);
  });

  it("honors concurrency and skips child issues already in progress or completed", async () => {
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        "taskPlanPath: docs/plans/int-42.task-plan.yaml",
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: [workflow]",
        "    dependencies: []",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "  - taskIndex: 1",
        "    title: Add CLI validation",
        "    issueId: '102'",
        "    issueUrl: https://tracker.test/issues/102",
        "    issueLabel: '#102'",
        "    labels: [cli]",
        "    dependencies: []",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "  - taskIndex: 2",
        "    title: Add docs",
        "    issueId: '103'",
        "    issueUrl: https://tracker.test/issues/103",
        "    issueLabel: '#103'",
        "    labels: [docs]",
        "    dependencies: []",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "  - taskIndex: 3",
        "    title: Add metrics",
        "    issueId: '104'",
        "    issueUrl: https://tracker.test/issues/104",
        "    issueLabel: '#104'",
        "    labels: [ops]",
        "    dependencies: []",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );

    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-101",
        projectId: "my-app",
        status: "working",
        activity: "active",
        branch: "feat/101",
        issueId: "101",
        pr: null,
        workspacePath: "/tmp/worktrees/app-101",
        runtimeHandle: { id: "hash-app-101", runtimeName: "tmux", data: {} },
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: { role: "implementer" },
      },
    ]);

    mockTracker.isCompleted.mockImplementation(async (issueId: string) => issueId === "102");
    mockSessionManager.spawn.mockResolvedValue({
      id: "app-103",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/103",
      issueId: "103",
      pr: null,
      workspacePath: "/tmp/worktrees/app-103",
      runtimeHandle: { id: "hash-app-103", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    });

    await program.parseAsync([
      "node",
      "test",
      "workflow",
      "implement",
      "my-app",
      "INT-42",
      "--concurrency",
      "2",
    ]);

    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "103",
      role: "implementer",
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("#101"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already in progress"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("#102"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already completed"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("#104"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("concurrency limit reached"));
    expect(readTaskLineageFile(lineagePath).childIssues[1]?.state).toBe("done");
  });

  it("spawns the configured review role with structured child issue context from a PR ref", async () => {
    const planPath = join(tmpDir, "main-repo", "docs", "plans", "int-42.task-plan.yaml");
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      planPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: docs/specs/planning.md",
        "adrPath: docs/adr/0001-planning.md",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add a validator.",
        "    acceptanceCriteria:",
        "      - Validation succeeds for well-formed plans",
        "    dependencies: []",
        "    suggestedFiles:",
        "      - packages/core/src/task-plan.ts",
        "    labels:",
        "      - workflow",
        "",
      ].join("\n"),
    );
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        `taskPlanPath: ${planPath}`,
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: [workflow]",
        "    dependencies: []",
        "    state: pr_opened",
        "    implementationSessions:",
        "      - sessionId: app-101",
        "        role: implementer",
        "        branch: feat/101",
        "        worktreePath: /tmp/worktrees/app-101",
        "        createdAt: 2026-03-14T10:00:00.000Z",
        "    reviewSessions: []",
        "    pr:",
        "      number: 88",
        "      url: https://tracker.test/pulls/88",
        "      branch: feat/101",
        "      state: open",
        "      updatedAt: 2026-03-14T10:10:00.000Z",
        "",
      ].join("\n"),
    );

    mockSessionManager.spawn.mockResolvedValue({
      id: "review-201",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/101",
      issueId: "101",
      pr: null,
      workspacePath: "/tmp/worktrees/review-201",
      runtimeHandle: { id: "hash-review-201", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    });

    await program.parseAsync([
      "node",
      "test",
      "workflow",
      "review",
      "my-app",
      "https://tracker.test/pulls/88",
    ]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "101",
      role: "reviewer",
      prompt: expect.stringContaining("## Workflow Review"),
    });
    const spawnCall = mockSessionManager.spawn.mock.calls.at(-1)?.[0];
    expect(spawnCall?.prompt).toContain("Match source: pr");
    expect(spawnCall?.prompt).toContain("Parent issue: INT-42");
    expect(spawnCall?.prompt).toContain("Child issue: #101 (101)");
    expect(spawnCall?.prompt).toContain("Current lineage state: pr_opened");
    expect(spawnCall?.prompt).toContain("https://tracker.test/pulls/88");
    expect(spawnCall?.prompt).toContain("docs/specs/planning.md");
    expect(spawnCall?.prompt).toContain("docs/adr/0001-planning.md");
    expect(spawnCall?.prompt).toContain("Validation succeeds for well-formed plans");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Child:"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("PR:"));
    expect(logSpy).toHaveBeenCalledWith("SESSION=review-201");
  });

  it("resolves workflow review targets from a child issue ref", async () => {
    const planPath = join(tmpDir, "main-repo", "docs", "plans", "int-42.task-plan.yaml");
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      planPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: null",
        "adrPath: null",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add a validator.",
        "    acceptanceCriteria:",
        "      - Validation succeeds for well-formed plans",
        "    dependencies: []",
        "    suggestedFiles: []",
        "    labels: []",
        "",
      ].join("\n"),
    );
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        `taskPlanPath: ${planPath}`,
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: []",
        "    dependencies: []",
        "    state: changes_requested",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );

    mockSessionManager.spawn.mockResolvedValue({
      id: "review-202",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/101",
      issueId: "101",
      pr: null,
      workspacePath: "/tmp/worktrees/review-202",
      runtimeHandle: { id: "hash-review-202", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    });

    await program.parseAsync(["node", "test", "workflow", "review", "my-app", "#101"]);

    const spawnCall = mockSessionManager.spawn.mock.calls.at(-1)?.[0];
    expect(spawnCall?.issueId).toBe("101");
    expect(spawnCall?.role).toBe("reviewer");
    expect(spawnCall?.prompt).toContain("Match source: issue");
    expect(spawnCall?.prompt).toContain("Current lineage state: changes_requested");
  });

  it("resolves a moved task-plan file automatically for workflow review when there is one valid match", async () => {
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    const movedPlanPath = join(tmpDir, "main-repo", "docs", "archive", "int-42-moved.task-plan.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    mkdirSync(join(tmpDir, "main-repo", "docs", "archive"), { recursive: true });
    writeFileSync(
      movedPlanPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: docs/specs/planning.md",
        "adrPath: null",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Review the relocated task plan content.",
        "    acceptanceCriteria:",
        "      - Review uses the moved plan",
        "    dependencies: []",
        "    suggestedFiles: []",
        "    labels: []",
        "",
      ].join("\n"),
    );
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        "taskPlanPath: docs/plans/int-42.task-plan.yaml",
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: []",
        "    dependencies: []",
        "    state: pr_opened",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr:",
        "      number: 88",
        "      url: https://github.com/acme/repo/pull/88",
        "      branch: feat/int-101",
        "      state: open",
        "      updatedAt: 2026-03-14T09:30:00.000Z",
        "",
      ].join("\n"),
    );
    mockSessionManager.spawn.mockResolvedValue({
      id: "review-1",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/int-101",
      issueId: "101",
      pr: null,
      workspacePath: "/tmp/worktrees/review-1",
      runtimeHandle: { id: "hash-review-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    });

    await program.parseAsync(["node", "test", "workflow", "review", "my-app", "#101"]);

    const spawnCall = mockSessionManager.spawn.mock.calls.at(-1)?.[0];
    expect(spawnCall?.prompt).toContain("Review the relocated task plan content.");
    expect(spawnCall?.prompt).toContain("docs/archive/int-42-moved.task-plan.yaml (resolved after move)");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("docs/archive/int-42-moved.task-plan.yaml"));
  });

  it("records an approve outcome on the child issue and updates lineage state", async () => {
    const planPath = join(tmpDir, "main-repo", "docs", "plans", "int-42.task-plan.yaml");
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      planPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: null",
        "adrPath: null",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add a validator.",
        "    acceptanceCriteria:",
        "      - Validation succeeds",
        "    dependencies: []",
        "    suggestedFiles: []",
        "    labels: []",
        "",
      ].join("\n"),
    );
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        `taskPlanPath: ${planPath}`,
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: []",
        "    dependencies: []",
        "    state: waiting_review",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );

    await program.parseAsync([
      "node",
      "test",
      "workflow",
      "review-outcome",
      "my-app",
      "#101",
      "--outcome",
      "approve",
      "--summary",
      "Acceptance criteria satisfied and the change is ready to close.",
    ]);

    expect(mockTracker.updateIssue).toHaveBeenCalledWith(
      "101",
      expect.objectContaining({
        comment: expect.stringContaining("Outcome: approve"),
      }),
      expect.objectContaining({ tracker: { plugin: "github" } }),
    );
    expect(readTaskLineageFile(lineagePath).childIssues[0]?.state).toBe("approved");
  });

  it("publishes an SCM-native approve review when the child issue has a PR", async () => {
    const planPath = join(tmpDir, "main-repo", "docs", "plans", "int-42.task-plan.yaml");
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      planPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: null",
        "adrPath: null",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add a validator.",
        "    acceptanceCriteria:",
        "      - Validation succeeds",
        "    dependencies: []",
        "    suggestedFiles: []",
        "    labels: []",
        "",
      ].join("\n"),
    );
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        `taskPlanPath: ${planPath}`,
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: []",
        "    dependencies: []",
        "    state: waiting_review",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr:",
        "      number: 88",
        "      url: https://github.test/org/my-app/pull/88",
        "      branch: feat/101",
        "      state: open",
        "      updatedAt: 2026-03-14T10:10:00.000Z",
        "",
      ].join("\n"),
    );

    await program.parseAsync([
      "node",
      "test",
      "workflow",
      "review-outcome",
      "my-app",
      "#101",
      "--outcome",
      "approve",
      "--summary",
      "Acceptance criteria satisfied and the PR is ready to merge.",
    ]);

    expect(mockSCM.publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        number: 88,
        url: "https://github.test/org/my-app/pull/88",
      }),
      {
        outcome: "approve",
        summary: "Acceptance criteria satisfied and the PR is ready to merge.",
      },
    );
    expect(mockSCM.resolvePR).toHaveBeenCalledWith(
      "https://github.test/org/my-app/pull/88",
      expect.objectContaining({ scm: { plugin: "github" } }),
    );
    expect(mockTracker.updateIssue).not.toHaveBeenCalled();
    expect(readTaskLineageFile(lineagePath).childIssues[0]?.state).toBe("approved");
  });

  it("routes requested changes back to an active implementer session", async () => {
    const planPath = join(tmpDir, "main-repo", "docs", "plans", "int-42.task-plan.yaml");
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      planPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: null",
        "adrPath: null",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add a validator.",
        "    acceptanceCriteria:",
        "      - Validation succeeds",
        "    dependencies: []",
        "    suggestedFiles: []",
        "    labels: []",
        "",
      ].join("\n"),
    );
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        `taskPlanPath: ${planPath}`,
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: []",
        "    dependencies: []",
        "    state: waiting_review",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr:",
        "      number: 88",
        "      url: https://tracker.test/pulls/88",
        "      branch: feat/101",
        "      state: open",
        "      updatedAt: 2026-03-14T10:10:00.000Z",
        "",
      ].join("\n"),
    );
    mockSessionManager.list.mockResolvedValue([
      {
        id: "impl-101",
        projectId: "my-app",
        status: "working",
        activity: "active",
        branch: "feat/101",
        issueId: "101",
        pr: null,
        workspacePath: "/tmp/worktrees/impl-101",
        runtimeHandle: { id: "hash-impl-101", runtimeName: "tmux", data: {} },
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: { role: "implementer" },
      },
    ]);

    await program.parseAsync([
      "node",
      "test",
      "workflow",
      "review-outcome",
      "my-app",
      "https://tracker.test/pulls/88",
      "--outcome",
      "request_changes",
      "--summary",
      "Add regression coverage for the empty-config case.",
    ]);

    expect(mockSCM.publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        number: 88,
        url: "https://tracker.test/pulls/88",
      }),
      {
        outcome: "request_changes",
        summary: "Add regression coverage for the empty-config case.",
      },
    );
    expect(mockTracker.updateIssue).not.toHaveBeenCalled();
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "impl-101",
      expect.stringContaining("Requested Changes"),
    );
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    expect(readTaskLineageFile(lineagePath).childIssues[0]?.state).toBe("changes_requested");
  });

  it("spawns an implementer when requested changes arrive without an active session", async () => {
    const planPath = join(tmpDir, "main-repo", "docs", "plans", "int-42.task-plan.yaml");
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      planPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: null",
        "adrPath: null",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add a validator.",
        "    acceptanceCriteria:",
        "      - Validation succeeds",
        "    dependencies: []",
        "    suggestedFiles: []",
        "    labels: []",
        "",
      ].join("\n"),
    );
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        `taskPlanPath: ${planPath}`,
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: []",
        "    dependencies: []",
        "    state: waiting_review",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );
    mockSessionManager.spawn.mockResolvedValue({
      id: "impl-102",
      projectId: "my-app",
      status: "spawning",
      activity: null,
      branch: "feat/101",
      issueId: "101",
      pr: null,
      workspacePath: "/tmp/worktrees/impl-102",
      runtimeHandle: { id: "hash-impl-102", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    });

    await program.parseAsync([
      "node",
      "test",
      "workflow",
      "review-outcome",
      "my-app",
      "#101",
      "--outcome",
      "request_changes",
      "--summary",
      "Add the missing modelProfile validation test.",
    ]);

    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "101",
      role: "implementer",
      prompt: expect.stringContaining("Requested Changes"),
    });
    expect(readTaskLineageFile(lineagePath).childIssues[0]?.state).toBe("changes_requested");
  });

  it("creates a follow-up child task, issue, and lineage entry", async () => {
    const planPath = join(tmpDir, "main-repo", "docs", "plans", "int-42.task-plan.yaml");
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      planPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: docs/specs/planning.md",
        "adrPath: null",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add a validator.",
        "    acceptanceCriteria:",
        "      - Validation succeeds",
        "    dependencies: []",
        "    suggestedFiles:",
        "      - packages/core/src/task-plan.ts",
        "    labels:",
        "      - workflow",
        "",
      ].join("\n"),
    );
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        `taskPlanPath: ${planPath}`,
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: [workflow]",
        "    dependencies: []",
        "    state: waiting_review",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );
    mockTracker.createIssue.mockResolvedValue({
      id: "103",
      title: "Add migration docs",
      description: "",
      url: "https://tracker.test/issues/103",
      state: "open",
      labels: ["workflow", "follow-up"],
    });

    await program.parseAsync([
      "node",
      "test",
      "workflow",
      "review-outcome",
      "my-app",
      "#101",
      "--outcome",
      "create_follow_up",
      "--summary",
      "Document the migration sequence for downstream operators.",
      "--follow-up-title",
      "Add migration docs",
    ]);

    expect(mockTracker.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Add migration docs",
        parentIssueId: "INT-42",
        description: expect.stringContaining("Follow-up from review of #101"),
        labels: expect.arrayContaining(["workflow", "follow-up"]),
      }),
      expect.objectContaining({ tracker: { plugin: "github" } }),
    );
    expect(mockTracker.updateIssue).toHaveBeenCalledWith(
      "101",
      expect.objectContaining({
        comment: expect.stringContaining("Created follow-up child issue: #103"),
      }),
      expect.objectContaining({ tracker: { plugin: "github" } }),
    );
    const updatedPlan = readFileSync(planPath, "utf-8");
    expect(updatedPlan).toContain("title: Add migration docs");
    expect(updatedPlan).toContain("Document the migration sequence for downstream operators.");
    const lineage = readTaskLineageFile(lineagePath);
    expect(lineage.childIssues[0]?.state).toBe("blocked");
    expect(lineage.childIssues[1]).toEqual(
      expect.objectContaining({
        issueId: "103",
        issueLabel: "#103",
        title: "Add migration docs",
        state: "queued",
      }),
    );
  });

  it("posts parent summary updates to the parent issue without changing child state", async () => {
    const planPath = join(tmpDir, "main-repo", "docs", "plans", "int-42.task-plan.yaml");
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      planPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: null",
        "adrPath: null",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add a validator.",
        "    acceptanceCriteria:",
        "      - Validation succeeds",
        "    dependencies: []",
        "    suggestedFiles: []",
        "    labels: []",
        "",
      ].join("\n"),
    );
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        `taskPlanPath: ${planPath}`,
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: []",
        "    dependencies: []",
        "    state: waiting_review",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );

    await program.parseAsync([
      "node",
      "test",
      "workflow",
      "review-outcome",
      "my-app",
      "#101",
      "--outcome",
      "update_parent_summary",
      "--summary",
      "Reviewer confirms the schema work is complete and the remaining risk is in rollout docs.",
    ]);

    expect(mockTracker.updateIssue).toHaveBeenCalledWith(
      "INT-42",
      expect.objectContaining({
        comment: expect.stringContaining("Workflow Parent Summary Update"),
      }),
      expect.objectContaining({ tracker: { plugin: "github" } }),
    );
    expect(readTaskLineageFile(lineagePath).childIssues[0]?.state).toBe("waiting_review");
  });

  it("manually moves a workflow child issue into blocked and the lineage view reflects it", async () => {
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        "taskPlanPath: docs/plans/int-42.task-plan.yaml",
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: []",
        "    dependencies: []",
        "    state: in_progress",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );

    await program.parseAsync(["node", "test", "workflow", "set-state", "my-app", "#101", "blocked"]);

    expect(readTaskLineageFile(lineagePath).childIssues[0]?.state).toBe("blocked");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("in_progress -> blocked"));

    await program.parseAsync(["node", "test", "workflow", "lineage", "my-app", "INT-42"]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[blocked]"));
  });

  it("relocates a moved task-plan path into lineage explicitly", async () => {
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    const movedPlanPath = join(tmpDir, "main-repo", "docs", "archive", "int-42.task-plan.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    mkdirSync(join(tmpDir, "main-repo", "docs", "archive"), { recursive: true });
    writeFileSync(
      movedPlanPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: null",
        "adrPath: null",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add a validator.",
        "    acceptanceCriteria:",
        "      - Validation succeeds",
        "    dependencies: []",
        "    suggestedFiles: []",
        "    labels: []",
        "",
      ].join("\n"),
    );
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        "taskPlanPath: docs/plans/int-42.task-plan.yaml",
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: []",
        "    dependencies: []",
        "    state: queued",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );

    await program.parseAsync([
      "node",
      "test",
      "workflow",
      "relocate-task-plan",
      "my-app",
      "INT-42",
      "docs/archive/int-42.task-plan.yaml",
    ]);

    expect(readTaskLineageFile(lineagePath).taskPlanPath).toBe("docs/archive/int-42.task-plan.yaml");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("docs/plans/int-42.task-plan.yaml -> docs/archive/int-42.task-plan.yaml"),
    );
  });

  it("manually moves a blocked workflow child issue back to in_progress", async () => {
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        "taskPlanPath: docs/plans/int-42.task-plan.yaml",
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: []",
        "    dependencies: []",
        "    state: blocked",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );

    await program.parseAsync([
      "node",
      "test",
      "workflow",
      "set-state",
      "my-app",
      "#101",
      "in_progress",
    ]);

    expect(readTaskLineageFile(lineagePath).childIssues[0]?.state).toBe("in_progress");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("blocked -> in_progress"));
  });

  it("rejects invalid manual workflow state transitions with allowed targets", async () => {
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        "taskPlanPath: docs/plans/int-42.task-plan.yaml",
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues:",
        "  - taskIndex: 0",
        "    title: Define schema",
        "    issueId: '101'",
        "    issueUrl: https://tracker.test/issues/101",
        "    issueLabel: '#101'",
        "    labels: []",
        "    dependencies: []",
        "    state: waiting_review",
        "    implementationSessions: []",
        "    reviewSessions: []",
        "    pr: null",
        "",
      ].join("\n"),
    );

    await expect(
      program.parseAsync(["node", "test", "workflow", "set-state", "my-app", "#101", "queued"]),
    ).rejects.toThrow("process.exit(1)");

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Cannot move #101 from waiting_review to queued. Allowed: blocked, changes_requested, approved, done",
      ),
    );
  });

  it("fails when the tracker plugin does not support issue creation", async () => {
    const planPath = join(tmpDir, "int-42.task-plan.yaml");
    writeFileSync(
      planPath,
      [
        "version: 1",
        "parentIssue: INT-42",
        "specPath: null",
        "adrPath: null",
        "childTasks:",
        "  - title: Define schema",
        "    summary: Add a validator.",
        "    acceptanceCriteria:",
        "      - Validation succeeds",
        "    dependencies: []",
        "    suggestedFiles: []",
        "    labels: []",
        "",
      ].join("\n"),
    );

    mockRegistry.get.mockReturnValue({
      name: "github",
      issueUrl: mockTracker.issueUrl,
    });

    await expect(
      program.parseAsync(["node", "test", "workflow", "create-issues", "my-app", planPath]),
    ).rejects.toThrow("process.exit(1)");

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('does not support issue creation'),
    );
  });

  it("fails when concurrency is not a positive integer", async () => {
    const lineagePath = join(tmpDir, "main-repo", "docs", "plans", "int-42.lineage.yaml");
    mkdirSync(join(tmpDir, "main-repo", "docs", "plans"), { recursive: true });
    writeFileSync(
      lineagePath,
      [
        "version: 1",
        "projectId: my-app",
        "parentIssue: INT-42",
        "taskPlanPath: docs/plans/int-42.task-plan.yaml",
        "trackerPlugin: github",
        "createdAt: 2026-03-14T09:00:00.000Z",
        "planningSession: null",
        "childIssues: []",
        "",
      ].join("\n"),
    );

    await expect(
      program.parseAsync([
        "node",
        "test",
        "workflow",
        "implement",
        "my-app",
        "INT-42",
        "--concurrency",
        "0",
      ]),
    ).rejects.toThrow("process.exit(1)");

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("--concurrency must be a positive integer"),
    );
  });

  it("fails when the project is missing workflow.parentIssueRole", async () => {
    mockConfigRef.current = {
      ...mockConfigRef.current,
      projects: {
        "my-app": {
          ...(mockConfigRef.current as Record<string, any>).projects["my-app"],
        },
      },
      workflow: {},
    } as Record<string, unknown>;

    await expect(
      program.parseAsync(["node", "test", "workflow", "plan", "my-app", "INT-42"]),
    ).rejects.toThrow("process.exit(1)");

    expect(errSpy).toHaveBeenCalled();
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });
});
