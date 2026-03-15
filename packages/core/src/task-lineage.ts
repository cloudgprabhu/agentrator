import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { z } from "zod";
import type { PRState, Session } from "./types.js";
import { readTaskPlanFile, type TaskPlan } from "./task-plan.js";

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");
const normalizeIssueRef = (value: string): string => normalizeText(value).replace(/^#/, "");
const normalizePrRef = (value: string): string => normalizeText(value).toLowerCase();

const NonEmptyTextSchema = z.string().transform(normalizeText).pipe(z.string().min(1));
const OptionalTextSchema = z.union([NonEmptyTextSchema, z.null()]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneIfObject<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneIfObject(entry)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneIfObject(entry)]),
    ) as T;
  }
  return value;
}

function formatIssuePath(path: (string | number)[]): string {
  if (path.length === 0) return "<root>";

  let rendered = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      rendered += `[${segment}]`;
      continue;
    }
    rendered += rendered ? `.${segment}` : segment;
  }
  return rendered;
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`).join("; ");
}

// =============================================================================
// Legacy task-tree lineage repair helpers
// =============================================================================

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

  for (const task of availableTasks) {
    if (task.id === taskId) continue;

    const taskWords = new Set(task.description.toLowerCase().split(/\s+/));
    const descWords = description.toLowerCase().split(/\s+/);
    const sharedWords = descWords.filter((word) => taskWords.has(word));
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

  const taskMap = new Map(tasks.map((task) => [task.id, task]));

  for (const task of tasks) {
    if (task.parentId !== null && !taskMap.has(task.parentId)) {
      result.errors.push(`Task ${task.id}: parent ${task.parentId} not found`);
      result.success = false;
    }

    for (const childId of task.childIds) {
      const child = taskMap.get(childId);
      if (!child) {
        result.errors.push(`Task ${task.id}: child ${childId} not found`);
        result.success = false;
        continue;
      }

      if (child.parentId !== task.id) {
        result.errors.push(
          `Task ${task.id}: child ${childId} has parent ${child.parentId}, expected ${task.id}`,
        );
        result.success = false;
      }
    }

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
 */
export function repairLineage(
  tasks: TaskLineageNode[],
  options: { apply?: boolean } = {},
): LineageRepairResult {
  const result: LineageRepairResult = {
    success: true,
    warnings: [],
    errors: [],
    repairedCount: 0,
    skippedCount: 0,
  };

  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const repairs: Array<{ taskId: string; parentId: string }> = [];

  for (const task of tasks) {
    if (task.parentId === null && task.depth > 0) {
      const candidates = tasks.filter(
        (candidate) =>
          candidate.childIds.includes(task.id) ||
          (candidate.depth === task.depth - 1 && !candidate.childIds.includes(task.id)),
      );

      if (candidates.length === 0) {
        result.warnings.push(`Task ${task.id}: depth ${task.depth} but no parent found (orphaned)`);
        result.skippedCount += 1;
      } else if (candidates.length === 1) {
        repairs.push({ taskId: task.id, parentId: candidates[0].id });
        result.repairedCount += 1;
      } else {
        const candidateIds = candidates.map((candidate) => candidate.id).join(", ");
        result.warnings.push(
          `Task ${task.id}: ambiguous parent relocation (${candidates.length} candidates: ${candidateIds}) — SKIPPING`,
        );
        result.skippedCount += 1;
      }
    }
  }

  for (const task of tasks) {
    if (task.parentId === null) continue;

    const parent = taskMap.get(task.parentId);
    if (!parent || parent.childIds.includes(task.id)) continue;

    const otherChildrenWithSameDescription = parent.childIds
      .map((id) => taskMap.get(id))
      .filter(
        (candidate): candidate is TaskLineageNode =>
          candidate !== undefined && candidate.description === task.description,
      );

    if (otherChildrenWithSameDescription.length > 0) {
      const duplicateIds = otherChildrenWithSameDescription
        .map((candidate) => candidate.id)
        .join(", ");
      result.warnings.push(
        `Task ${task.id}: parent ${task.parentId} has similar children (${duplicateIds}) — ambiguous relocation, SKIPPING`,
      );
      result.skippedCount += 1;
      continue;
    }

    if (options.apply) {
      parent.childIds.push(task.id);
    }
    result.repairedCount += 1;
  }

  if (options.apply) {
    for (const repair of repairs) {
      const task = taskMap.get(repair.taskId);
      const parent = taskMap.get(repair.parentId);
      if (!task || !parent) continue;
      task.parentId = repair.parentId;
      if (!parent.childIds.includes(task.id)) {
        parent.childIds.push(task.id);
      }
    }
  }

  return result;
}

/**
 * Builds a lineage array (ancestor descriptions) for a task.
 */
export function buildLineageArray(
  task: TaskLineageNode,
  taskMap: Map<string, TaskLineageNode>,
): string[] {
  const lineage: string[] = [];
  let current = task.parentId ? taskMap.get(task.parentId) : null;

  while (current) {
    lineage.unshift(current.description);
    current = current.parentId ? taskMap.get(current.parentId) : null;
  }

  return lineage;
}

// =============================================================================
// Workflow lineage YAML model
// =============================================================================

export const TASK_LINEAGE_VERSION = 1 as const;

export const TASK_LINEAGE_CHILD_STATES = [
  "queued",
  "in_progress",
  "blocked",
  "pr_opened",
  "waiting_review",
  "changes_requested",
  "approved",
  "done",
] as const;

const CHILD_STATE_ALIASES: Record<string, (typeof TASK_LINEAGE_CHILD_STATES)[number]> = {
  "waiting-review": "waiting_review",
};

export const TaskLineageChildStateSchema = z.enum(TASK_LINEAGE_CHILD_STATES);
export type TaskLineageChildState = z.infer<typeof TaskLineageChildStateSchema>;

export const TaskLineageSessionSchema = z
  .object({
    sessionId: NonEmptyTextSchema,
    role: NonEmptyTextSchema,
    branch: OptionalTextSchema,
    worktreePath: OptionalTextSchema,
    createdAt: NonEmptyTextSchema,
  })
  .strict();

export type TaskLineageSession = z.infer<typeof TaskLineageSessionSchema>;

export const TaskLineagePRSchema = z
  .object({
    number: z.number().int().positive(),
    url: NonEmptyTextSchema,
    branch: OptionalTextSchema,
    state: z.enum(["open", "merged", "closed"]),
    updatedAt: NonEmptyTextSchema,
  })
  .strict();

export type TaskLineagePR = z.infer<typeof TaskLineagePRSchema>;

export const TaskLineageChildIssueSchema = z
  .object({
    taskIndex: z.number().int().nonnegative(),
    title: NonEmptyTextSchema,
    issueId: NonEmptyTextSchema,
    issueUrl: NonEmptyTextSchema,
    issueLabel: NonEmptyTextSchema,
    labels: z.array(NonEmptyTextSchema),
    dependencies: z.array(NonEmptyTextSchema),
    state: TaskLineageChildStateSchema,
    implementationSessions: z.array(TaskLineageSessionSchema),
    reviewSessions: z.array(TaskLineageSessionSchema),
    pr: z.union([TaskLineagePRSchema, z.null()]),
  })
  .strict();

export type TaskLineageChildIssue = z.infer<typeof TaskLineageChildIssueSchema>;

export const TaskLineageSchema = z
  .object({
    version: z.literal(TASK_LINEAGE_VERSION),
    projectId: NonEmptyTextSchema,
    parentIssue: NonEmptyTextSchema,
    taskPlanPath: NonEmptyTextSchema,
    trackerPlugin: NonEmptyTextSchema,
    createdAt: NonEmptyTextSchema,
    updatedAt: NonEmptyTextSchema,
    planningSession: z.union([TaskLineageSessionSchema, z.null()]),
    childIssues: z.array(TaskLineageChildIssueSchema),
  })
  .strict();

export type TaskLineage = z.infer<typeof TaskLineageSchema>;

export type TaskLineageAuditSeverity = "info" | "warning" | "error";

export interface TaskLineageAuditFinding {
  severity: TaskLineageAuditSeverity;
  code: string;
  message: string;
  repaired: boolean;
}

export interface TaskLineageAuditOptions {
  projectId?: string;
  taskPlanPath?: string;
  repair?: boolean;
}

export interface TaskLineageAuditResult {
  filePath: string;
  lineage: TaskLineage;
  findings: TaskLineageAuditFinding[];
  repaired: boolean;
}

export interface TaskLineageParentMatch {
  filePath: string;
  lineage: TaskLineage;
}

export interface TaskLineageChildMatch extends TaskLineageParentMatch {
  childIndex: number;
}

export interface TaskLineageSessionMatch extends TaskLineageParentMatch {
  childIndex: number | null;
  relationship: "planning" | "implementation" | "review";
}

export interface TaskLineageChildOrPRMatch extends TaskLineageChildMatch {
  matchSource: "issue" | "pr";
}

export interface TaskPlanRelocationCandidate {
  filePath: string;
  taskPlan: TaskPlan;
}

function normalizeTaskLineageChildStateValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = normalizeText(value);
  if ((TASK_LINEAGE_CHILD_STATES as readonly string[]).includes(trimmed)) {
    return trimmed;
  }
  return CHILD_STATE_ALIASES[trimmed] ?? trimmed;
}

function normalizeTaskLineageInput(input: unknown): unknown {
  if (!isPlainObject(input)) return input;

  const normalized = cloneIfObject(input);
  const nowIso = new Date().toISOString();
  normalized["version"] ??= TASK_LINEAGE_VERSION;

  if (!("planningSession" in normalized)) {
    normalized["planningSession"] = null;
  }

  const createdAt =
    typeof normalized["createdAt"] === "string" ? normalizeText(normalized["createdAt"]) : nowIso;
  normalized["createdAt"] = createdAt;
  normalized["updatedAt"] =
    typeof normalized["updatedAt"] === "string"
      ? normalizeText(normalized["updatedAt"])
      : createdAt;

  if (Array.isArray(normalized["childIssues"])) {
    normalized["childIssues"] = normalized["childIssues"].map((entry) => {
      if (!isPlainObject(entry)) return entry;
      const child = cloneIfObject(entry);
      child["state"] = normalizeTaskLineageChildStateValue(child["state"] ?? "queued");
      child["implementationSessions"] = Array.isArray(child["implementationSessions"])
        ? child["implementationSessions"]
        : [];
      child["reviewSessions"] = Array.isArray(child["reviewSessions"])
        ? child["reviewSessions"]
        : [];
      if (!("pr" in child)) {
        child["pr"] = null;
      }
      return child;
    });
  }

  return normalized;
}

export function parseTaskLineageChildState(value: string): TaskLineageChildState {
  const normalized = normalizeTaskLineageChildStateValue(value);
  try {
    return TaskLineageChildStateSchema.parse(normalized);
  } catch {
    throw new Error(
      `Unknown task lineage child state: ${value}. Allowed: ${TASK_LINEAGE_CHILD_STATES.join(", ")}`,
    );
  }
}

export function validateTaskLineage(input: unknown, source = "<task-lineage>"): TaskLineage {
  try {
    return TaskLineageSchema.parse(normalizeTaskLineageInput(input));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid task lineage in ${source}: ${formatZodError(error)}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export function parseTaskLineage(content: string, source = "<task-lineage>"): TaskLineage {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse task lineage YAML in ${source}: ${message}`, {
      cause: error,
    });
  }

  return validateTaskLineage(parsed, source);
}

