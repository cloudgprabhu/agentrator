import { describe, it, expect } from "vitest";
import type { TaskLineageNode } from "../task-lineage.js";
import {
  validateLineage,
  repairLineage,
  detectAmbiguousRelocation,
  buildLineageArray,
} from "../task-lineage.js";

describe("task-lineage", () => {
  describe("validateLineage", () => {
    it("validates a valid task tree", () => {
      const tasks: TaskLineageNode[] = [
        {
          id: "1",
          parentId: null,
          childIds: ["1.1", "1.2"],
          description: "Root task",
          depth: 0,
        },
        {
          id: "1.1",
          parentId: "1",
          childIds: [],
          description: "Subtask 1",
          depth: 1,
        },
        {
          id: "1.2",
          parentId: "1",
          childIds: [],
          description: "Subtask 2",
          depth: 1,
        },
      ];

      const result = validateLineage(tasks);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("detects missing parent reference", () => {
      const tasks: TaskLineageNode[] = [
        {
          id: "1",
          parentId: null,
          childIds: ["1.1"],
          description: "Root task",
          depth: 0,
        },
        {
          id: "1.1",
          parentId: "999", // non-existent parent
          childIds: [],
          description: "Subtask 1",
          depth: 1,
        },
      ];

      const result = validateLineage(tasks);

      expect(result.success).toBe(false);
      expect(result.errors).toContain("Task 1.1: parent 999 not found");
    });

    it("detects missing child reference", () => {
      const tasks: TaskLineageNode[] = [
        {
          id: "1",
          parentId: null,
          childIds: ["999"], // non-existent child
          description: "Root task",
          depth: 0,
        },
      ];

      const result = validateLineage(tasks);

      expect(result.success).toBe(false);
      expect(result.errors).toContain("Task 1: child 999 not found");
    });

    it("detects inconsistent bidirectional link", () => {
      const tasks: TaskLineageNode[] = [
        {
          id: "1",
          parentId: null,
          childIds: ["1.1"],
          description: "Root task",
          depth: 0,
        },
        {
          id: "1.1",
          parentId: "999", // points to wrong parent
          childIds: [],
          description: "Subtask 1",
          depth: 1,
        },
      ];

      const result = validateLineage(tasks);

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        "Task 1: child 1.1 has parent 999, expected 1",
      );
    });

    it("detects depth inconsistency", () => {
      const tasks: TaskLineageNode[] = [
        {
          id: "1",
          parentId: null,
          childIds: ["1.1"],
          description: "Root task",
          depth: 0,
        },
        {
          id: "1.1",
          parentId: "1",
          childIds: [],
          description: "Subtask 1",
          depth: 5, // wrong depth
        },
      ];

      const result = validateLineage(tasks);

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        "Task 1.1: depth 5 inconsistent with parent depth 0",
      );
    });
  });

  describe("repairLineage", () => {
    it("skips repair when relocation is ambiguous (multiple candidates)", () => {
      const tasks: TaskLineageNode[] = [
        {
          id: "1",
          parentId: null,
          childIds: ["1.1"],
          description: "Root task",
          depth: 0,
        },
        {
          id: "2",
          parentId: null,
          childIds: ["2.1"],
          description: "Another root",
          depth: 0,
        },
        {
          id: "orphan",
          parentId: null, // missing parent
          childIds: [],
          description: "Orphaned task",
          depth: 1, // depth indicates it should have a parent
        },
        {
          id: "1.1",
          parentId: "1",
          childIds: [],
          description: "Child of 1",
          depth: 1,
        },
        {
          id: "2.1",
          parentId: "2",
          childIds: [],
          description: "Child of 2",
          depth: 1,
        },
      ];

      const result = repairLineage(tasks, { apply: false });

      // Should skip the orphaned task because there are 2 candidates (tasks at depth 0)
      expect(result.skippedCount).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.includes("ambiguous"))).toBe(true);
      expect(result.warnings.some((w) => w.includes("orphan"))).toBe(true);
    });

    it("emits warning for ambiguous task-plan relocation", () => {
      const tasks: TaskLineageNode[] = [
        {
          id: "parent",
          parentId: null,
          childIds: ["child1", "child2"],
          description: "Parent task",
          depth: 0,
        },
        {
          id: "child1",
          parentId: "parent",
          childIds: [],
          description: "Implement auth",
          depth: 1,
        },
        {
          id: "child2",
          parentId: "parent",
          childIds: [],
          description: "Implement auth",
          depth: 1,
        },
        {
          id: "orphan",
          parentId: "parent", // parent exists but doesn't list it
          childIds: [],
          description: "Implement auth", // same description as existing children
          depth: 1,
        },
      ];

      const result = repairLineage(tasks, { apply: false });

      expect(result.warnings.some((w) => w.includes("ambiguous relocation"))).toBe(true);
      expect(result.warnings.some((w) => w.includes("SKIPPING"))).toBe(true);
      expect(result.skippedCount).toBeGreaterThan(0);
    });

    it("repairs unambiguous missing parent reference", () => {
      const tasks: TaskLineageNode[] = [
        {
          id: "1",
          parentId: null,
          childIds: ["1.1"],
          description: "Root task",
          depth: 0,
        },
        {
          id: "1.1",
          parentId: null, // missing parent
          childIds: [],
          description: "Subtask 1",
          depth: 1,
        },
      ];

      const result = repairLineage(tasks, { apply: true });

      // Should repair since there's only one candidate parent (task at depth 0)
      expect(result.repairedCount).toBeGreaterThan(0);
      expect(tasks[1].parentId).toBe("1");
    });

    it("does not apply repairs in dry run mode", () => {
      const tasks: TaskLineageNode[] = [
        {
          id: "1",
          parentId: null,
          childIds: ["1.1"],
          description: "Root task",
          depth: 0,
        },
        {
          id: "1.1",
          parentId: null, // missing parent
          childIds: [],
          description: "Subtask 1",
          depth: 1,
        },
      ];

      const result = repairLineage(tasks, { apply: false });

      expect(result.repairedCount).toBeGreaterThan(0);
      expect(tasks[1].parentId).toBe(null); // Should not have been modified
    });
  });

  describe("detectAmbiguousRelocation", () => {
    it("detects similar tasks as relocation candidates", () => {
      const availableTasks: TaskLineageNode[] = [
        {
          id: "1",
          parentId: null,
          childIds: [],
          description: "Implement user authentication system",
          depth: 0,
        },
        {
          id: "2",
          parentId: null,
          childIds: [],
          description: "Implement user authorization module",
          depth: 0,
        },
        {
          id: "3",
          parentId: null,
          childIds: [],
          description: "Build frontend dashboard",
          depth: 0,
        },
      ];

      const candidates = detectAmbiguousRelocation(
        "new-task",
        "Implement user authentication",
        availableTasks,
      );

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].id).toBe("1"); // Most similar
      expect(candidates[0].score).toBeGreaterThan(0);
    });

    it("returns empty array when no similar tasks exist", () => {
      const availableTasks: TaskLineageNode[] = [
        {
          id: "1",
          parentId: null,
          childIds: [],
          description: "Completely unrelated task",
          depth: 0,
        },
      ];

      const candidates = detectAmbiguousRelocation(
        "new-task",
        "Implement user authentication",
        availableTasks,
      );

      expect(candidates).toHaveLength(0);
    });
  });

  describe("buildLineageArray", () => {
    it("builds correct lineage array for nested task", () => {
      const tasks: TaskLineageNode[] = [
        {
          id: "1",
          parentId: null,
          childIds: ["1.1"],
          description: "Root task",
          depth: 0,
        },
        {
          id: "1.1",
          parentId: "1",
          childIds: ["1.1.1"],
          description: "Level 1 task",
          depth: 1,
        },
        {
          id: "1.1.1",
          parentId: "1.1",
          childIds: [],
          description: "Level 2 task",
          depth: 2,
        },
      ];

      const taskMap = new Map(tasks.map((t) => [t.id, t]));
      const lineage = buildLineageArray(tasks[2], taskMap);

      expect(lineage).toEqual(["Root task", "Level 1 task"]);
    });

    it("returns empty array for root task", () => {
      const task: TaskLineageNode = {
        id: "1",
        parentId: null,
        childIds: [],
        description: "Root task",
        depth: 0,
      };

      const taskMap = new Map([[task.id, task]]);
      const lineage = buildLineageArray(task, taskMap);

      expect(lineage).toEqual([]);
    });
  });
});
