import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { z } from "zod";
import type { PRInfo, Session } from "./types.js";
import { readTaskPlanFile } from "./task-plan.js";

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

const NonEmptyTextSchema = z.string().transform(normalizeText).pipe(z.string().min(1));

const ISODateSchema = z.string().datetime({ offset: true });
const NullableTextSchema = z.union([NonEmptyTextSchema, z.null()]);

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

export const TaskLineageChildStateSchema = z.enum(TASK_LINEAGE_CHILD_STATES);

export const TaskLineageSessionSchema = z
  .object({
    sessionId: NonEmptyTextSchema,
    role: NonEmptyTextSchema,
    branch: NullableTextSchema,
    worktreePath: NullableTextSchema,
    createdAt: ISODateSchema,
  })
  .strict();

export const TaskLineagePRSchema = z
  .object({
    number: z.number().int().positive().optional(),
    url: NonEmptyTextSchema,
    branch: NullableTextSchema,
    state: NonEmptyTextSchema.optional(),
    updatedAt: ISODateSchema,
  })
  .strict();

export const TaskLineageChildIssueSchema = z
  .object({
    taskIndex: z.number().int().min(0),
    title: NonEmptyTextSchema,
    issueId: NonEmptyTextSchema,
    issueUrl: NonEmptyTextSchema,
    issueLabel: NonEmptyTextSchema,
    labels: z.array(NonEmptyTextSchema),
    dependencies: z.array(NonEmptyTextSchema),
    state: TaskLineageChildStateSchema.default("queued"),
    implementationSessions: z.array(TaskLineageSessionSchema).default([]),
    reviewSessions: z.array(TaskLineageSessionSchema).default([]),
    pr: TaskLineagePRSchema.nullable().default(null),
  })
  .strict();

export const TaskLineageSchema = z
  .object({
    version: z.literal(TASK_LINEAGE_VERSION),
    projectId: NonEmptyTextSchema.optional(),
    parentIssue: NonEmptyTextSchema,
    taskPlanPath: NonEmptyTextSchema,
    trackerPlugin: NonEmptyTextSchema,
    createdAt: ISODateSchema,
    updatedAt: ISODateSchema.optional(),
    planningSession: TaskLineageSessionSchema.nullable().default(null),
    childIssues: z.array(TaskLineageChildIssueSchema),
  })
  .strict();

export type TaskLineageSession = z.infer<typeof TaskLineageSessionSchema>;
export type TaskLineagePR = z.infer<typeof TaskLineagePRSchema>;
export type TaskLineageChildState = z.infer<typeof TaskLineageChildStateSchema>;
export type TaskLineageChildIssue = z.infer<typeof TaskLineageChildIssueSchema>;
export type TaskLineage = z.infer<typeof TaskLineageSchema>;
export type TaskLineageAuditSeverity = "error" | "warn" | "info";

export interface TaskLineageAuditFinding {
  code:
    | "malformed_yaml"
    | "invalid_schema"
    | "invalid_top_level"
    | "missing_version"
    | "missing_updated_at"
    | "child_state_alias"
    | "task_plan_override"
    | "task_plan_missing"
    | "task_plan_invalid"
    | "parent_issue_drift"
    | "missing_child_refs"
    | "extra_child_refs";
  severity: TaskLineageAuditSeverity;
  message: string;
  repairable: boolean;
  repaired?: boolean;
}

export interface TaskLineageAuditOptions {
  projectPath?: string;
  repair?: boolean;
  taskPlanPathOverride?: string;
  now?: string;
}

export interface TaskLineageAuditResult {
  filePath: string;
  ok: boolean;
  repaired: boolean;
  lineage: TaskLineage | null;
  findings: TaskLineageAuditFinding[];
}

const TASK_LINEAGE_CHILD_STATE_TRANSITIONS: Record<
  TaskLineageChildState,
  readonly TaskLineageChildState[]
