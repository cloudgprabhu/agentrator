import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CI_STATUS,
  PR_STATE,
  createSessionManager,
  getProjectBaseDir,
  getSessionsDir,
  loadConfig,
  readMetadataRaw,
  taskPlanToYaml,
  type CICheck,
  type PRInfo,
  type Review,
  type ReviewComment,
  type SCM,
  type Tracker,
} from "@composio/ao-core";
import { readTaskLineageFile, writeTaskLineageFile } from "@composio/ao-core/task-lineage";
import { createMockRegistry } from "./helpers/fork-harness.js";

describe("fork workflow deterministic integration", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ao-fork-int-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("keeps legacy single-agent configs usable end-to-end", async () => {
    const repoPath = join(tmpDir, "legacy-repo");
    mkdirSync(repoPath, { recursive: true });

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          defaults: {
            runtime: "mock-runtime",
            agent: "mock-agent",
            workspace: "mock-workspace",
            notifiers: [],
          },
          projects: {
            "legacy-app": {
              repo: "acme/legacy-app",
              path: repoPath,
              defaultBranch: "main",
              sessionPrefix: "legacy",
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const config = loadConfig(configPath);
    const { registry } = createMockRegistry({
      workspaceRoot: join(tmpDir, "workspaces"),
    });
    const sessionManager = createSessionManager({ config, registry });

    const session = await sessionManager.spawn({ projectId: "legacy-app", issueId: "INT-100" });
    const listed = await sessionManager.list("legacy-app");
    const loaded = await sessionManager.get(session.id);
    const raw = readMetadataRaw(getSessionsDir(configPath, "legacy-app"), session.id);

    expect(listed.map((entry) => entry.id)).toContain(session.id);
    expect(loaded?.projectId).toBe("legacy-app");
    expect(loaded?.issueId).toBe("INT-100");
    expect(raw).toMatchObject({
      sessionId: session.id,
      projectId: "legacy-app",
      issueId: "INT-100",
      status: "spawning",
    });
    expect(raw?.["provider"]).toBeUndefined();
    expect(raw?.["authProfile"]).toBeUndefined();
  });

  it("keeps shared-repo logical projects isolated by canonical project key", async () => {
    const repoPath = join(tmpDir, "shared-repo");
    mkdirSync(repoPath, { recursive: true });

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          defaults: {
            runtime: "mock-runtime",
            agent: "mock-agent",
            workspace: "mock-workspace",
            notifiers: [],
          },
          projects: {
            planner: {
              repo: "acme/shared-repo",
              path: repoPath,
              defaultBranch: "main",
              sessionPrefix: "planner",
            },
            reviewer: {
              repo: "acme/shared-repo",
              path: repoPath,
              defaultBranch: "main",
              sessionPrefix: "reviewer",
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const config = loadConfig(configPath);
    const { registry } = createMockRegistry({
      workspaceRoot: join(tmpDir, "workspaces"),
    });
    const sessionManager = createSessionManager({ config, registry });

    const plannerSession = await sessionManager.spawn({ projectId: "planner", issueId: "PLAN-1" });
    const reviewerSession = await sessionManager.spawn({ projectId: "reviewer", issueId: "REV-1" });

    const plannerSessions = await sessionManager.list("planner");
    const reviewerSessions = await sessionManager.list("reviewer");
    const plannerDir = getProjectBaseDir(configPath, "planner");
    const reviewerDir = getProjectBaseDir(configPath, "reviewer");

    expect(plannerDir).not.toBe(reviewerDir);
    expect(readMetadataRaw(getSessionsDir(configPath, "planner"), plannerSession.id)?.["projectId"]).toBe(
      "planner",
    );
    expect(
      readMetadataRaw(getSessionsDir(configPath, "reviewer"), reviewerSession.id)?.["projectId"],
    ).toBe("reviewer");
    expect(plannerSessions.map((entry) => entry.id)).toEqual([plannerSession.id]);
    expect(reviewerSessions.map((entry) => entry.id)).toEqual([reviewerSession.id]);
  });

  it("updates workflow lineage across implementer spawn, PR claim, and reviewer spawn", async () => {
    const repoPath = join(tmpDir, "workflow-repo");
    const planDir = join(repoPath, "docs", "plans");
    mkdirSync(planDir, { recursive: true });

    const trackerProjectUrl = (issueId: string) => `https://tracker.example.local/issues/${issueId}`;
    const tracker: Tracker = {
      name: "fake-tracker",
      getIssue: async (identifier: string) => ({
        id: identifier,
        title: `Issue ${identifier}`,
        description: `Implement ${identifier}`,
        url: trackerProjectUrl(identifier),
        state: "open",
        labels: ["workflow"],
      }),
      isCompleted: async () => false,
      issueUrl: (identifier: string) => trackerProjectUrl(identifier),
      issueLabel: (url: string) => url.split("/").at(-1) ?? url,
      branchName: (identifier: string) => `feat/${identifier.toLowerCase()}`,
      generatePrompt: async (identifier: string) => `Implement ${identifier}`,
    };

    const prInfo: PRInfo = {
      number: 42,
      url: "https://github.com/acme/workflow-repo/pull/42",
      title: "Implement INT-100",
      owner: "acme",
      repo: "workflow-repo",
      branch: "feat/int-100",
      baseBranch: "main",
      isDraft: false,
    };

    const scm: SCM = {
      name: "fake-scm",
      detectPR: async () => null,
      resolvePR: async () => prInfo,
      assignPRToCurrentUser: async () => {},
      checkoutPR: async () => true,
      getPRState: async () => PR_STATE.OPEN,
      mergePR: async () => {},
      closePR: async () => {},
      getCIChecks: async (): Promise<CICheck[]> => [],
      getCISummary: async () => CI_STATUS.NONE,
      getReviews: async (): Promise<Review[]> => [],
      getReviewDecision: async () => "none",
      getPendingComments: async (): Promise<ReviewComment[]> => [],
      getAutomatedComments: async () => [],
      getMergeability: async () => ({
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: true,
        blockers: [],
      }),
    };

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          defaults: {
            runtime: "mock-runtime",
            agent: "mock-agent",
            workspace: "mock-workspace",
            notifiers: [],
          },
          modelProfiles: {
            implementerModel: { model: "gpt-4.1-mini", agent: "mock-agent" },
            reviewerModel: { model: "gpt-4.1-mini", agent: "mock-agent" },
          },
          roles: {
            implementer: { modelProfile: "implementerModel" },
            reviewer: { modelProfile: "reviewerModel" },
          },
          workflow: {
            default: {
              parentIssueRole: "implementer",
              childIssueRole: "implementer",
              reviewRole: "reviewer",
              ciFixRole: "reviewer",
            },
          },
          projects: {
            "workflow-app": {
              repo: "acme/workflow-repo",
              path: repoPath,
              defaultBranch: "main",
              sessionPrefix: "app",
              workflow: "default",
              tracker: { plugin: "fake-tracker" },
              scm: { plugin: "fake-scm" },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const config = loadConfig(configPath);
    const planPath = join(planDir, "int-42.task-plan.yaml");
    const lineagePath = join(planDir, "int-42.lineage.yaml");
    await writeFile(
      planPath,
      taskPlanToYaml({
        version: 1,
        parentIssue: "INT-42",
        specPath: "docs/specs/int-42.md",
        adrPath: null,
        childTasks: [
          {
            title: "Implement INT-100",
            summary: "Build the feature for INT-100",
            acceptanceCriteria: ["Code lands", "Tests pass"],
            dependencies: [],
            suggestedFiles: ["packages/core/src/session-manager.ts"],
            labels: ["workflow"],
          },
        ],
      }),
      "utf-8",
    );
    writeTaskLineageFile(lineagePath, {
      version: 1,
      projectId: "workflow-app",
      parentIssue: "INT-42",
      taskPlanPath: "docs/plans/int-42.task-plan.yaml",
      trackerPlugin: "fake-tracker",
      createdAt: "2026-01-01T00:00:00.000Z",
      planningSession: null,
      childIssues: [
        {
          taskIndex: 0,
          title: "Implement INT-100",
          issueId: "INT-100",
          issueUrl: trackerProjectUrl("INT-100"),
          issueLabel: "INT-100",
          labels: ["workflow"],
          dependencies: [],
          state: "queued",
          implementationSessions: [],
          reviewSessions: [],
          pr: null,
        },
      ],
    });

    const { registry } = createMockRegistry({
      workspaceRoot: join(tmpDir, "workspaces"),
      tracker,
      scm,
    });
    const sessionManager = createSessionManager({ config, registry });

    const implementer = await sessionManager.spawn({
      projectId: "workflow-app",
      issueId: "INT-100",
      role: "implementer",
    });

    let lineage = readTaskLineageFile(lineagePath);
    expect(lineage.childIssues[0]).toMatchObject({
      state: "in_progress",
      implementationSessions: [{ sessionId: implementer.id, role: "implementer" }],
    });

    const implementerMetadata = readMetadataRaw(
      getSessionsDir(configPath, "workflow-app"),
      implementer.id,
    );
    expect(implementerMetadata).toMatchObject({
      role: "implementer",
      projectId: "workflow-app",
      issueId: "INT-100",
      agent: "mock-agent",
      model: "gpt-4.1-mini",
    });

    await sessionManager.claimPR(implementer.id, "42");

    lineage = readTaskLineageFile(lineagePath);
    expect(lineage.childIssues[0]).toMatchObject({
      state: "pr_opened",
      pr: {
        number: 42,
        url: prInfo.url,
        branch: prInfo.branch,
        state: "open",
      },
    });

    await sessionManager.spawn({
      projectId: "workflow-app",
      issueId: "INT-100",
      role: "reviewer",
    });

    lineage = readTaskLineageFile(lineagePath);
    expect(lineage.childIssues[0]?.state).toBe("waiting_review");
    expect(lineage.childIssues[0]?.reviewSessions.map((entry) => entry.role)).toEqual(["reviewer"]);
    expect(readFileSync(planPath, "utf-8")).toContain("Build the feature for INT-100");
  });
});
