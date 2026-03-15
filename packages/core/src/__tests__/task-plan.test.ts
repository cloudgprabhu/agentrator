import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  TASK_PLAN_VERSION,
  parseTaskPlan,
  readTaskPlanFile,
  taskPlanToYaml,
  validateTaskPlan,
} from "../task-plan.js";

describe("task plan validation", () => {
  it("validates and normalizes a structured task plan", () => {
    const taskPlan = validateTaskPlan({
      version: TASK_PLAN_VERSION,
      parentIssue: "  INT-42  ",
      specPath: " docs/specs/checkout.md ",
      adrPath: null,
      childTasks: [
        {
          title: " Define schema ",
          summary: " Add the YAML schema and validator. ",
          acceptanceCriteria: [" Schema parses ", " Invalid plans fail clearly "],
          dependencies: [],
          suggestedFiles: [" packages/core/src/task-plan.ts "],
          labels: ["workflow", "planning"],
        },
      ],
    });

    expect(taskPlan).toEqual({
      version: TASK_PLAN_VERSION,
      parentIssue: "INT-42",
      specPath: "docs/specs/checkout.md",
      adrPath: null,
      childTasks: [
        {
          title: "Define schema",
          summary: "Add the YAML schema and validator.",
          acceptanceCriteria: ["Schema parses", "Invalid plans fail clearly"],
          dependencies: [],
          suggestedFiles: ["packages/core/src/task-plan.ts"],
          labels: ["workflow", "planning"],
        },
      ],
    });
  });

  it("rejects plans with missing required child-task fields", () => {
    expect(() =>
      validateTaskPlan(
        {
          version: TASK_PLAN_VERSION,
          parentIssue: "INT-42",
          specPath: null,
          adrPath: null,
          childTasks: [
            {
              title: "Define schema",
              summary: "Add types",
              dependencies: [],
              suggestedFiles: [],
              labels: [],
            },
          ],
        },
        "docs/plans/int-42.task-plan.yaml",
      ),
    ).toThrow(
      "Invalid task plan in docs/plans/int-42.task-plan.yaml: childTasks[0].acceptanceCriteria: Required",
    );
  });

  it("rejects invalid yaml content with source context", () => {
    expect(() =>
      parseTaskPlan("version: 1\nparentIssue: INT-42\nchildTasks:\n  - title: oops: bad", "plan.yaml"),
    ).toThrow("Failed to parse task plan YAML in plan.yaml");
  });

  it("reads and validates a task-plan file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-task-plan-"));
    const filePath = join(dir, "int-42.task-plan.yaml");

    try {
      writeFileSync(
        filePath,
        taskPlanToYaml({
          version: TASK_PLAN_VERSION,
          parentIssue: "INT-42",
          specPath: "docs/specs/checkout.md",
          adrPath: "docs/adr/0007-checkout.md",
          childTasks: [
            {
              title: "Implement validator",
              summary: "Add file-level validation helpers.",
              acceptanceCriteria: ["CLI validation passes for valid YAML"],
              dependencies: [],
              suggestedFiles: ["packages/core/src/task-plan.ts"],
              labels: ["backend"],
            },
          ],
        }),
      );

      expect(readTaskPlanFile(filePath)).toEqual({
        version: TASK_PLAN_VERSION,
        parentIssue: "INT-42",
        specPath: "docs/specs/checkout.md",
        adrPath: "docs/adr/0007-checkout.md",
        childTasks: [
          {
            title: "Implement validator",
            summary: "Add file-level validation helpers.",
            acceptanceCriteria: ["CLI validation passes for valid YAML"],
            dependencies: [],
            suggestedFiles: ["packages/core/src/task-plan.ts"],
            labels: ["backend"],
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects task-plan files whose parentIssue does not match the expected issue", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-task-plan-parent-"));
    const filePath = join(dir, "int-42.task-plan.yaml");

    try {
      writeFileSync(
        filePath,
        taskPlanToYaml({
          version: TASK_PLAN_VERSION,
          parentIssue: "INT-42",
          specPath: null,
          adrPath: null,
          childTasks: [
            {
              title: "Implement validator",
              summary: "Add file-level validation helpers.",
              acceptanceCriteria: ["CLI validation passes for valid YAML"],
              dependencies: [],
              suggestedFiles: ["packages/core/src/task-plan.ts"],
              labels: ["backend"],
            },
          ],
        }),
      );

      expect(() => readTaskPlanFile(filePath, { expectedParentIssue: "INT-99" })).toThrow(
        "parentIssue must be INT-99 but was INT-42",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