> = {
  queued: ["in_progress", "blocked", "pr_opened", "waiting_review", "done"],
  in_progress: ["blocked", "pr_opened", "waiting_review", "changes_requested", "approved", "done"],
  blocked: ["queued", "in_progress", "pr_opened", "waiting_review", "done"],
  pr_opened: ["blocked", "waiting_review", "changes_requested", "approved", "done"],
  waiting_review: ["blocked", "changes_requested", "approved", "done"],
  changes_requested: ["blocked", "in_progress", "pr_opened", "waiting_review", "done"],
  approved: ["blocked", "changes_requested", "done"],
  done: [],
};

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
  return error.issues
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    .join("; ");
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeChildStateAlias(value: string): TaskLineageChildState | null {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return isTaskLineageChildState(normalized) ? normalized : null;
}

export function validateTaskLineage(input: unknown, source = "<task-lineage>"): TaskLineage {
  try {
    return TaskLineageSchema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid task lineage in ${source}: ${formatZodError(error)}`);
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
    throw new Error(`Failed to parse task lineage YAML in ${source}: ${message}`);
  }

  return validateTaskLineage(parsed, source);
}

export function readTaskLineageFile(filePath: string): TaskLineage {
  return parseTaskLineage(readFileSync(filePath, "utf-8"), filePath);
}

export function taskLineageToYaml(lineage: TaskLineage): string {
  return yamlStringify(validateTaskLineage(lineage), { indent: 2 });
}

export function writeTaskLineageFile(filePath: string, lineage: TaskLineage): void {
  const validated = validateTaskLineage(lineage, filePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, yamlStringify(validated, { indent: 2 }), "utf-8");
}

function resolveAuditTaskPlanPath(
  lineageFilePath: string,
  taskPlanPath: string,
  projectPath?: string,
): string {
  if (taskPlanPath.startsWith("/")) {
    return taskPlanPath;
  }
  if (projectPath) {
    return join(projectPath, taskPlanPath);
  }
  return join(dirname(lineageFilePath), taskPlanPath);
}

function createAuditFinding(
  finding: Omit<TaskLineageAuditFinding, "repaired"> & { repaired?: boolean },
): TaskLineageAuditFinding {
  return finding;
}

export function auditTaskLineageFile(
  filePath: string,
  options: TaskLineageAuditOptions = {},
): TaskLineageAuditResult {
  const findings: TaskLineageAuditFinding[] = [];
  const now = options.now ?? new Date().toISOString();
  let repaired = false;
  let rawParsed: unknown;

  try {
    rawParsed = parseYaml(readFileSync(filePath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      filePath,
      ok: false,
      repaired: false,
      lineage: null,
      findings: [
        createAuditFinding({
          code: "malformed_yaml",
          severity: "error",
          message: `Failed to parse task lineage YAML: ${message}`,
          repairable: false,
        }),
      ],
    };
  }

  const rawRecord = toRecord(rawParsed);
  if (!rawRecord) {
    return {
      filePath,
      ok: false,
      repaired: false,
      lineage: null,
      findings: [
        createAuditFinding({
          code: "invalid_top_level",
          severity: "error",
          message: "Lineage file must contain a YAML object at the top level.",
          repairable: false,
        }),
      ],
    };
  }

  const candidate: Record<string, unknown> = { ...rawRecord };

  if (candidate["version"] === undefined) {
    findings.push(
      createAuditFinding({
        code: "missing_version",
        severity: "warn",
        message: `Lineage file is missing version; expected ${TASK_LINEAGE_VERSION}.`,
        repairable: true,
      }),
    );
    if (options.repair) {
      candidate["version"] = TASK_LINEAGE_VERSION;
      repaired = true;
      findings[findings.length - 1]!.repaired = true;
    }
  }

  if (candidate["updatedAt"] === undefined) {
    findings.push(
      createAuditFinding({
        code: "missing_updated_at",
        severity: "warn",
        message: "Lineage file is missing updatedAt.",
        repairable: true,
      }),
    );
    if (options.repair) {
      candidate["updatedAt"] = now;
      repaired = true;
      findings[findings.length - 1]!.repaired = true;
    }
  }

  if (options.taskPlanPathOverride) {
    const existingTaskPlanPath =
      typeof candidate["taskPlanPath"] === "string" ? candidate["taskPlanPath"] : null;
    if (existingTaskPlanPath !== options.taskPlanPathOverride) {
      findings.push(
        createAuditFinding({
          code: "task_plan_override",
          severity: "info",
          message: `Using task plan path override ${options.taskPlanPathOverride}.`,
          repairable: true,
        }),
      );
      if (options.repair) {
        candidate["taskPlanPath"] = options.taskPlanPathOverride;
        repaired = true;
        findings[findings.length - 1]!.repaired = true;
      }
    }
  }

  const childIssues = Array.isArray(candidate["childIssues"]) ? candidate["childIssues"] : null;
  if (childIssues) {
    candidate["childIssues"] = childIssues.map((entry, index) => {
      const child = toRecord(entry);
      if (!child) return entry;
      if (typeof child["state"] !== "string") return entry;
      const normalized = normalizeChildStateAlias(child["state"]);
      if (!normalized || normalized === child["state"]) return entry;

      findings.push(
        createAuditFinding({
          code: "child_state_alias",
          severity: "warn",
          message: `childIssues[${index}].state uses legacy alias '${child["state"]}' and should be '${normalized}'.`,
          repairable: true,
        }),
      );
      if (!options.repair) return entry;

      repaired = true;
      findings[findings.length - 1]!.repaired = true;
      return { ...child, state: normalized };
    });
  }

  let lineage: TaskLineage;
  try {
    lineage = validateTaskLineage(candidate, filePath);
  } catch (error) {
    return {
      filePath,
      ok: false,
      repaired,
      lineage: null,
      findings: [
        ...findings,
        createAuditFinding({
          code: "invalid_schema",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          repairable: false,
        }),
      ],
    };
  }

  const taskPlanPath = options.taskPlanPathOverride ?? lineage.taskPlanPath;
  const resolvedTaskPlanPath = resolveAuditTaskPlanPath(filePath, taskPlanPath, options.projectPath);
  if (!existsSync(resolvedTaskPlanPath)) {
    findings.push(
      createAuditFinding({
        code: "task_plan_missing",
        severity: "error",
        message: `Referenced task plan does not exist: ${resolvedTaskPlanPath}`,
        repairable: false,
      }),
    );
  } else {
    try {
      const taskPlan = readTaskPlanFile(resolvedTaskPlanPath);

      if (lineage.parentIssue !== taskPlan.parentIssue) {
        findings.push(
          createAuditFinding({
            code: "parent_issue_drift",
            severity: "error",
            message: `Lineage parentIssue '${lineage.parentIssue}' does not match task plan parentIssue '${taskPlan.parentIssue}'.`,
            repairable: true,
          }),
        );
        if (options.repair) {
          lineage = validateTaskLineage(
            {
              ...lineage,
              parentIssue: taskPlan.parentIssue,
              updatedAt: now,
            },
            filePath,
          );
          repaired = true;
          findings[findings.length - 1]!.repaired = true;
        }
      }

      const expectedIndexes = new Set(taskPlan.childTasks.map((_, index) => index));
      const actualIndexes = new Set(lineage.childIssues.map((child) => child.taskIndex));

      const missingIndexes = [...expectedIndexes].filter((index) => !actualIndexes.has(index));
      if (missingIndexes.length > 0) {
        findings.push(
          createAuditFinding({
            code: "missing_child_refs",
            severity: "error",
            message: `Lineage is missing child issue references for task indexes: ${missingIndexes.join(", ")}.`,
            repairable: false,
          }),
        );
      }

      const extraIndexes = [...actualIndexes].filter((index) => !expectedIndexes.has(index));
      if (extraIndexes.length > 0) {
        findings.push(
          createAuditFinding({
            code: "extra_child_refs",
            severity: "error",
            message: `Lineage has child issue references for task indexes not present in the task plan: ${extraIndexes.join(", ")}.`,
            repairable: false,
          }),
        );
      }
    } catch (error) {
      findings.push(
        createAuditFinding({
          code: "task_plan_invalid",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          repairable: false,
        }),
      );
    }
  }

  if (options.repair && repaired) {
    writeTaskLineageFile(filePath, {
      ...lineage,
      taskPlanPath,
      updatedAt: now,
    });
    lineage = readTaskLineageFile(filePath);
  }

  return {
    filePath,
    ok: findings.every((finding) => finding.severity !== "error" || Boolean(finding.repaired)),
    repaired,
    lineage,
    findings,
  };
}

function listCandidateLineageFiles(projectPath: string): string[] {
  const roots = [join(projectPath, "docs", "plans"), join(projectPath, ".ao", "plans")];
  const results: string[] = [];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (entry.isFile() && /\.lineage\.ya?ml$/i.test(entry.name)) {
          results.push(fullPath);
        }
      }
    }
  }

  return results.sort();
}

export function findTaskLineageByParentIssue(
  projectPath: string,
  parentIssue: string,
): { filePath: string; lineage: TaskLineage } | null {
  for (const filePath of listCandidateLineageFiles(projectPath)) {
    try {
      const lineage = readTaskLineageFile(filePath);
      if (lineage.parentIssue === parentIssue) {
        return { filePath, lineage };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function findTaskLineageByChildIssue(
  projectPath: string,
  childIssueId: string,
): { filePath: string; lineage: TaskLineage; childIndex: number } | null {
  for (const filePath of listCandidateLineageFiles(projectPath)) {
    try {
      const lineage = readTaskLineageFile(filePath);
      const childIndex = lineage.childIssues.findIndex((child) => child.issueId === childIssueId);
      if (childIndex !== -1) {
        return { filePath, lineage, childIndex };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function normalizeLineageRef(ref: string): string {
  return ref.trim();
}

function matchesChildIssueRef(child: TaskLineageChildIssue, ref: string): boolean {
  const normalized = normalizeLineageRef(ref);
  return (
    child.issueId === normalized ||
    child.issueLabel === normalized ||
    (normalized.startsWith("#") && child.issueId === normalized.slice(1))
  );
}

function matchesChildPRRef(child: TaskLineageChildIssue, ref: string): boolean {
  if (!child.pr) return false;
  const normalized = normalizeLineageRef(ref);
  const normalizedNoHash = normalized.startsWith("#") ? normalized.slice(1) : normalized;
  return (
    child.pr.url === normalized ||
    child.pr.branch === normalized ||
    String(child.pr.number ?? "") === normalizedNoHash
  );
}

export function findTaskLineageByChildOrPRRef(
  projectPath: string,
  ref: string,
): { filePath: string; lineage: TaskLineage; childIndex: number; matchedBy: "issue" | "pr" } | null {
  for (const filePath of listCandidateLineageFiles(projectPath)) {
    try {
      const lineage = readTaskLineageFile(filePath);
      const issueIndex = lineage.childIssues.findIndex((child) => matchesChildIssueRef(child, ref));
      if (issueIndex !== -1) {
        return { filePath, lineage, childIndex: issueIndex, matchedBy: "issue" };
      }

      const prIndex = lineage.childIssues.findIndex((child) => matchesChildPRRef(child, ref));
      if (prIndex !== -1) {
        return { filePath, lineage, childIndex: prIndex, matchedBy: "pr" };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function findTaskLineageByPREvent(
  projectPath: string,
  opts: { prNumber?: number; branch?: string; prUrl?: string },
): { filePath: string; lineage: TaskLineage; childIndex: number; matchedBy: "pr" | "branch" } | null {
  for (const filePath of listCandidateLineageFiles(projectPath)) {
    try {
      const lineage = readTaskLineageFile(filePath);
      const childIndex = lineage.childIssues.findIndex((child) => {
        if (opts.prUrl && child.pr?.url === opts.prUrl) return true;
        if (opts.prNumber !== undefined && child.pr?.number === opts.prNumber) return true;
        if (opts.branch) {
          if (child.pr?.branch === opts.branch) return true;
          if (child.implementationSessions.some((session) => session.branch === opts.branch)) return true;
          if (child.reviewSessions.some((session) => session.branch === opts.branch)) return true;
        }
        return false;
      });
      if (childIndex !== -1) {
        const child = lineage.childIssues[childIndex];
        const matchedBy =
          (opts.prUrl && child?.pr?.url === opts.prUrl) ||
          (opts.prNumber !== undefined && child?.pr?.number === opts.prNumber) ||
          (opts.branch && child?.pr?.branch === opts.branch)
            ? "pr"
            : "branch";
        return { filePath, lineage, childIndex, matchedBy };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function findTaskLineageBySession(
  projectPath: string,
  sessionId: string,
): { filePath: string; lineage: TaskLineage; childIndex: number | null } | null {
  for (const filePath of listCandidateLineageFiles(projectPath)) {
    try {
      const lineage = readTaskLineageFile(filePath);
      if (lineage.planningSession?.sessionId === sessionId) {
        return { filePath, lineage, childIndex: null };
      }

      const childIndex = lineage.childIssues.findIndex(
        (child) =>
          child.implementationSessions.some((session) => session.sessionId === sessionId) ||
          child.reviewSessions.some((session) => session.sessionId === sessionId),
      );
      if (childIndex !== -1) {
        return { filePath, lineage, childIndex };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function dedupeSessionList(sessions: TaskLineageSession[], next: TaskLineageSession): TaskLineageSession[] {
  const filtered = sessions.filter((session) => session.sessionId !== next.sessionId);
  filtered.push(next);
  return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isTaskLineageChildState(value: string): value is TaskLineageChildState {
  return (TASK_LINEAGE_CHILD_STATES as readonly string[]).includes(value);
}

function nextStateFromPR(
  prState: string | undefined,
  child: TaskLineageChildIssue,
): TaskLineageChildState {
  const normalized = prState?.trim().toLowerCase();
  if (normalized === "approved") return "approved";
  if (normalized === "changes_requested") return "changes_requested";
  if (normalized === "merged" || normalized === "closed" || normalized === "done") return "done";
  return child.reviewSessions.length > 0 ? "waiting_review" : "pr_opened";
}

export function getAllowedTaskLineageChildStateTransitions(
  state: TaskLineageChildState,
): readonly TaskLineageChildState[] {
  return TASK_LINEAGE_CHILD_STATE_TRANSITIONS[state];
}

export function canTransitionTaskLineageChildState(
  from: TaskLineageChildState,
  to: TaskLineageChildState,
): boolean {
  return from === to || TASK_LINEAGE_CHILD_STATE_TRANSITIONS[from].includes(to);
}

function applyTaskLineageChildState(
  child: TaskLineageChildIssue,
  nextState: TaskLineageChildState,
): TaskLineageChildIssue {
  if (!canTransitionTaskLineageChildState(child.state, nextState)) {
    throw new Error(`Invalid task lineage child state transition: ${child.state} -> ${nextState}`);
  }
  return child.state === nextState ? child : { ...child, state: nextState };
}

function updateTaskLineageChild(
  match: { filePath: string; lineage: TaskLineage; childIndex: number },
  updater: (child: TaskLineageChildIssue) => TaskLineageChildIssue,
): TaskLineage {
  const child = match.lineage.childIssues[match.childIndex];
  const updatedChild = updater(child);
  const updated: TaskLineage = {
    ...match.lineage,
    updatedAt: new Date().toISOString(),
    childIssues: match.lineage.childIssues.map((entry, index) =>
      index === match.childIndex ? updatedChild : entry,
    ),
  };
  writeTaskLineageFile(match.filePath, updated);
  return updated;
}

function assertLineageBaseConsistency(
  existing: TaskLineage,
  incoming: {
    projectId?: string;
    parentIssue: string;
    taskPlanPath: string;
    trackerPlugin: string;
  },
  filePath: string,
): void {
  if (existing.parentIssue !== incoming.parentIssue) {
    throw new Error(
      `Refusing to overwrite task lineage at ${filePath}: existing parentIssue '${existing.parentIssue}' does not match '${incoming.parentIssue}'`,
    );
  }

  if (existing.taskPlanPath !== incoming.taskPlanPath) {
    throw new Error(
      `Refusing to overwrite task lineage at ${filePath}: existing taskPlanPath '${existing.taskPlanPath}' does not match '${incoming.taskPlanPath}'`,
    );
  }

  if (existing.trackerPlugin !== incoming.trackerPlugin) {
    throw new Error(
      `Refusing to overwrite task lineage at ${filePath}: existing trackerPlugin '${existing.trackerPlugin}' does not match '${incoming.trackerPlugin}'`,
    );
  }

  if (
    existing.projectId &&
    incoming.projectId &&
    existing.projectId !== incoming.projectId
  ) {
    throw new Error(
      `Refusing to overwrite task lineage at ${filePath}: existing projectId '${existing.projectId}' does not match '${incoming.projectId}'`,
    );
  }
}

function assertIncomingChildIssueIntegrity(
  existing: TaskLineage | null,
  childIssues: TaskLineageChildIssue[],
  filePath: string,
): void {
  const seenIssueIds = new Set<string>();
  const seenTaskIndexes = new Set<number>();

  for (const child of childIssues) {
    if (seenIssueIds.has(child.issueId)) {
      throw new Error(
        `Refusing to write task lineage at ${filePath}: duplicate child issueId '${child.issueId}'`,
      );
    }
    seenIssueIds.add(child.issueId);

    if (seenTaskIndexes.has(child.taskIndex)) {
      throw new Error(
        `Refusing to write task lineage at ${filePath}: duplicate child taskIndex '${child.taskIndex}'`,
      );
    }
    seenTaskIndexes.add(child.taskIndex);
  }

  if (!existing) return;

  for (const priorChild of existing.childIssues) {
    const stillPresent = childIssues.some(
      (child) => child.issueId === priorChild.issueId && child.taskIndex === priorChild.taskIndex,
    );
    if (!stillPresent) {
      throw new Error(
        `Refusing to overwrite task lineage at ${filePath}: missing child issue reference for existing taskIndex ${priorChild.taskIndex} (${priorChild.issueLabel})`,
      );
    }
  }
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

export function upsertTaskLineagePlanningSession(
  filePath: string,
  base: {
    projectId?: string;
    parentIssue: string;
    taskPlanPath: string;
    trackerPlugin: string;
    createdAt?: string;
  },
  planningSession: TaskLineageSession,
): TaskLineage {
  const existing = existsSync(filePath) ? readTaskLineageFile(filePath) : null;
  if (existing) {
    assertLineageBaseConsistency(existing, base, filePath);
  }
  const createdAt = existing?.createdAt ?? base.createdAt ?? new Date().toISOString();
  const lineage: TaskLineage = {
    version: TASK_LINEAGE_VERSION,
    projectId: base.projectId ?? existing?.projectId,
    parentIssue: base.parentIssue,
    taskPlanPath: base.taskPlanPath,
    trackerPlugin: base.trackerPlugin,
    createdAt,
    updatedAt: new Date().toISOString(),
    planningSession,
    childIssues: existing?.childIssues ?? [],
  };
  writeTaskLineageFile(filePath, lineage);
  return lineage;
}

export function mergeTaskLineageChildIssues(
  filePath: string,
  base: {
    projectId?: string;
    parentIssue: string;
    taskPlanPath: string;
    trackerPlugin: string;
    createdAt?: string;
  },
  childIssues: TaskLineageChildIssue[],
): TaskLineage {
  const existing = existsSync(filePath) ? readTaskLineageFile(filePath) : null;
  if (existing) {
    assertLineageBaseConsistency(existing, base, filePath);
  }
  assertIncomingChildIssueIntegrity(existing, childIssues, filePath);
  const createdAt = existing?.createdAt ?? base.createdAt ?? new Date().toISOString();
  const lineage: TaskLineage = {
    version: TASK_LINEAGE_VERSION,
    projectId: base.projectId ?? existing?.projectId,
    parentIssue: base.parentIssue,
    taskPlanPath: base.taskPlanPath,
    trackerPlugin: base.trackerPlugin,
    createdAt,
    updatedAt: new Date().toISOString(),
    planningSession: existing?.planningSession ?? null,
    childIssues: childIssues.map((child) => {
      const prior = existing?.childIssues.find((entry) => entry.issueId === child.issueId);
      return {
        ...child,
        state: prior?.state ?? child.state ?? "queued",
        implementationSessions: prior?.implementationSessions ?? child.implementationSessions ?? [],
        reviewSessions: prior?.reviewSessions ?? child.reviewSessions ?? [],
        pr: prior?.pr ?? child.pr ?? null,
      };
    }),
  };
  writeTaskLineageFile(filePath, lineage);
  return lineage;
}

export function createTaskLineageSessionRef(
  session: Pick<Session, "id" | "branch" | "workspacePath" | "createdAt">,
  role: string,
): TaskLineageSession {
  return {
    sessionId: session.id,
    role,
    branch: session.branch,
    worktreePath: session.workspacePath,
    createdAt: session.createdAt.toISOString(),
  };
}

export function recordTaskLineageChildSession(
  projectPath: string,
  childIssueId: string,
  kind: "implementation" | "review",
  session: TaskLineageSession,
): TaskLineage | null {
  const match = findTaskLineageByChildIssue(projectPath, childIssueId);
  if (!match) return null;

  return updateTaskLineageChild(match, (child) => {
    const withSessions: TaskLineageChildIssue = {
      ...child,
      implementationSessions:
        kind === "implementation"
          ? dedupeSessionList(child.implementationSessions, session)
          : child.implementationSessions,
      reviewSessions:
        kind === "review" ? dedupeSessionList(child.reviewSessions, session) : child.reviewSessions,
    };

    if (kind === "implementation") {
      return applyTaskLineageChildState(withSessions, "in_progress");
    }
    return applyTaskLineageChildState(withSessions, "waiting_review");
  });
}

export function recordTaskLineagePR(
  projectPath: string,
  sessionId: string,
  pr: Pick<PRInfo, "url" | "number" | "branch"> & { state?: string },
): TaskLineage | null {
  const match = findTaskLineageBySession(projectPath, sessionId);
  if (!match || match.childIndex === null) return null;
  const childMatch = { ...match, childIndex: match.childIndex };

  return updateTaskLineageChild(childMatch, (child) =>
    applyTaskLineageChildState(
      {
        ...child,
        pr: {
          number: pr.number,
          url: pr.url,
          branch: pr.branch,
          state: pr.state,
          updatedAt: new Date().toISOString(),
        },
      },
      nextStateFromPR(pr.state, child),
    ),
  );
}

export function transitionTaskLineageChildState(
  projectPath: string,
  childIssueId: string,
  nextState: TaskLineageChildState,
): TaskLineage | null {
  const match = findTaskLineageByChildIssue(projectPath, childIssueId);
  if (!match) return null;
  return updateTaskLineageChild(match, (child) => applyTaskLineageChildState(child, nextState));
}

export function updateTaskLineageTaskPlanPath(
  projectPath: string,
  parentIssue: string,
  nextTaskPlanPath: string,
): TaskLineage | null {
  const match = findTaskLineageByParentIssue(projectPath, parentIssue);
  if (!match) return null;

  const updated: TaskLineage = {
    ...match.lineage,
    taskPlanPath: normalizeText(nextTaskPlanPath),
    updatedAt: new Date().toISOString(),
  };
  writeTaskLineageFile(match.filePath, updated);
  return updated;
}

export function parseTaskLineageChildState(value: string): TaskLineageChildState {
  const normalized = value.trim().toLowerCase();
  if (!isTaskLineageChildState(normalized)) {
    throw new Error(
      `Unknown task lineage child state: ${value}. Expected one of: ${TASK_LINEAGE_CHILD_STATES.join(", ")}`,
    );
  }
  return normalized;
}