export function readTaskLineageFile(filePath: string): TaskLineage {
  return parseTaskLineage(readFileSync(filePath, "utf-8"), filePath);
}

export function taskLineageToYaml(lineage: TaskLineage): string {
  return yamlStringify(validateTaskLineage(lineage), { indent: 2 });
}

export function writeTaskLineageFile(filePath: string, lineage: TaskLineage): TaskLineage {
  const normalized = validateTaskLineage(lineage, filePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, taskLineageToYaml(normalized), "utf-8");
  return normalized;
}

function listFilesRecursively(rootPath: string, suffixes: string[]): string[] {
  const results: string[] = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const entries = (() => {
      try {
        return readdirSync(current);
      } catch {
        return null;
      }
    })();
    if (!entries) continue;

    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const filePath = join(current, entry);
      let stats;
      try {
        stats = statSync(filePath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        stack.push(filePath);
        continue;
      }

      if (suffixes.some((suffix) => filePath.endsWith(suffix))) {
        results.push(filePath);
      }
    }
  }

  results.sort();
  return results;
}

function listTaskLineageFiles(projectPath: string): string[] {
  return listFilesRecursively(projectPath, [".lineage.yaml", ".lineage.yml"]);
}

export function listTaskPlanFiles(projectPath: string): string[] {
  return listFilesRecursively(projectPath, [".task-plan.yaml", ".task-plan.yml"]);
}

