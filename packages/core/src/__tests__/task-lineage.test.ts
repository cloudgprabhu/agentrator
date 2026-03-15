import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  TASK_LINEAGE_VERSION,
  auditTaskLineageFile,
  canTransitionTaskLineageChildState,
  createTaskLineageSessionRef,
  findTaskLineageByChildOrPRRef,
  findTaskLineageByChildIssue,
  findTaskLineageByPREvent,
  findTaskLineageByParentIssue,
  findTaskLineageBySession,
  getAllowedTaskLineageChildStateTransitions,
  mergeTaskLineageChildIssues,
  parseTaskLineage,
  parseTaskLineageChildState,
  recordTaskLineageChildSession,
  recordTaskLineagePR,
  readTaskLineageFile,
  summarizeTaskLineageStates,
  taskLineageToYaml,
  transitionTaskLineageChildState,
  updateTaskLineageTaskPlanPath,
  upsertTaskLineagePlanningSession,
  validateTaskLineage,
} from "../task-lineage.js";

describe("task lineage validation", () => {
  it("validates and normalizes a lineage artifact", () => {
    const lineage = validateTaskLineage({
      version: TASK_LINEAGE_VERSION,
      parentIssue: "  INT-42 ",
      taskPlanPath: " docs/plans/int-42.task-plan.yaml ",
      trackerPlugin: " github ",
      createdAt: "2026-03-13T12:00:00.000Z",
      childIssues: [
        {
          taskIndex: 0,
          title: " Define schema ",
          issueId: " 123 ",
          issueUrl: " https://github.com/acme/repo/issues/123 ",
          issueLabel: " #123 ",
          labels: [" workflow "],
          dependencies: [],
          state: "queued",
          implementationSessions: [],
          reviewSessions: [],
          pr: null,
        },
      ],
    });

    expect(lineage).toEqual({
      version: TASK_LINEAGE_VERSION,
      parentIssue: "INT-42",
      taskPlanPath: "docs/plans/int-42.task-plan.yaml",
      trackerPlugin: "github",
      createdAt: "2026-03-13T12:00:00.000Z",
      planningSession: null,
      childIssues: [
        {
          taskIndex: 0,
          title: "Define schema",
          issueId: "123",
          issueUrl: "https://github.com/acme/repo/issues/123",
          issueLabel: "#123",
          labels: ["workflow"],
          dependencies: [],
          state: "queued",
          implementationSessions: [],
          reviewSessions: [],
          pr: null,
        },
      ],
    });
  });

  it("rejects malformed lineage entries with source context", () => {
    expect(() =>
      validateTaskLineage(
        {
          version: TASK_LINEAGE_VERSION,
          parentIssue: "INT-42",
          taskPlanPath: "docs/plans/int-42.task-plan.yaml",
          trackerPlugin: "github",
          createdAt: "2026-03-13T12:00:00.000Z",
          childIssues: [
            {
              taskIndex: 0,
              title: "Define schema",
              issueId: "123",
              issueUrl: "https://github.com/acme/repo/issues/123",
              labels: [],
              dependencies: [],
              implementationSessions: [],
              reviewSessions: [],
              pr: null,
            },
          ],
        },
        "docs/plans/int-42.lineage.yaml",
      ),
    ).toThrow(
      "Invalid task lineage in docs/plans/int-42.lineage.yaml: childIssues[0].issueLabel: Required",
    );
  });

  it("rejects invalid yaml content with source context", () => {
    expect(() =>
      parseTaskLineage("version: 1\nparentIssue: INT-42\nchildIssues:\n  - title: bad: yaml", "lineage.yaml"),
    ).toThrow("Failed to parse task lineage YAML in lineage.yaml");
  });

  it("reads and validates a lineage file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-task-lineage-"));
    const filePath = join(dir, "int-42.lineage.yaml");

    try {
      writeFileSync(
        filePath,
        taskLineageToYaml({
          version: TASK_LINEAGE_VERSION,
          parentIssue: "INT-42",
          taskPlanPath: "docs/plans/int-42.task-plan.yaml",
          trackerPlugin: "github",
          createdAt: "2026-03-13T12:00:00.000Z",
          planningSession: null,
          childIssues: [
            {
              taskIndex: 0,
              title: "Implement validator",
              issueId: "123",
              issueUrl: "https://github.com/acme/repo/issues/123",
              issueLabel: "#123",
              labels: ["workflow"],
              dependencies: [],
              state: "queued",
              implementationSessions: [],
              reviewSessions: [],
              pr: null,
            },
          ],
        }),
      );

      expect(readTaskLineageFile(filePath)).toEqual({
        version: TASK_LINEAGE_VERSION,
        parentIssue: "INT-42",
        taskPlanPath: "docs/plans/int-42.task-plan.yaml",
        trackerPlugin: "github",
        createdAt: "2026-03-13T12:00:00.000Z",
        planningSession: null,
        childIssues: [
          {
            taskIndex: 0,
            title: "Implement validator",
            issueId: "123",
            issueUrl: "https://github.com/acme/repo/issues/123",
              issueLabel: "#123",
              labels: ["workflow"],
              dependencies: [],
              state: "queued",
              implementationSessions: [],
              reviewSessions: [],
              pr: null,
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates planning, child-session, and pr lineage relationships", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-task-lineage-store-"));
    const projectPath = join(dir, "project");
    const filePath = join(projectPath, "docs", "plans", "int-42.lineage.yaml");

    try {
      upsertTaskLineagePlanningSession(
        filePath,
        {
          projectId: "my-app",
          parentIssue: "INT-42",
          taskPlanPath: "docs/plans/int-42.task-plan.yaml",
          trackerPlugin: "github",
          createdAt: "2026-03-14T09:00:00.000Z",
        },
        createTaskLineageSessionRef(
          {
            id: "planner-1",
            branch: "feat/int-42-plan",
            workspacePath: "/tmp/worktrees/planner-1",
            createdAt: new Date("2026-03-14T09:00:00.000Z"),
          },
          "planner",
        ),
      );

      mergeTaskLineageChildIssues(
        filePath,
        {
          projectId: "my-app",
          parentIssue: "INT-42",
          taskPlanPath: "docs/plans/int-42.task-plan.yaml",
          trackerPlugin: "github",
        },
        [
          {
            taskIndex: 0,
            title: "Define schema",
            issueId: "101",
            issueUrl: "https://github.com/acme/repo/issues/101",
            issueLabel: "#101",
            labels: ["workflow"],
            dependencies: [],
            state: "queued",
            implementationSessions: [],
            reviewSessions: [],
            pr: null,
          },
        ],
      );

      recordTaskLineageChildSession(
        projectPath,
        "101",
        "implementation",
        createTaskLineageSessionRef(
          {
            id: "impl-1",
            branch: "feat/issue-101",
            workspacePath: "/tmp/worktrees/impl-1",
            createdAt: new Date("2026-03-14T10:00:00.000Z"),
          },
          "implementer",
        ),
      );
      recordTaskLineageChildSession(
        projectPath,
        "101",
        "review",
        createTaskLineageSessionRef(
          {
            id: "review-1",
            branch: "feat/issue-101",
            workspacePath: "/tmp/worktrees/review-1",
            createdAt: new Date("2026-03-14T11:00:00.000Z"),
          },
          "reviewer",
        ),
      );
      recordTaskLineagePR(projectPath, "impl-1", {
        number: 88,
        url: "https://github.com/acme/repo/pull/88",
        branch: "feat/issue-101",
        state: "open",
      });

      const lineage = readTaskLineageFile(filePath);
      expect(lineage.projectId).toBe("my-app");
      expect(lineage.planningSession?.sessionId).toBe("planner-1");
      expect(lineage.childIssues[0]?.state).toBe("waiting_review");
      expect(lineage.childIssues[0]?.implementationSessions[0]?.sessionId).toBe("impl-1");
      expect(lineage.childIssues[0]?.reviewSessions[0]?.sessionId).toBe("review-1");
      expect(lineage.childIssues[0]?.pr).toMatchObject({
        number: 88,
        url: "https://github.com/acme/repo/pull/88",
      });
      expect(summarizeTaskLineageStates(lineage)).toEqual({
        queued: 0,
        in_progress: 0,
        blocked: 0,
        pr_opened: 0,
        waiting_review: 1,
        changes_requested: 0,
        approved: 0,
        done: 0,
      });
      expect(findTaskLineageByParentIssue(projectPath, "INT-42")?.filePath).toBe(filePath);
      expect(findTaskLineageByChildIssue(projectPath, "101")?.childIndex).toBe(0);
      expect(findTaskLineageByChildOrPRRef(projectPath, "#101")?.matchedBy).toBe("issue");
      expect(findTaskLineageByChildOrPRRef(projectPath, "88")?.matchedBy).toBe("pr");
      expect(findTaskLineageByPREvent(projectPath, { prNumber: 88 })?.matchedBy).toBe("pr");
      expect(findTaskLineageByPREvent(projectPath, { branch: "feat/issue-101" })?.matchedBy).toBe(
        "pr",
      );
      expect(findTaskLineageBySession(projectPath, "impl-1")?.childIndex).toBe(0);
      expect(findTaskLineageBySession(projectPath, "planner-1")?.childIndex).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports explicit child issue state transitions and validates transition rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-task-lineage-state-"));
    const projectPath = join(dir, "project");
    const filePath = join(projectPath, "docs", "plans", "int-42.lineage.yaml");

    try {
      mergeTaskLineageChildIssues(
        filePath,
        {
          projectId: "my-app",
          parentIssue: "INT-42",
          taskPlanPath: "docs/plans/int-42.task-plan.yaml",
          trackerPlugin: "github",
          createdAt: "2026-03-14T09:00:00.000Z",
        },
        [
          {
            taskIndex: 0,
            title: "Define schema",
            issueId: "101",
            issueUrl: "https://github.com/acme/repo/issues/101",
            issueLabel: "#101",
            labels: ["workflow"],
            dependencies: [],
            state: "queued",
            implementationSessions: [],
            reviewSessions: [],
            pr: null,
          },
        ],
      );

      expect(getAllowedTaskLineageChildStateTransitions("queued")).toContain("in_progress");
      expect(canTransitionTaskLineageChildState("approved", "done")).toBe(true);
      expect(canTransitionTaskLineageChildState("done", "in_progress")).toBe(false);
      expect(parseTaskLineageChildState("APPROVED")).toBe("approved");

      transitionTaskLineageChildState(projectPath, "101", "blocked");
      transitionTaskLineageChildState(projectPath, "101", "in_progress");
      transitionTaskLineageChildState(projectPath, "101", "approved");
      transitionTaskLineageChildState(projectPath, "101", "done");

      expect(readTaskLineageFile(filePath).childIssues[0]?.state).toBe("done");
      expect(() => transitionTaskLineageChildState(projectPath, "101", "in_progress")).toThrow(
        "Invalid task lineage child state transition: done -> in_progress",
      );
      expect(() => parseTaskLineageChildState("unknown")).toThrow(
        "Unknown task lineage child state: unknown",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates the stored task-plan path for an existing lineage artifact", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-task-lineage-repoint-"));
    const projectPath = join(dir, "project");
    const filePath = join(projectPath, "docs", "plans", "int-42.lineage.yaml");

    try {
      mergeTaskLineageChildIssues(
        filePath,
        {
          projectId: "my-app",
          parentIssue: "INT-42",
          taskPlanPath: "docs/plans/int-42.task-plan.yaml",
          trackerPlugin: "github",
          createdAt: "2026-03-14T09:00:00.000Z",
        },
        [
          {
            taskIndex: 0,
            title: "Define schema",
            issueId: "101",
            issueUrl: "https://github.com/acme/repo/issues/101",
            issueLabel: "#101",
            labels: ["workflow"],
            dependencies: [],
            state: "queued",
            implementationSessions: [],
            reviewSessions: [],
            pr: null,
          },
        ],
      );

      const updated = updateTaskLineageTaskPlanPath(
        projectPath,
        "INT-42",
        "docs/archive/int-42.task-plan.yaml",
      );

      expect(updated?.taskPlanPath).toBe("docs/archive/int-42.task-plan.yaml");
      expect(readTaskLineageFile(filePath).taskPlanPath).toBe("docs/archive/int-42.task-plan.yaml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects lineage overwrites when the base parent/task-plan reference drifts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-task-lineage-mismatch-"));
    const filePath = join(dir, "project", "docs", "plans", "int-42.lineage.yaml");

    try {
      upsertTaskLineagePlanningSession(
        filePath,
        {
          projectId: "my-app",
          parentIssue: "INT-42",
          taskPlanPath: "docs/plans/int-42.task-plan.yaml",
          trackerPlugin: "github",
          createdAt: "2026-03-14T09:00:00.000Z",
        },
        {
          sessionId: "planner-1",
          role: "planner",
          branch: "feat/int-42-plan",
          worktreePath: "/tmp/planner-1",
          createdAt: "2026-03-14T09:00:00.000Z",
        },
      );

      expect(() =>
        mergeTaskLineageChildIssues(
          filePath,
          {
            projectId: "my-app",
            parentIssue: "INT-99",
            taskPlanPath: "docs/plans/int-42.task-plan.yaml",
            trackerPlugin: "github",
          },
          [],
        ),
      ).toThrow("existing parentIssue 'INT-42' does not match 'INT-99'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects lineage merges that would drop existing child issue references", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-task-lineage-child-refs-"));
    const filePath = join(dir, "project", "docs", "plans", "int-42.lineage.yaml");

    try {
      mergeTaskLineageChildIssues(
        filePath,
        {
          projectId: "my-app",
          parentIssue: "INT-42",
          taskPlanPath: "docs/plans/int-42.task-plan.yaml",
          trackerPlugin: "github",
          createdAt: "2026-03-14T09:00:00.000Z",
        },
        [
          {
            taskIndex: 0,
            title: "Define schema",
            issueId: "101",
            issueUrl: "https://github.com/acme/repo/issues/101",
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
            title: "Implement API",
            issueId: "102",
            issueUrl: "https://github.com/acme/repo/issues/102",
            issueLabel: "#102",
            labels: ["workflow"],
            dependencies: ["101"],
            state: "queued",
            implementationSessions: [],
            reviewSessions: [],
            pr: null,
          },
        ],
      );

      expect(() =>
        mergeTaskLineageChildIssues(
          filePath,
          {
            projectId: "my-app",
            parentIssue: "INT-42",
            taskPlanPath: "docs/plans/int-42.task-plan.yaml",
            trackerPlugin: "github",
          },
          [
            {
              taskIndex: 0,
              title: "Define schema",
              issueId: "101",
              issueUrl: "https://github.com/acme/repo/issues/101",
              issueLabel: "#101",
              labels: ["workflow"],
              dependencies: [],
              state: "queued",
              implementationSessions: [],
              reviewSessions: [],
              pr: null,
            },
          ],
        ),
      ).toThrow("missing child issue reference for existing taskIndex 1 (#102)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("audits lineage drift against the task plan and reports missing child refs", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-task-lineage-audit-"));
    const projectPath = join(dir, "project");
    const filePath = join(projectPath, "docs", "plans", "int-42.lineage.yaml");
    const taskPlanPath = join(projectPath, "docs", "plans", "int-42.task-plan.yaml");

    try {
      mkdirSync(join(projectPath, "docs", "plans"), { recursive: true });
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
          "    summary: Add workflow command",
          "    acceptanceCriteria:",
          "      - Command works",
          "    dependencies: []",
          "    suggestedFiles: []",
          "    labels: []",
          "",
        ].join("\n"),
      );
      writeFileSync(
        filePath,
        [
          "version: 1",
          "parentIssue: INT-99",
          "taskPlanPath: docs/plans/int-42.task-plan.yaml",
          "trackerPlugin: github",
          "createdAt: 2026-03-13T12:00:00.000Z",
          "childIssues:",
          "  - taskIndex: 0",
          "    title: Define schema",
          "    issueId: '101'",
          "    issueUrl: https://github.com/acme/repo/issues/101",
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

      const audit = auditTaskLineageFile(filePath, { projectPath });

      expect(audit.ok).toBe(false);
      expect(audit.repaired).toBe(false);
      expect(audit.findings.map((finding) => finding.code)).toEqual(
        expect.arrayContaining(["parent_issue_drift", "missing_child_refs"]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs safe lineage fixes for state aliases, parent drift, and task-plan overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-task-lineage-repair-"));
    const projectPath = join(dir, "project");
    const plansDir = join(projectPath, "docs", "plans");
    const filePath = join(plansDir, "int-42.lineage.yaml");
    const replacementPlanPath = join(plansDir, "int-42-fixed.task-plan.yaml");

    try {
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(
        replacementPlanPath,
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
        filePath,
        [
          "parentIssue: INT-99",
          "taskPlanPath: docs/plans/stale.task-plan.yaml",
          "trackerPlugin: github",
          "createdAt: 2026-03-13T12:00:00.000Z",
          "childIssues:",
          "  - taskIndex: 0",
          "    title: Define schema",
          "    issueId: '101'",
          "    issueUrl: https://github.com/acme/repo/issues/101",
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

      const audit = auditTaskLineageFile(filePath, {
        projectPath,
        repair: true,
        taskPlanPathOverride: "docs/plans/int-42-fixed.task-plan.yaml",
        now: "2026-03-14T12:00:00.000Z",
      });
      const repaired = readTaskLineageFile(filePath);

      expect(audit.repaired).toBe(true);
      expect(audit.lineage?.parentIssue).toBe("INT-42");
      expect(repaired.parentIssue).toBe("INT-42");
      expect(repaired.taskPlanPath).toBe("docs/plans/int-42-fixed.task-plan.yaml");
      expect(repaired.updatedAt).toBe("2026-03-14T12:00:00.000Z");
      expect(repaired.childIssues[0]?.state).toBe("waiting_review");
      expect(audit.findings.filter((finding) => finding.repaired).map((finding) => finding.code)).toEqual(
        expect.arrayContaining(["missing_version", "missing_updated_at", "task_plan_override", "child_state_alias", "parent_issue_drift"]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
