/**
 * Task Lineage — Safe lineage repair and validation.
 *
 * Manages task hierarchy relationships (parent/child) and ensures lineage
 * references remain consistent. Repairs missing references only when unambiguous.
 *
 * SAFETY RULES:
 * - NEVER guess when multiple candidates exist
 * - NEVER invent child issue references
 * - Emit explicit warnings for ambiguous relocations
 * - Skip repair rather than risk incorrect assumptions
 */

export interface TaskLineageNode {
  /** Task/issue identifier (e.g., "INT-100", "#42") */
  id: string;
  /** Parent task ID (null for root tasks) */
  parentId: string | null;
  /** Child task IDs */
  childIds: string[];
  /** Task description/title */
  description: string;
  /** Depth in the hierarchy (0 = root) */
  depth: number;
}

export interface LineageRepairResult {
  /** Whether repair was successful */
  success: boolean;
  /** Warning messages for ambiguous cases */
  warnings: string[];
  /** Errors encountered during repair */
  errors: string[];
  /** Number of references repaired */
  repairedCount: number;
  /** Number of references skipped due to ambiguity */
  skippedCount: number;
}

export interface AmbiguousRelocationCandidate {
  /** Candidate task ID */
  id: string;
  /** Why this is a candidate */
  reason: string;
  /** Similarity score (0-1) */
  score: number;
}

/**
 * Detects ambiguous task-plan relocations.
 * Returns candidates if multiple plausible targets exist.
 */
export function detectAmbiguousRelocation(
  taskId: string,
  description: string,
  availableTasks: TaskLineageNode[],
): AmbiguousRelocationCandidate[] {
  const candidates: AmbiguousRelocationCandidate[] = [];

  // Find tasks with similar descriptions
  for (const task of availableTasks) {
    if (task.id === taskId) continue;

    // Simple similarity check: shared words
    const taskWords = new Set(task.description.toLowerCase().split(/\s+/));
    const descWords = description.toLowerCase().split(/\s+/);
    const sharedWords = descWords.filter((w) => taskWords.has(w));
    const score = sharedWords.length / Math.max(taskWords.size, descWords.length);

    if (score > 0.3) {
      candidates.push({
        id: task.id,
        reason: `Similar description (${Math.round(score * 100)}% match)`,
        score,
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Validates lineage consistency for a task tree.
 * Detects broken parent/child references without repairing them.
 */
export function validateLineage(tasks: TaskLineageNode[]): LineageRepairResult {
  const result: LineageRepairResult = {
    success: true,
    warnings: [],
    errors: [],
    repairedCount: 0,
    skippedCount: 0,
  };

  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  for (const task of tasks) {
    // Check parent reference
    if (task.parentId !== null && !taskMap.has(task.parentId)) {
      result.errors.push(`Task ${task.id}: parent ${task.parentId} not found`);
      result.success = false;
    }

    // Check child references
    for (const childId of task.childIds) {
      const child = taskMap.get(childId);
      if (!child) {
        result.errors.push(`Task ${task.id}: child ${childId} not found`);
        result.success = false;
        continue;
      }

      // Verify bidirectional link
      if (child.parentId !== task.id) {
        result.errors.push(
          `Task ${task.id}: child ${childId} has parent ${child.parentId}, expected ${task.id}`,
        );
        result.success = false;
      }
    }

    // Check depth consistency
    if (task.parentId !== null) {
      const parent = taskMap.get(task.parentId);
      if (parent && task.depth !== parent.depth + 1) {
        result.errors.push(
          `Task ${task.id}: depth ${task.depth} inconsistent with parent depth ${parent.depth}`,
        );
        result.success = false;
      }
    } else if (task.depth !== 0) {
      result.errors.push(`Task ${task.id}: root task has depth ${task.depth}, expected 0`);
      result.success = false;
    }
  }

  return result;
}

/**
 * Attempts to repair missing lineage references.
 * SAFETY: Only repairs when there is exactly ONE unambiguous candidate.
 * Emits warnings and skips when multiple candidates exist.
 */
export function repairLineage(
  tasks: TaskLineageNode[],
  options: {
    /** Whether to actually apply repairs (false = dry run) */
    apply?: boolean;
  } = {},
): LineageRepairResult {
  const result: LineageRepairResult = {
    success: true,
    warnings: [],
    errors: [],
    repairedCount: 0,
    skippedCount: 0,
  };

  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const repairs: Array<{
    taskId: string;
    parentId: string;
    reason: string;
  }> = [];

  // First pass: detect missing parent references
  for (const task of tasks) {
    if (task.parentId === null && task.depth > 0) {
      // Root task marked with depth > 0 — might be missing parent
      const candidates = tasks.filter(
        (t) => t.childIds.includes(task.id) || (t.depth === task.depth - 1 && !t.childIds.includes(task.id)),
      );

      if (candidates.length === 0) {
        result.warnings.push(
          `Task ${task.id}: depth ${task.depth} but no parent found (orphaned)`,
        );
        result.skippedCount++;
      } else if (candidates.length === 1) {
        // Unambiguous — safe to repair
        repairs.push({
          taskId: task.id,
          parentId: candidates[0].id,
          reason: "Single candidate parent found",
        });
        result.repairedCount++;
      } else {
        // Ambiguous — NEVER guess
        const candidateIds = candidates.map((c) => c.id).join(", ");
        result.warnings.push(
          `Task ${task.id}: ambiguous parent relocation (${candidates.length} candidates: ${candidateIds}) — SKIPPING`,
        );
        result.skippedCount++;
      }
    }
  }

  // Second pass: detect missing child references
  for (const task of tasks) {
    if (task.parentId !== null) {
      const parent = taskMap.get(task.parentId);
      if (parent && !parent.childIds.includes(task.id)) {
        // Parent exists but doesn't list this as a child
        const otherChildrenWithSameDescription = parent.childIds
          .map((id) => taskMap.get(id))
          .filter((c) => c && c.description === task.description);

        if (otherChildrenWithSameDescription.length > 0) {
          // Possible duplicate or relocation ambiguity
          const dupIds = otherChildrenWithSameDescription.map((c) => c!.id).join(", ");
          result.warnings.push(
            `Task ${task.id}: parent ${task.parentId} has similar children (${dupIds}) — ambiguous relocation, SKIPPING`,
          );
          result.skippedCount++;
        } else {
          // Unambiguous — parent should list this child
          if (options.apply) {
            parent.childIds.push(task.id);
          }
          result.repairedCount++;
        }
      }
    }
  }

  // Apply parent repairs if requested
  if (options.apply) {
    for (const repair of repairs) {
      const task = taskMap.get(repair.taskId);
      const parent = taskMap.get(repair.parentId);
      if (task && parent) {
        task.parentId = repair.parentId;
        if (!parent.childIds.includes(task.id)) {
          parent.childIds.push(task.id);
        }
      }
    }
  }

  return result;
}

/**
 * Builds a lineage array (ancestor descriptions) for a task.
 */
export function buildLineageArray(task: TaskLineageNode, taskMap: Map<string, TaskLineageNode>): string[] {
  const lineage: string[] = [];
  let current = task.parentId ? taskMap.get(task.parentId) : null;

  while (current) {
    lineage.unshift(current.description);
    current = current.parentId ? taskMap.get(current.parentId) : null;
  }

  return lineage;
}