function resolveProjectFilePath(projectPath: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(projectPath, filePath);
}

function asProjectRelativePath(projectPath: string, filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  const relativePath = relative(projectPath, filePath);
  return relativePath.startsWith("..") ? filePath : relativePath;
}

export function findTaskPlanRelocationCandidates(
  projectPath: string,
  parentIssue: string,
  options: { excludePath?: string } = {},
): TaskPlanRelocationCandidate[] {
  const excludedPath = options.excludePath
    ? resolveProjectFilePath(projectPath, options.excludePath)
    : null;

  return listTaskPlanFiles(projectPath)
    .filter((filePath) => filePath !== excludedPath)
    .map((filePath) => {
      try {
        return {
          filePath,
          taskPlan: readTaskPlanFile(filePath, { expectedParentIssue: parentIssue }),
        } satisfies TaskPlanRelocationCandidate;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is TaskPlanRelocationCandidate => entry !== null);
}

function withUpdatedTimestamp(lineage: TaskLineage): TaskLineage {
  return { ...lineage, updatedAt: new Date().toISOString() };
}

function readTaskLineageFileSafely(filePath: string): TaskLineage | null {
  try {
    return readTaskLineageFile(filePath);
  } catch {
    return null;
  }
}

function matchesIssueReference(child: TaskLineageChildIssue, reference: string): boolean {
  const normalizedReference = normalizeIssueRef(reference);
  return (
    child.issueId === normalizedReference ||
    normalizeIssueRef(child.issueLabel) === normalizedReference ||
    normalizeIssueRef(child.issueUrl) === normalizedReference
  );
}

function matchesPRReference(child: TaskLineageChildIssue, reference: string): boolean {
  if (!child.pr) return false;

  const normalizedReference = normalizePrRef(reference);
  if (normalizePrRef(child.pr.url) === normalizedReference) return true;
  if (normalizePrRef(String(child.pr.number)) === normalizedReference) return true;
  if (child.pr.branch && normalizePrRef(child.pr.branch) === normalizedReference) return true;

  return false;
}

function updateTaskLineageFile(
  filePath: string,
  mutate: (lineage: TaskLineage) => TaskLineage,
): TaskLineage {
  const current = readTaskLineageFile(filePath);
  const updated = validateTaskLineage(withUpdatedTimestamp(mutate(current)), filePath);
  writeTaskLineageFile(filePath, updated);
  return updated;
}

export function findTaskLineageByParentIssue(
  projectPath: string,
  parentIssue: string,
): TaskLineageParentMatch | null {
  const expected = normalizeText(parentIssue);
  for (const filePath of listTaskLineageFiles(projectPath)) {
    const lineage = readTaskLineageFileSafely(filePath);
    if (!lineage || lineage.parentIssue !== expected) continue;
    return { filePath, lineage };
  }
  return null;
}

export function findTaskLineageByChildIssue(
  projectPath: string,
  childIssueRef: string,
): TaskLineageChildMatch | null {
  for (const filePath of listTaskLineageFiles(projectPath)) {
    const lineage = readTaskLineageFileSafely(filePath);
    if (!lineage) continue;

    const childIndex = lineage.childIssues.findIndex((child) =>
      matchesIssueReference(child, childIssueRef),
    );
    if (childIndex === -1) continue;

    return { filePath, lineage, childIndex };
  }

  return null;
}

export function findTaskLineageByChildOrPRRef(
  projectPath: string,
  reference: string,
): TaskLineageChildOrPRMatch | null {
  const issueMatch = findTaskLineageByChildIssue(projectPath, reference);
  if (issueMatch) {
    return { ...issueMatch, matchSource: "issue" };
  }

  for (const filePath of listTaskLineageFiles(projectPath)) {
    const lineage = readTaskLineageFileSafely(filePath);
    if (!lineage) continue;

    const childIndex = lineage.childIssues.findIndex((child) =>
      matchesPRReference(child, reference),
    );
    if (childIndex === -1) continue;

    return { filePath, lineage, childIndex, matchSource: "pr" };
  }

  return null;
}

export function findTaskLineageByPREvent(
  projectPath: string,
  event: { prNumber?: number; branch?: string },
): TaskLineageChildMatch | null {
  for (const filePath of listTaskLineageFiles(projectPath)) {
    const lineage = readTaskLineageFileSafely(filePath);
    if (!lineage) continue;

    const childIndex = lineage.childIssues.findIndex((child) => {
      if (!child.pr) return false;
      if (event.prNumber !== undefined && child.pr.number === event.prNumber) return true;
      if (event.branch && child.pr.branch === event.branch) return true;
      return false;
    });
    if (childIndex === -1) continue;

    return { filePath, lineage, childIndex };
  }

  return null;
}

export function findTaskLineageBySession(
  projectPath: string,
  sessionId: string,
): TaskLineageSessionMatch | null {
  for (const filePath of listTaskLineageFiles(projectPath)) {
    const lineage = readTaskLineageFileSafely(filePath);
    if (!lineage) continue;

    if (lineage.planningSession?.sessionId === sessionId) {
      return {
        filePath,
        lineage,
        childIndex: null,
        relationship: "planning",
      };
    }

    for (const [childIndex, child] of lineage.childIssues.entries()) {
      if (child.implementationSessions.some((entry) => entry.sessionId === sessionId)) {
        return {
          filePath,
          lineage,
          childIndex,
          relationship: "implementation",
        };
      }
      if (child.reviewSessions.some((entry) => entry.sessionId === sessionId)) {
        return {
          filePath,
          lineage,
          childIndex,
          relationship: "review",
        };
      }
    }
  }

  return null;
}

export function createTaskLineageSessionRef(
  session: Pick<Session, "id" | "branch" | "workspacePath" | "createdAt">,
  role: string,
): TaskLineageSession {
  return {
    sessionId: session.id,
    role: normalizeText(role),
    branch: session.branch ? normalizeText(session.branch) : null,
    worktreePath: session.workspacePath ? normalizeText(session.workspacePath) : null,
    createdAt: session.createdAt.toISOString(),
  };
}

const CHILD_STATE_TRANSITIONS: Record<TaskLineageChildState, TaskLineageChildState[]> = {
  queued: ["in_progress", "blocked", "pr_opened", "waiting_review", "done"],
  in_progress: ["blocked", "pr_opened", "waiting_review", "changes_requested", "approved", "done"],
  blocked: ["queued", "in_progress", "pr_opened", "waiting_review", "done"],
  pr_opened: ["blocked", "waiting_review", "changes_requested", "approved", "done"],
  waiting_review: ["blocked", "changes_requested", "approved", "done"],
  changes_requested: ["blocked", "in_progress", "pr_opened", "waiting_review", "done"],
  approved: ["blocked", "changes_requested", "done"],
  done: [],
};

export function getAllowedTaskLineageChildStateTransitions(
  currentState: TaskLineageChildState,
): TaskLineageChildState[] {
  return [...CHILD_STATE_TRANSITIONS[currentState]];
}

export function canTransitionTaskLineageChildState(
  currentState: TaskLineageChildState,
  nextState: TaskLineageChildState,
): boolean {
  return currentState === nextState || CHILD_STATE_TRANSITIONS[currentState].includes(nextState);
}

export function summarizeTaskLineageStates(
  lineage: TaskLineage,
): Record<TaskLineageChildState, number> {
  const summary = Object.fromEntries(
    TASK_LINEAGE_CHILD_STATES.map((state) => [state, 0]),
  ) as Record<TaskLineageChildState, number>;

  for (const child of lineage.childIssues) {
    summary[child.state] += 1;
  }

  return summary;
}

export function transitionTaskLineageChildState(
  projectPath: string,
  childRef: string,
  nextState: TaskLineageChildState,
): TaskLineageChildMatch {
  const match = findTaskLineageByChildIssue(projectPath, childRef);
  if (!match) {
    throw new Error(`No workflow child issue found for ${childRef}`);
  }

  updateTaskLineageFile(match.filePath, (lineage) => {
    const child = lineage.childIssues[match.childIndex];
    if (!child) return lineage;

    if (!canTransitionTaskLineageChildState(child.state, nextState)) {
      throw new Error(
        `Cannot move ${child.issueLabel} from ${child.state} to ${nextState}. Allowed: ${getAllowedTaskLineageChildStateTransitions(child.state).join(", ")}`,
      );
    }

    const updatedChildren = lineage.childIssues.map((entry, index) =>
      index === match.childIndex ? { ...entry, state: nextState } : entry,
    );
    return { ...lineage, childIssues: updatedChildren };
  });

  const refreshed = findTaskLineageByChildIssue(projectPath, childRef);
  if (!refreshed) {
    throw new Error(`Workflow child issue disappeared after update: ${childRef}`);
  }
  return refreshed;
}

export function recordTaskLineageChildSession(
  projectPath: string,
  issueId: string,
  kind: "implementation" | "review",
  sessionRef: TaskLineageSession,
): TaskLineageChildMatch {
  const match = findTaskLineageByChildIssue(projectPath, issueId);
  if (!match) {
    throw new Error(`No workflow child issue found for ${issueId}`);
  }

  updateTaskLineageFile(match.filePath, (lineage) => {
    const child = lineage.childIssues[match.childIndex];
    if (!child) return lineage;

    const collectionKey = kind === "implementation" ? "implementationSessions" : "reviewSessions";
    const currentEntries = child[collectionKey];
    const exists = currentEntries.some((entry) => entry.sessionId === sessionRef.sessionId);
    const nextEntries = exists ? currentEntries : [...currentEntries, sessionRef];
    const nextState = kind === "implementation" ? "in_progress" : "waiting_review";

    const updatedChild: TaskLineageChildIssue = {
      ...child,
      [collectionKey]: nextEntries,
      state: canTransitionTaskLineageChildState(child.state, nextState) ? nextState : child.state,
    };

    return {
      ...lineage,
      childIssues: lineage.childIssues.map((entry, index) =>
        index === match.childIndex ? updatedChild : entry,
      ),
    };
  });

  const refreshed = findTaskLineageByChildIssue(projectPath, issueId);
  if (!refreshed) {
    throw new Error(`Workflow child issue disappeared after session update: ${issueId}`);
  }
  return refreshed;
}

export function recordTaskLineagePR(
  projectPath: string,
  sessionId: string,
  pr: {
    number: number;
    url: string;
    branch: string | null;
    state: PRState;
  },
): TaskLineageChildMatch {
  const match = findTaskLineageBySession(projectPath, sessionId);
  if (!match || match.childIndex === null) {
    throw new Error(`No workflow child issue found for session ${sessionId}`);
  }

  updateTaskLineageFile(match.filePath, (lineage) => {
    const childIndex = match.childIndex;
    if (childIndex === null) return lineage;
    const child = lineage.childIssues[childIndex];
    if (!child) return lineage;

    const nextState: TaskLineageChildState =
      pr.state === "merged" ? "done" : pr.state === "closed" ? "changes_requested" : "pr_opened";
    const updatedChild: TaskLineageChildIssue = {
      ...child,
      pr: {
        number: pr.number,
        url: normalizeText(pr.url),
        branch: pr.branch ? normalizeText(pr.branch) : null,
        state: pr.state,
        updatedAt: new Date().toISOString(),
      },
      state: canTransitionTaskLineageChildState(child.state, nextState) ? nextState : child.state,
    };

    return {
      ...lineage,
      childIssues: lineage.childIssues.map((entry, index) =>
        index === childIndex ? updatedChild : entry,
      ),
    };
  });

  const refreshed = findTaskLineageBySession(projectPath, sessionId);
  if (!refreshed || refreshed.childIndex === null) {
    throw new Error(`Workflow child issue disappeared after PR update: ${sessionId}`);
  }
  return {
    filePath: refreshed.filePath,
    lineage: refreshed.lineage,
    childIndex: refreshed.childIndex,
  };
}

export function upsertTaskLineagePlanningSession(
  projectPath: string,
  parentIssue: string,
  planningSession: TaskLineageSession,
  seed?: Omit<TaskLineage, "planningSession" | "updatedAt">,
): TaskLineageParentMatch {
  const existing = findTaskLineageByParentIssue(projectPath, parentIssue);
  if (existing) {
    const lineage = updateTaskLineageFile(existing.filePath, (current) => ({
      ...current,
      planningSession,
    }));
    return { filePath: existing.filePath, lineage };
  }

  if (!seed) {
    throw new Error(`No workflow lineage found for ${parentIssue}`);
  }

  const filePath = join(projectPath, "docs", "plans", `${parentIssue.toLowerCase()}.lineage.yaml`);
  const lineage = writeTaskLineageFile(filePath, {
    ...seed,
    planningSession,
    updatedAt: seed.createdAt,
  });
  return { filePath, lineage };
}

export function mergeTaskLineageChildIssues(
  lineage: TaskLineage,
  childIssues: TaskLineageChildIssue[],
): TaskLineage {
  const byTaskIndex = new Map<number, TaskLineageChildIssue>();
  for (const child of lineage.childIssues) {
    byTaskIndex.set(child.taskIndex, child);
  }
  for (const child of childIssues) {
    byTaskIndex.set(child.taskIndex, child);
  }

  return {
    ...lineage,
    childIssues: [...byTaskIndex.values()].sort((a, b) => a.taskIndex - b.taskIndex),
  };
}

export function updateTaskLineageTaskPlanPath(
  projectPath: string,
  parentIssue: string,
  taskPlanPath: string,
): TaskLineageParentMatch {
  const match = findTaskLineageByParentIssue(projectPath, parentIssue);
  if (!match) {
    throw new Error(`No workflow lineage found for ${parentIssue}`);
  }

  const lineage = updateTaskLineageFile(match.filePath, (current) => ({
    ...current,
    taskPlanPath: normalizeText(taskPlanPath),
  }));
  return { filePath: match.filePath, lineage };
}

export function auditTaskLineageFile(
  projectPath: string,
  filePath: string,
  options: TaskLineageAuditOptions = {},
): TaskLineageAuditResult {
  const rawContent = readFileSync(filePath, "utf-8");
  const rawParsed = parseYaml(rawContent);
  const auditInput = isPlainObject(rawParsed) ? cloneIfObject(rawParsed) : rawParsed;
  if (isPlainObject(auditInput) && auditInput["projectId"] === undefined && options.projectId) {
    auditInput["projectId"] = options.projectId;
  }
  const findings: TaskLineageAuditFinding[] = [];
  let lineage = validateTaskLineage(auditInput, filePath);
  let repaired = false;

  if (isPlainObject(rawParsed) && rawParsed["version"] === undefined) {
    findings.push({
      severity: "warning",
      code: "missing_version",
      message: "Lineage file is missing version",
      repaired: false,
    });
  }

  if (isPlainObject(rawParsed) && rawParsed["updatedAt"] === undefined) {
    findings.push({
      severity: "warning",
      code: "missing_updated_at",
      message: "Lineage file is missing updatedAt",
      repaired: false,
    });
  }

  if (isPlainObject(rawParsed) && Array.isArray(rawParsed["childIssues"])) {
    rawParsed["childIssues"].forEach((entry, index) => {
      if (!isPlainObject(entry) || typeof entry["state"] !== "string") return;
      const state = normalizeText(entry["state"]);
      if (state in CHILD_STATE_ALIASES) {
        findings.push({
          severity: "warning",
          code: "legacy_child_state",
          message: `childIssues[${index}] uses legacy child state alias ${state}`,
          repaired: false,
        });
      }
    });
  }

  const effectiveTaskPlanPath = options.taskPlanPath ?? lineage.taskPlanPath;
  const effectiveTaskPlanFilePath = resolveProjectFilePath(projectPath, effectiveTaskPlanPath);

  let taskPlan: TaskPlan | null = null;
  try {
    taskPlan = readTaskPlanFile(effectiveTaskPlanFilePath);

    if (lineage.parentIssue !== taskPlan.parentIssue) {
      findings.push({
        severity: "error",
        code: "parent_issue_drift",
        message: `Lineage parentIssue ${lineage.parentIssue} does not match task plan parentIssue ${taskPlan.parentIssue}`,
        repaired: false,
      });
    }

    const lineageKeys = new Set(
      lineage.childIssues.map((child) => `${child.taskIndex}:${child.title}`),
    );
    const missingRefs = taskPlan.childTasks.filter(
      (task, taskIndex) => !lineageKeys.has(`${taskIndex}:${task.title}`),
    );
    if (missingRefs.length > 0) {
      findings.push({
        severity: "error",
        code: "missing_child_refs",
        message: `Task plan has ${missingRefs.length} child task(s) missing from lineage`,
        repaired: false,
      });
    }

    if (options.taskPlanPath && normalizeText(options.taskPlanPath) !== lineage.taskPlanPath) {
      findings.push({
        severity: "warning",
        code: "task_plan_override",
        message: `Lineage taskPlanPath differs from explicit override ${options.taskPlanPath}`,
        repaired: false,
      });
    }
  } catch {
    findings.push({
      severity: "warning",
      code: "task_plan_unreadable",
      message: `Task plan could not be read at ${effectiveTaskPlanPath}`,
      repaired: false,
    });

    if (!options.taskPlanPath) {
      const relocationCandidates = findTaskPlanRelocationCandidates(
        projectPath,
        lineage.parentIssue,
        {
          excludePath: effectiveTaskPlanFilePath,
        },
      );
      if (relocationCandidates.length === 1) {
        const candidatePath = asProjectRelativePath(projectPath, relocationCandidates[0].filePath);
        findings.push({
          severity: "warning",
          code: "task_plan_relocation_candidate",
          message: `Found matching task plan at ${candidatePath}; re-run with --task-plan ${candidatePath} --repair or relocate taskPlanPath explicitly`,
          repaired: false,
        });
      } else if (relocationCandidates.length > 1) {
        const candidatePaths = relocationCandidates
          .map((candidate) => asProjectRelativePath(projectPath, candidate.filePath))
          .join(", ");
        findings.push({
          severity: "warning",
          code: "task_plan_relocation_ambiguous",
          message: `Found multiple matching task plans (${candidatePaths}); choose one and relocate taskPlanPath explicitly`,
          repaired: false,
        });
      }
    }
  }

  if (options.repair) {
    let changed = false;
    const repairedLineage = cloneIfObject(lineage);

    if (isPlainObject(rawParsed) && rawParsed["version"] === undefined) {
      repairedLineage.version = TASK_LINEAGE_VERSION;
      changed = true;
      const finding = findings.find((entry) => entry.code === "missing_version");
      if (finding) finding.repaired = true;
    }

    if (isPlainObject(rawParsed) && rawParsed["updatedAt"] === undefined) {
      repairedLineage.updatedAt = new Date().toISOString();
      changed = true;
      const finding = findings.find((entry) => entry.code === "missing_updated_at");
      if (finding) finding.repaired = true;
    }

    const hasLegacyStateFinding = findings.some((entry) => entry.code === "legacy_child_state");
    const normalizedChildren = repairedLineage.childIssues.map((child) => ({
      ...child,
      state: parseTaskLineageChildState(child.state),
    }));
    if (
      hasLegacyStateFinding ||
      JSON.stringify(normalizedChildren) !== JSON.stringify(repairedLineage.childIssues)
    ) {
      repairedLineage.childIssues = normalizedChildren;
      changed = true;
      for (const finding of findings.filter((entry) => entry.code === "legacy_child_state")) {
        finding.repaired = true;
      }
    }

    if (taskPlan && repairedLineage.parentIssue !== taskPlan.parentIssue) {
      repairedLineage.parentIssue = taskPlan.parentIssue;
      changed = true;
      const finding = findings.find((entry) => entry.code === "parent_issue_drift");
      if (finding) finding.repaired = true;
    }

    if (
      options.taskPlanPath &&
      normalizeText(options.taskPlanPath) !== repairedLineage.taskPlanPath
    ) {
      repairedLineage.taskPlanPath = normalizeText(options.taskPlanPath);
      changed = true;
      const finding = findings.find((entry) => entry.code === "task_plan_override");
      if (finding) finding.repaired = true;
    }

    if (changed) {
      lineage = writeTaskLineageFile(filePath, repairedLineage);
      repaired = true;
    }
  }

  return { filePath, lineage, findings, repaired };
}
