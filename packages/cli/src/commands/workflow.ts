import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  createTaskLineageSessionRef,
  createPluginRegistry,
  findTaskLineageByChildOrPRRef,
  findTaskLineageByParentIssue,
  getAllowedTaskLineageChildStateTransitions,
  isTerminalSession,
  loadConfig,
  mergeTaskLineageChildIssues,
  parseTaskLineageChildState,
  readTaskLineageFile,
  taskPlanToYaml,
  type OrchestratorConfig,
  type ProjectConfig,
  type SessionManager,
  type TaskPlan,
  type TaskPlanChildTask,
  type TaskLineage,
  type TaskLineageChildIssue,
  type Tracker,
  summarizeTaskLineageStates,
  transitionTaskLineageChildState,
  upsertTaskLineagePlanningSession,
} from "@composio/ao-core";
import type { SCM, SCMReviewSubmission } from "@composio/ao-core/types";
import { readTaskPlanFile } from "@composio/ao-core/task-plan";
import {
  auditTaskLineageFile,
  type TaskLineageAuditFinding,
  updateTaskLineageTaskPlanPath,
} from "@composio/ao-core/task-lineage";
import { exec } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker } from "../lib/lifecycle-service.js";
import { runSpawnPreflight } from "./spawn.js";

const MAX_REFERENCE_FILES = 12;
const DEFAULT_TASK_PLAN_VERIFY_TIMEOUT_MS = 15_000;
const TASK_PLAN_VERIFY_POLL_MS = 500;
const TASK_PLAN_FILE_PATTERN = /\.task-plan\.ya?ml$/i;
const TASK_PLAN_SCAN_IGNORES = new Set([".git", "node_modules", "dist", "coverage", ".next"]);
const REVIEW_OUTCOMES = [
  "approve",
  "request_changes",
  "create_follow_up",
  "update_parent_summary",
] as const;

interface WorkflowImplementSkip {
  child: TaskLineageChildIssue;
  reason: string;
}

interface WorkflowReviewContext {
  lineagePath: string;
  lineage: TaskLineage;
  child: TaskLineageChildIssue;
  childTask: TaskPlanChildTask;
  taskPlan: TaskPlan;
  taskPlanPath: string;
  taskPlanFilePath: string;
  taskPlanRelocated: boolean;
  matchedBy: "issue" | "pr";
}

type WorkflowReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

function sanitizeIssueForPath(issueId: string): string {
  return issueId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workflow-plan";
}

function shouldIncludeReference(fileName: string): boolean {
  return /\.(md|mdx|txt)$/i.test(fileName);
}

function collectReferenceFiles(root: string, maxFiles = MAX_REFERENCE_FILES): string[] {
  const references: string[] = [];
  const candidates = [
    "README.md",
    "docs/specs",
    "docs/architecture",
    "docs/rfc",
    "docs/adr",
    "docs/adrs",
    "docs/design",
  ];

  function walk(path: string): void {
    if (references.length >= maxFiles || !existsSync(path)) return;

    const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    for (const entry of entries) {
      if (references.length >= maxFiles) return;
      const fullPath = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && shouldIncludeReference(entry.name)) {
        references.push(relative(root, fullPath));
      }
    }
  }

  for (const candidate of candidates) {
    if (references.length >= maxFiles) break;
    const fullPath = join(root, candidate);
    if (!existsSync(fullPath)) continue;
    const relativePath = relative(root, fullPath);
    if (relativePath === "README.md") {
      references.push(relativePath);
      continue;
    }
    walk(fullPath);
  }

  return references;
}

function defaultArtifactPath(projectPath: string, issueId: string): string {
  const slug = sanitizeIssueForPath(issueId);
  if (existsSync(join(projectPath, "docs"))) {
    return `docs/plans/${slug}.task-plan.yaml`;
  }
  return `.ao/plans/${slug}.task-plan.yaml`;
}

function defaultLineagePath(taskPlanPath: string): string {
  if (taskPlanPath.endsWith(".task-plan.yaml")) {
    return taskPlanPath.slice(0, -".task-plan.yaml".length) + ".lineage.yaml";
  }
  if (taskPlanPath.endsWith(".task-plan.yml")) {
    return taskPlanPath.slice(0, -".task-plan.yml".length) + ".lineage.yml";
  }
  if (taskPlanPath.endsWith(".yaml")) {
    return taskPlanPath.slice(0, -".yaml".length) + ".lineage.yaml";
  }
  if (taskPlanPath.endsWith(".yml")) {
    return taskPlanPath.slice(0, -".yml".length) + ".lineage.yml";
  }
  return `${taskPlanPath}.lineage.yaml`;
}

function resolveWorkflowLineagePath(
  project: ProjectConfig,
  parentIssue: string | undefined,
  explicitLineagePath?: string,
): string {
  if (explicitLineagePath) {
    return resolveProjectFilePath(project.path, explicitLineagePath);
  }

  if (!parentIssue) {
    throw new Error("Provide <parent-issue> or --lineage so AO knows which lineage file to audit.");
  }

  const match = findTaskLineageByParentIssue(project.path, parentIssue);
  if (!match) {
    throw new Error(
      `No readable lineage found for parent issue ${parentIssue}. Use --lineage <path> to inspect a specific file.`,
    );
  }
  return match.filePath;
}

function formatLineageAuditFinding(finding: TaskLineageAuditFinding): string {
  const symbol =
    finding.severity === "error" ? chalk.red("✗") : finding.severity === "warn" ? chalk.yellow("~") : chalk.cyan("i");
  const repairNote = finding.repaired
    ? chalk.green(" (repaired)")
    : finding.repairable
      ? chalk.dim(" (repairable)")
      : "";
  return `${symbol} ${finding.code}: ${finding.message}${repairNote}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForValidatedTaskPlanArtifact(
  sessionManager: SessionManager,
  sessionId: string,
  artifactPath: string,
  expectedParentIssue: string,
  timeoutMs: number,
): Promise<TaskPlan> {
  const deadline = Date.now() + timeoutMs;
  let lastValidationError: Error | null = null;

  while (Date.now() <= deadline) {
    if (existsSync(artifactPath)) {
      try {
        return readTaskPlanFile(artifactPath, { expectedParentIssue });
      } catch (error) {
        lastValidationError = error instanceof Error ? error : new Error(String(error));
      }
    }

    const currentSession = await sessionManager.get(sessionId).catch(() => null);
    if (!currentSession || isTerminalSession(currentSession)) {
      const state =
        currentSession !== null
          ? `${currentSession.status}${currentSession.activity ? `/${currentSession.activity}` : ""}`
          : "missing";
      if (lastValidationError) {
        throw new Error(
          `Planner session ${sessionId} ended before producing a valid task plan at ${artifactPath}: ${lastValidationError.message} (${state})`,
        );
      }
      throw new Error(
        `Planner session ${sessionId} ended before producing a valid task plan at ${artifactPath} (${state}).`,
      );
    }

    await sleep(TASK_PLAN_VERIFY_POLL_MS);
  }

  if (lastValidationError) {
    throw new Error(
      `Timed out waiting for a valid task plan at ${artifactPath}: ${lastValidationError.message}`,
    );
  }
  throw new Error(`Timed out waiting for planner artifact at ${artifactPath}.`);
}

function resolveProjectFilePath(projectPath: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(projectPath, filePath);
}

function toStoredProjectPath(projectPath: string, filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  const relativePath = relative(projectPath, filePath);
  return relativePath.startsWith("..") || isAbsolute(relativePath) ? filePath : relativePath;
}

function deriveSiblingTaskPlanPath(lineagePath: string): string | null {
  if (lineagePath.endsWith(".lineage.yaml")) {
    return lineagePath.slice(0, -".lineage.yaml".length) + ".task-plan.yaml";
  }
  if (lineagePath.endsWith(".lineage.yml")) {
    return lineagePath.slice(0, -".lineage.yml".length) + ".task-plan.yml";
  }
  return null;
}

function findTaskPlanCandidates(root: string): string[] {
  const matches: string[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (TASK_PLAN_SCAN_IGNORES.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && TASK_PLAN_FILE_PATTERN.test(entry.name)) {
        matches.push(fullPath);
      }
    }
  }

  walk(root);
  return matches;
}

function resolveTaskPlanFromLineage(
  projectId: string,
  project: ProjectConfig,
  lineagePath: string,
  lineage: TaskLineage,
): { taskPlan: TaskPlan; taskPlanPath: string; taskPlanFilePath: string; relocated: boolean } {
  const storedTaskPlanFilePath = resolveProjectFilePath(project.path, lineage.taskPlanPath);
  if (existsSync(storedTaskPlanFilePath)) {
    return {
      taskPlan: readTaskPlanFile(storedTaskPlanFilePath, {
        expectedParentIssue: lineage.parentIssue,
      }),
      taskPlanPath: lineage.taskPlanPath,
      taskPlanFilePath: storedTaskPlanFilePath,
      relocated: false,
    };
  }

  const candidatePaths = new Set<string>();
  const siblingTaskPlanPath = deriveSiblingTaskPlanPath(lineagePath);
  if (siblingTaskPlanPath) {
    candidatePaths.add(siblingTaskPlanPath);
  }
  for (const candidate of findTaskPlanCandidates(project.path)) {
    candidatePaths.add(candidate);
  }
  candidatePaths.delete(storedTaskPlanFilePath);

  const matches: { taskPlan: TaskPlan; taskPlanPath: string; taskPlanFilePath: string }[] = [];
  for (const candidatePath of candidatePaths) {
    try {
      const taskPlan = readTaskPlanFile(candidatePath, {
        expectedParentIssue: lineage.parentIssue,
      });
      matches.push({
        taskPlan,
        taskPlanPath: toStoredProjectPath(project.path, candidatePath),
        taskPlanFilePath: candidatePath,
      });
    } catch {
      continue;
    }
  }

  if (matches.length === 1) {
    const match = matches[0]!;
    return { ...match, relocated: true };
  }

  const relocateCommand = `ao workflow relocate-task-plan ${projectId} ${lineage.parentIssue} <new-path>`;
  if (matches.length > 1) {
    throw new Error(
      `Task plan ${lineage.taskPlanPath} for parent issue ${lineage.parentIssue} is missing, and multiple replacement task-plan files match this lineage. Run ${relocateCommand} to pin the correct path.`,
    );
  }

  throw new Error(
    `Task plan ${lineage.taskPlanPath} for parent issue ${lineage.parentIssue} could not be found. If the file was moved, run ${relocateCommand}.`,
  );
}

function buildChildIssueBody(
  taskPlan: TaskPlan,
  task: TaskPlanChildTask,
  tracker: Tracker,
  project: ProjectConfig,
): string {
  const lines: string[] = [];
  lines.push("## Parent Issue");
  lines.push(`- ID: ${taskPlan.parentIssue}`);
  lines.push(`- URL: ${tracker.issueUrl(taskPlan.parentIssue, project)}`);
  lines.push("");
  lines.push("## Task Summary");
  lines.push(task.summary);

  if (taskPlan.specPath) {
    lines.push("");
    lines.push("## Spec");
    lines.push(`- ${taskPlan.specPath}`);
  }

  if (taskPlan.adrPath) {
    lines.push("");
    lines.push("## ADR");
    lines.push(`- ${taskPlan.adrPath}`);
  }

  lines.push("");
  lines.push("## Acceptance Criteria");
  for (const item of task.acceptanceCriteria) {
    lines.push(`- ${item}`);
  }

  lines.push("");
  lines.push("## Dependencies");
  if (task.dependencies.length === 0) {
    lines.push("- None");
  } else {
    for (const dependency of task.dependencies) {
      lines.push(`- ${dependency}`);
    }
  }

  lines.push("");
  lines.push("## Suggested Files");
  if (task.suggestedFiles.length === 0) {
    lines.push("- None");
  } else {
    for (const file of task.suggestedFiles) {
      lines.push(`- ${file}`);
    }
  }

  lines.push("");
  lines.push("## Labels");
  if (task.labels.length === 0) {
    lines.push("- None");
  } else {
    for (const label of task.labels) {
      lines.push(`- ${label}`);
    }
  }

  return lines.join("\n");
}

function buildWorkflowReviewerPrompt(
  project: ProjectConfig,
  tracker: Tracker,
  reviewRole: string,
  context: WorkflowReviewContext,
): string {
  const lines: string[] = [];
  const { taskPlan, childTask, child, matchedBy } = context;

  lines.push("## Workflow Review");
  lines.push(`- Review role: ${reviewRole}`);
  lines.push(`- Match source: ${matchedBy}`);
  lines.push(`- Parent issue: ${taskPlan.parentIssue}`);
  lines.push(`- Parent URL: ${tracker.issueUrl(taskPlan.parentIssue, project)}`);
  lines.push(`- Child issue: ${child.issueLabel} (${child.issueId})`);
  lines.push(`- Child URL: ${child.issueUrl}`);
  lines.push(`- Current lineage state: ${child.state}`);
  lines.push(`- Lineage file: ${context.lineagePath}`);
  lines.push(`- Task plan: ${context.taskPlanPath}${context.taskPlanRelocated ? " (resolved after move)" : ""}`);

  if (child.pr) {
    lines.push(`- PR: ${child.pr.url}`);
    if (child.pr.branch) lines.push(`- PR branch: ${child.pr.branch}`);
    if (child.pr.state) lines.push(`- PR state: ${child.pr.state}`);
  }

  lines.push("");
  lines.push("## Task Summary");
  lines.push(childTask.summary);

  lines.push("");
  lines.push("## Acceptance Criteria");
  for (const item of childTask.acceptanceCriteria) {
    lines.push(`- ${item}`);
  }

  lines.push("");
  lines.push("## Dependencies");
  if (childTask.dependencies.length === 0) {
    lines.push("- None");
  } else {
    for (const dependency of childTask.dependencies) {
      lines.push(`- ${dependency}`);
    }
  }

  lines.push("");
  lines.push("## Suggested Files");
  if (childTask.suggestedFiles.length === 0) {
    lines.push("- None");
  } else {
    for (const file of childTask.suggestedFiles) {
      lines.push(`- ${file}`);
    }
  }

  if (taskPlan.specPath) {
    lines.push("");
    lines.push("## Spec");
    lines.push(`- ${taskPlan.specPath}`);
  }

  if (taskPlan.adrPath) {
    lines.push("");
    lines.push("## ADR");
    lines.push(`- ${taskPlan.adrPath}`);
  }

  lines.push("");
  lines.push("## Existing Sessions");
  lines.push(
    `- Implementation: ${
      child.implementationSessions.map((session) => session.sessionId).join(", ") || "None"
    }`,
  );
  lines.push(
    `- Review: ${child.reviewSessions.map((session) => session.sessionId).join(", ") || "None"}`,
  );

  lines.push("");
  lines.push("## Review Instructions");
  lines.push("- Review the implementation against the acceptance criteria and referenced design docs.");
  lines.push("- Inspect the PR when present; otherwise review the current branch/worktree for the child issue.");
  lines.push("- Call out concrete defects, regressions, and missing tests before any summary.");
  lines.push("- End with one explicit outcome: approved, changes_requested, blocked, or done.");

  return lines.join("\n");
}

async function getTrackerForProject(
  config: OrchestratorConfig,
  project: ProjectConfig,
  opts?: { requireCreateIssue?: boolean; requireUpdateIssue?: boolean },
): Promise<Tracker> {
  if (!project.tracker) {
    throw new Error("No tracker configured for this project.");
  }

  const registry = createPluginRegistry();
  await registry.loadFromConfig(config, (pkg: string) => import(pkg));
  const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
  if (!tracker) {
    throw new Error(`Tracker plugin "${project.tracker.plugin}" not found.`);
  }
  if (opts?.requireCreateIssue && !tracker.createIssue) {
    throw new Error(`Tracker plugin "${project.tracker.plugin}" does not support issue creation.`);
  }
  if (opts?.requireUpdateIssue && !tracker.updateIssue) {
    throw new Error(`Tracker plugin "${project.tracker.plugin}" does not support issue updates.`);
  }
  return tracker;
}

async function getSCMForProject(
  config: OrchestratorConfig,
  project: ProjectConfig,
  opts?: { requirePublishReview?: boolean },
): Promise<SCM | null> {
  if (!project.scm) {
    if (opts?.requirePublishReview) {
      throw new Error("No SCM configured for this project.");
    }
    return null;
  }

  const registry = createPluginRegistry();
  await registry.loadFromConfig(config, (pkg: string) => import(pkg));
  const scm = registry.get<SCM>("scm", project.scm.plugin);
  if (!scm) {
    throw new Error(`SCM plugin "${project.scm.plugin}" not found.`);
  }
  if (opts?.requirePublishReview && !scm.publishReview) {
    throw new Error(`SCM plugin "${project.scm.plugin}" does not support review publishing.`);
  }
  return scm;
}

function parsePositiveIntegerOption(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

function parseWorkflowReviewOutcome(value: string): WorkflowReviewOutcome {
  const normalized = value.trim().toLowerCase();
  if ((REVIEW_OUTCOMES as readonly string[]).includes(normalized)) {
    return normalized as WorkflowReviewOutcome;
  }
  throw new Error(
    `Unknown review outcome: ${value}. Expected one of: ${REVIEW_OUTCOMES.join(", ")}`,
  );
}

function buildWorkflowReviewSummaryComment(
  outcome: WorkflowReviewOutcome,
  summary: string,
  context: WorkflowReviewContext,
): string {
  const lines: string[] = [];
  lines.push("## Workflow Review Outcome");
  lines.push(`- Outcome: ${outcome}`);
  lines.push(`- Parent issue: ${context.taskPlan.parentIssue}`);
  lines.push(`- Child issue: ${context.child.issueLabel}`);
  if (context.child.pr?.url) {
    lines.push(`- PR: ${context.child.pr.url}`);
  }
  lines.push("");
  lines.push(summary.trim());
  return lines.join("\n");
}

function toSCMReviewSubmission(
  outcome: WorkflowReviewOutcome,
  summary: string,
): SCMReviewSubmission | null {
  switch (outcome) {
    case "approve":
      return { outcome: "approve", summary };
    case "request_changes":
      return { outcome: "request_changes", summary };
    default:
      return null;
  }
}

async function maybePublishWorkflowReviewToSCM(
  config: OrchestratorConfig,
  project: ProjectConfig,
  pr:
    | {
        url: string;
        number?: number;
        branch: string | null;
      }
    | null,
  outcome: WorkflowReviewOutcome,
  summary: string,
): Promise<boolean> {
  if (!pr) return false;

  const review = toSCMReviewSubmission(outcome, summary);
  if (!review) return false;

  const scm = await getSCMForProject(config, project);
  if (!scm?.publishReview) return false;

  let resolvedPR = pr as Parameters<NonNullable<SCM["publishReview"]>>[0];
  const missingPRFields =
    !("title" in resolvedPR) ||
    !("owner" in resolvedPR) ||
    !("repo" in resolvedPR) ||
    !("baseBranch" in resolvedPR) ||
    !("isDraft" in resolvedPR);

  if (missingPRFields) {
    if (!scm.resolvePR) return false;
    const reference = pr.url || (pr.number !== undefined ? String(pr.number) : pr.branch);
    if (!reference) return false;
    resolvedPR = await scm.resolvePR(reference, project);
  }

  await scm.publishReview(resolvedPR, review);
  return true;
}

function buildParentSummaryComment(summary: string, context: WorkflowReviewContext): string {
  const lines: string[] = [];
  lines.push("## Workflow Parent Summary Update");
  lines.push(`- Parent issue: ${context.taskPlan.parentIssue}`);
  lines.push(`- Child issue: ${context.child.issueLabel}`);
  if (context.child.pr?.url) {
    lines.push(`- PR: ${context.child.pr.url}`);
  }
  lines.push("");
  lines.push(summary.trim());
  return lines.join("\n");
}

function buildRequestedChangesPrompt(summary: string, context: WorkflowReviewContext): string {
  const lines: string[] = [];
  lines.push("## Review Outcome");
  lines.push(`- Parent issue: ${context.taskPlan.parentIssue}`);
  lines.push(`- Child issue: ${context.child.issueLabel} (${context.child.issueId})`);
  if (context.child.pr?.url) {
    lines.push(`- PR: ${context.child.pr.url}`);
  }
  lines.push("");
  lines.push("## Requested Changes");
  lines.push(summary.trim());
  lines.push("");
  lines.push("Please address the requested changes and continue the implementation workflow.");
  return lines.join("\n");
}

function requireOptionText(value: string | undefined, optionName: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${optionName} is required.`);
  }
  return normalized;
}

function buildFollowUpTask(
  context: WorkflowReviewContext,
  title: string,
  summary: string,
): TaskPlanChildTask {
  return {
    title,
    summary: `Follow-up from review of ${context.child.issueLabel}: ${summary.trim()}`,
    acceptanceCriteria: [
      `Address the follow-up work raised during review of ${context.child.issueLabel}.`,
      summary.trim(),
    ],
    dependencies: [context.child.title],
    suggestedFiles: [...context.childTask.suggestedFiles],
    labels: [...new Set([...context.childTask.labels, "follow-up"])],
  };
}

function buildWorkflowPlannerPrompt(
  parentIssue: string,
  plannerRole: string,
  artifactPath: string,
  references: string[],
): string {
  const sections: string[] = [];

  sections.push("## Workflow Planning");
  sections.push(`- Parent issue: ${parentIssue}`);
  sections.push(`- Workflow role: ${plannerRole}`);
  sections.push(`- Produce a structured YAML task plan artifact at: ${artifactPath}`);

  sections.push("");
  sections.push("## Task Plan Schema");
  sections.push("Write YAML only. Do not save Markdown prose in the artifact.");
  sections.push("Use this exact schema:");
  sections.push("```yaml");
  sections.push("version: 1");
  sections.push(`parentIssue: ${parentIssue}`);
  sections.push("specPath: docs/specs/example-spec.md # or null");
  sections.push("adrPath: docs/adr/0001-example.md # or null");
  sections.push("childTasks:");
  sections.push("  - title: Define the task slice");
  sections.push("    summary: Short explanation of the work and why it matters.");
  sections.push("    acceptanceCriteria:");
  sections.push("      - Concrete, testable outcome");
  sections.push("    dependencies: []");
  sections.push("    suggestedFiles:");
  sections.push("      - src/example.ts");
  sections.push("    labels:");
  sections.push("      - backend");
  sections.push("```");

  sections.push("");
  sections.push("## Task Plan Rules");
  sections.push("- Every child task must include title, summary, acceptanceCriteria, dependencies, suggestedFiles, and labels.");
  sections.push("- Use repo-relative paths for specPath, adrPath, and suggestedFiles.");
  sections.push("- Use null for specPath or adrPath when there is no applicable document.");
  sections.push("- Keep dependencies, suggestedFiles, and labels present even when empty.");
  sections.push("- Break the parent issue into concrete child tasks that can be implemented and reviewed independently.");

  if (references.length > 0) {
    sections.push("");
    sections.push("## Suggested References");
    for (const ref of references) {
      sections.push(`- ${ref}`);
    }
  }

  sections.push("");
  sections.push(
    "Leave the repository with the YAML task-plan artifact saved, then summarize the recommended execution plan in your final session response.",
  );

  return sections.join("\n");
}

function resolveWorkflowLineageChild(project: ProjectConfig, ref: string): {
  lineagePath: string;
  lineage: TaskLineage;
  child: TaskLineageChildIssue;
  matchedBy: "issue" | "pr";
} {
  const match = findTaskLineageByChildOrPRRef(project.path, ref);
  if (!match) {
    throw new Error(`No workflow lineage child issue found for ref ${ref}.`);
  }

  const child = match.lineage.childIssues[match.childIndex];
  if (!child) {
    throw new Error(`No child issue found for ref ${ref}.`);
  }

  return {
    lineagePath: match.filePath,
    lineage: match.lineage,
    child,
    matchedBy: match.matchedBy,
  };
}

function resolveWorkflowReviewContext(
  projectId: string,
  project: ProjectConfig,
  ref: string,
): WorkflowReviewContext {
  const match = resolveWorkflowLineageChild(project, ref);
  const resolvedTaskPlan = resolveTaskPlanFromLineage(
    projectId,
    project,
    match.lineagePath,
    match.lineage,
  );
  const taskPlan = resolvedTaskPlan.taskPlan;
  const childTask = taskPlan.childTasks[match.child.taskIndex];
  if (!childTask) {
    throw new Error(
      `Task plan ${resolvedTaskPlan.taskPlanPath} is missing child task index ${match.child.taskIndex}.`,
    );
  }

  return {
    lineagePath: match.lineagePath,
    lineage: match.lineage,
    child: match.child,
    childTask,
    taskPlan,
    taskPlanPath: resolvedTaskPlan.taskPlanPath,
    taskPlanFilePath: resolvedTaskPlan.taskPlanFilePath,
    taskPlanRelocated: resolvedTaskPlan.relocated,
    matchedBy: match.matchedBy,
  };
}

async function routeRequestedChangesToImplementer(
  config: OrchestratorConfig,
  projectId: string,
  childIssueRole: string,
  context: WorkflowReviewContext,
  summary: string,
): Promise<{ action: "sent" | "spawned"; sessionId: string }> {
  const sm = await getSessionManager(config);
  const activeSessions = await sm.list(projectId);
  const existingImplementer = activeSessions.find((session) => {
    if (session.projectId !== projectId || session.issueId !== context.child.issueId) {
      return false;
    }
    const role = session.metadata?.["role"];
    return typeof role === "string" ? role === childIssueRole : true;
  });
  const prompt = buildRequestedChangesPrompt(summary, context);

  if (existingImplementer) {
    await sm.send(existingImplementer.id, prompt);
    return { action: "sent", sessionId: existingImplementer.id };
  }

  await runSpawnPreflight(config, projectId);
  await ensureLifecycleWorker(config, projectId);
  const session = await sm.spawn({
    projectId,
    issueId: context.child.issueId,
    role: childIssueRole,
    prompt,
  });
  return { action: "spawned", sessionId: session.id };
}

export function registerWorkflow(program: Command): void {
  const workflow = program.command("workflow").description("Workflow-oriented helper commands");

  workflow
    .command("plan")
    .description("Spawn the configured planner role for a parent issue")
    .argument("<project>", "Project ID from config")
    .argument("<parent-issue>", "Parent issue identifier to plan")
    .option("--artifact <path>", "Artifact path for the structured plan output")
    .option(
      "--artifact-timeout-ms <ms>",
      "Wait up to this long for a valid task-plan artifact",
      String(DEFAULT_TASK_PLAN_VERIFY_TIMEOUT_MS),
    )
    .option("--no-verify-artifact", "Return immediately after spawning the planner session")
    .option("--open", "Open session in terminal tab")
    .action(
      async (
        projectId: string,
        parentIssue: string,
        opts: { artifact?: string; artifactTimeoutMs?: string; verifyArtifact?: boolean; open?: boolean },
      ) => {
        const config = loadConfig();
        const project = config.projects[projectId];
        if (!project) {
          console.error(
            chalk.red(
              `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
            ),
          );
          process.exit(1);
        }

        const workflowKey = project.workflow;
        const workflowConfig = workflowKey ? config.workflow?.[workflowKey] : undefined;
        const plannerRole = workflowConfig?.parentIssueRole;
        if (!workflowKey || !workflowConfig || !plannerRole) {
          console.error(
            chalk.red(
              `Project ${projectId} is missing workflow.parentIssueRole configuration for workflow planning.`,
            ),
          );
          process.exit(1);
        }

        const artifactPath = opts.artifact ?? defaultArtifactPath(project.path, parentIssue);
        const artifactFullPath = resolveProjectFilePath(project.path, artifactPath);
        const lineagePath = defaultLineagePath(artifactPath);
        const references = collectReferenceFiles(project.path);
        const prompt = buildWorkflowPlannerPrompt(
          parentIssue,
          plannerRole,
          artifactPath,
          references,
        );

        const spinner = ora("Creating workflow planner session").start();

        try {
          await runSpawnPreflight(config, projectId);
          await ensureLifecycleWorker(config, projectId);

          const sm = await getSessionManager(config);
          spinner.text = "Spawning workflow planner session";

          const session = await sm.spawn({
            projectId,
            issueId: parentIssue,
            role: plannerRole,
            prompt,
          });

          upsertTaskLineagePlanningSession(
            resolveProjectFilePath(project.path, lineagePath),
            {
              projectId,
              parentIssue,
              taskPlanPath: artifactPath,
              trackerPlugin: project.tracker?.plugin ?? "unknown",
            },
            createTaskLineageSessionRef(session, plannerRole),
          );

          let validatedTaskPlan: TaskPlan | null = null;
          if (opts.verifyArtifact !== false) {
            spinner.text = "Waiting for valid workflow task-plan artifact";
            const artifactTimeoutMs = parsePositiveIntegerOption(
              opts.artifactTimeoutMs ?? String(DEFAULT_TASK_PLAN_VERIFY_TIMEOUT_MS),
              "--artifact-timeout-ms",
            );
            validatedTaskPlan = await waitForValidatedTaskPlanArtifact(
              sm,
              session.id,
              artifactFullPath,
              parentIssue,
              artifactTimeoutMs,
            );
          }

          spinner.succeed(`Planner session ${chalk.green(session.id)} created`);
          console.log(`  Role:     ${chalk.dim(plannerRole)}`);
          console.log(`  Artifact: ${chalk.dim(artifactPath)}`);
          if (validatedTaskPlan) {
            console.log(
              `  Validate: ${chalk.dim(`ok (${validatedTaskPlan.childTasks.length} child task${validatedTaskPlan.childTasks.length === 1 ? "" : "s"})`)}`,
            );
          } else if (opts.verifyArtifact === false) {
            console.log(`  Validate: ${chalk.dim("skipped (--no-verify-artifact)")}`);
          }
          console.log(`  Worktree: ${chalk.dim(session.workspacePath ?? "-")}`);
          if (session.branch) console.log(`  Branch:   ${chalk.dim(session.branch)}`);
          console.log(`  Attach:   ${chalk.dim(`tmux attach -t ${session.runtimeHandle?.id ?? session.id}`)}`);
          if (references.length > 0) {
            console.log(`  Refs:     ${chalk.dim(references.join(", "))}`);
          }
          console.log();
          console.log(`SESSION=${session.id}`);

          if (opts.open) {
            try {
              await exec("open-iterm-tab", [session.runtimeHandle?.id ?? session.id]);
            } catch {
              // Terminal plugin not available
            }
          }
        } catch (err) {
          spinner.fail("Failed to create workflow planner session");
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
      },
    );

  workflow
    .command("validate-plan")
    .description("Validate a structured workflow task-plan YAML file")
    .argument("<file>", "Path to a task-plan YAML file")
    .action((filePath: string) => {
      try {
        const taskPlan = readTaskPlanFile(filePath);
        console.log(chalk.green(`Valid task plan: ${filePath}`));
        console.log(`  Parent issue: ${chalk.dim(taskPlan.parentIssue)}`);
        console.log(`  Child tasks:  ${chalk.dim(String(taskPlan.childTasks.length))}`);
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  workflow
    .command("create-issues")
    .description("Create child tracker issues from a structured task-plan YAML file")
    .argument("<project>", "Project ID from config")
    .argument("<plan-file>", "Path to a task-plan YAML file")
    .option("--lineage <path>", "Output path for the lineage artifact")
    .action(async (projectId: string, taskPlanPath: string, opts: { lineage?: string }) => {
      const config = loadConfig();
      const project = config.projects[projectId];
      if (!project) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      const trackerPlugin = project.tracker?.plugin;
      const lineagePath = opts.lineage ?? defaultLineagePath(taskPlanPath);
      const resolvedLineagePath = resolveProjectFilePath(project.path, lineagePath);
      const spinner = ora("Creating child issues from task plan").start();

      try {
        const taskPlan = readTaskPlanFile(resolveProjectFilePath(project.path, taskPlanPath));
        const tracker = await getTrackerForProject(config, project, { requireCreateIssue: true });
        const createdChildren: TaskLineageChildIssue[] = [];

        for (const [taskIndex, childTask] of taskPlan.childTasks.entries()) {
          spinner.text = `Creating issue ${taskIndex + 1}/${taskPlan.childTasks.length}`;
          const createdIssue = await tracker.createIssue!(
            {
              title: childTask.title,
              description: buildChildIssueBody(taskPlan, childTask, tracker, project),
              labels: [...childTask.labels],
              parentIssueId: taskPlan.parentIssue,
            },
            project,
          );

          createdChildren.push({
            taskIndex,
            title: childTask.title,
            issueId: createdIssue.id,
            issueUrl: createdIssue.url,
            issueLabel: tracker.issueLabel?.(createdIssue.url, project) ?? createdIssue.id,
            labels: [...childTask.labels],
            dependencies: [...childTask.dependencies],
            state: "queued",
            implementationSessions: [],
            reviewSessions: [],
            pr: null,
          });
        }

        mergeTaskLineageChildIssues(
          resolvedLineagePath,
          {
            projectId,
            parentIssue: taskPlan.parentIssue,
            taskPlanPath,
            trackerPlugin: trackerPlugin ?? tracker.name,
          },
          createdChildren,
        );

        spinner.succeed(`Created ${chalk.green(String(createdChildren.length))} child issues`);
        console.log(`  Parent:  ${chalk.dim(taskPlan.parentIssue)}`);
        console.log(`  Tracker: ${chalk.dim(trackerPlugin ?? tracker.name)}`);
        console.log(`  Lineage: ${chalk.dim(lineagePath)}`);
        for (const child of createdChildren) {
          console.log(`  ${chalk.green("✓")} ${child.issueLabel} ${chalk.dim(child.title)}`);
        }
      } catch (err) {
        spinner.fail("Failed to create child issues from task plan");
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  workflow
    .command("implement")
    .description("Spawn implementation sessions for eligible child issues")
    .argument("<project>", "Project ID from config")
    .argument("<parent-issue>", "Parent issue identifier")
    .option(
      "--concurrency <count>",
      "Maximum active implementation sessions allowed for this parent issue",
    )
    .action(
      async (projectId: string, parentIssue: string, opts: { concurrency?: string }) => {
        const config = loadConfig();
        const project = config.projects[projectId];
        if (!project) {
          console.error(
            chalk.red(
              `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
            ),
          );
          process.exit(1);
        }

        const workflowKey = project.workflow;
        const workflowConfig = workflowKey ? config.workflow?.[workflowKey] : undefined;
        const childIssueRole = workflowConfig?.childIssueRole;
        if (!workflowKey || !workflowConfig || !childIssueRole) {
          console.error(
            chalk.red(
              `Project ${projectId} is missing workflow.childIssueRole configuration for workflow implementation.`,
            ),
          );
          process.exit(1);
        }

        const lineageMatch = findTaskLineageByParentIssue(project.path, parentIssue);
        if (!lineageMatch) {
          console.error(chalk.red(`No lineage found for parent issue ${parentIssue}.`));
          process.exit(1);
        }

        const spinner = ora("Resolving child issues for workflow implementation").start();

        try {
          const concurrencyLimit = opts.concurrency
            ? parsePositiveIntegerOption(opts.concurrency, "--concurrency")
            : Number.POSITIVE_INFINITY;
          const tracker = await getTrackerForProject(config, project);
          const sm = await getSessionManager(config);
          const activeSessions = await sm.list(projectId);
          const activeSessionsByIssue = new Map<string, typeof activeSessions>();

          for (const session of activeSessions) {
            if (session.projectId !== projectId || !session.issueId) continue;
            const existing = activeSessionsByIssue.get(session.issueId) ?? [];
            existing.push(session);
            activeSessionsByIssue.set(session.issueId, existing);
          }

          const skipped: WorkflowImplementSkip[] = [];
          const spawnTargets: TaskLineageChildIssue[] = [];
          const activeChildIssues = lineageMatch.lineage.childIssues.filter(
            (child) => (activeSessionsByIssue.get(child.issueId)?.length ?? 0) > 0,
          ).length;
          const availableSlots = Number.isFinite(concurrencyLimit)
            ? Math.max(0, concurrencyLimit - activeChildIssues)
            : Number.POSITIVE_INFINITY;

          for (const child of lineageMatch.lineage.childIssues) {
            const activeForChild = activeSessionsByIssue.get(child.issueId) ?? [];
            if (activeForChild.length > 0) {
              skipped.push({
                child,
                reason: `already in progress (${activeForChild.map((session) => session.id).join(", ")})`,
              });
              continue;
            }

            if (await tracker.isCompleted(child.issueId, project)) {
              transitionTaskLineageChildState(project.path, child.issueId, "done");
              skipped.push({ child, reason: "already completed" });
              continue;
            }

            if (spawnTargets.length >= availableSlots) {
              skipped.push({ child, reason: "concurrency limit reached" });
              continue;
            }

            spawnTargets.push(child);
          }

          if (spawnTargets.length === 0) {
            spinner.succeed("No implementation sessions started");
            console.log(chalk.bold(`Workflow implementation for ${parentIssue}`));
            console.log(`  Role:        ${chalk.dim(childIssueRole)}`);
            console.log(`  Lineage:     ${chalk.dim(lineageMatch.filePath)}`);
            console.log(`  Child issues:${chalk.dim(` ${lineageMatch.lineage.childIssues.length}`)}`);
            console.log(`  Started:     ${chalk.dim("0")}`);
            console.log(`  Skipped:     ${chalk.dim(String(skipped.length))}`);
            for (const item of skipped) {
              console.log(`  ${chalk.yellow("~")} ${item.child.issueLabel} ${chalk.dim(item.reason)}`);
            }
            return;
          }

          spinner.text = `Starting ${spawnTargets.length} implementation session(s)`;
          await runSpawnPreflight(config, projectId);
          await ensureLifecycleWorker(config, projectId);

          const started = await Promise.all(
            spawnTargets.map(async (child) => ({
              child,
              session: await sm.spawn({
                projectId,
                issueId: child.issueId,
                role: childIssueRole,
              }),
            })),
          );

          spinner.succeed(`Started ${chalk.green(String(started.length))} implementation session(s)`);
          console.log(chalk.bold(`Workflow implementation for ${parentIssue}`));
          console.log(`  Role:        ${chalk.dim(childIssueRole)}`);
          console.log(`  Lineage:     ${chalk.dim(lineageMatch.filePath)}`);
          if (Number.isFinite(concurrencyLimit)) {
            console.log(
              `  Concurrency: ${chalk.dim(`${Math.min(concurrencyLimit, activeChildIssues + started.length)}/${concurrencyLimit}`)}`,
            );
          }
          for (const item of started) {
            console.log(
              `  ${chalk.green("✓")} ${item.child.issueLabel} ${chalk.dim(item.child.title)} -> ${chalk.dim(item.session.id)}`,
            );
          }
          for (const item of skipped) {
            console.log(`  ${chalk.yellow("~")} ${item.child.issueLabel} ${chalk.dim(item.reason)}`);
          }
        } catch (err) {
          spinner.fail("Failed to start workflow implementation sessions");
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
      },
    );

  workflow
    .command("review")
    .description("Spawn the configured reviewer role for a child issue or PR in workflow lineage")
    .argument("<project>", "Project ID from config")
    .argument("<pr-or-issue-ref>", "Child issue ref, issue label, PR number, PR URL, or PR branch")
    .option("--open", "Open session in terminal tab")
    .action(
      async (
        projectId: string,
        ref: string,
        opts: { open?: boolean },
      ) => {
        const config = loadConfig();
        const project = config.projects[projectId];
        if (!project) {
          console.error(
            chalk.red(
              `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
            ),
          );
          process.exit(1);
        }

        const workflowKey = project.workflow;
        const workflowConfig = workflowKey ? config.workflow?.[workflowKey] : undefined;
        const reviewRole = workflowConfig?.reviewRole;
        if (!workflowKey || !workflowConfig || !reviewRole) {
          console.error(
            chalk.red(
              `Project ${projectId} is missing workflow.reviewRole configuration for workflow review.`,
            ),
          );
          process.exit(1);
        }

        const spinner = ora("Resolving workflow review target").start();

        try {
          const tracker = await getTrackerForProject(config, project);
          const context = resolveWorkflowReviewContext(projectId, project, ref);
          if (context.child.state === "done") {
            throw new Error(`Child issue ${context.child.issueLabel} is already marked done.`);
          }

          const prompt = buildWorkflowReviewerPrompt(project, tracker, reviewRole, context);
          await runSpawnPreflight(config, projectId);
          await ensureLifecycleWorker(config, projectId);

          const sm = await getSessionManager(config);
          spinner.text = `Spawning reviewer session for ${context.child.issueLabel}`;
          const session = await sm.spawn({
            projectId,
            issueId: context.child.issueId,
            role: reviewRole,
            prompt,
          });

          spinner.succeed(`Reviewer session ${chalk.green(session.id)} created`);
          console.log(`  Parent:    ${chalk.dim(context.taskPlan.parentIssue)}`);
          console.log(`  Child:     ${chalk.dim(`${context.child.issueLabel} ${context.child.title}`)}`);
          console.log(`  Match:     ${chalk.dim(context.matchedBy)}`);
          console.log(`  Role:      ${chalk.dim(reviewRole)}`);
          console.log(`  State:     ${chalk.dim(context.child.state)}`);
          console.log(`  Lineage:   ${chalk.dim(context.lineagePath)}`);
          console.log(
            `  Task plan: ${chalk.dim(context.taskPlanPath)}${context.taskPlanRelocated ? chalk.dim(" (resolved)") : ""}`,
          );
          if (context.taskPlan.specPath) {
            console.log(`  Spec:      ${chalk.dim(context.taskPlan.specPath)}`);
          }
          if (context.taskPlan.adrPath) {
            console.log(`  ADR:       ${chalk.dim(context.taskPlan.adrPath)}`);
          }
          if (context.child.pr?.url) {
            console.log(`  PR:        ${chalk.dim(context.child.pr.url)}`);
          }
          console.log(`  Worktree:  ${chalk.dim(session.workspacePath ?? "-")}`);
          if (session.branch) console.log(`  Branch:    ${chalk.dim(session.branch)}`);
          console.log(`  Attach:    ${chalk.dim(`tmux attach -t ${session.runtimeHandle?.id ?? session.id}`)}`);
          console.log();
          console.log(`SESSION=${session.id}`);

          if (opts.open) {
            try {
              await exec("open-iterm-tab", [session.runtimeHandle?.id ?? session.id]);
            } catch {
              // Terminal plugin not available
            }
          }
        } catch (err) {
          spinner.fail("Failed to create workflow reviewer session");
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
      },
    );

  workflow
    .command("review-outcome")
    .description("Record a reviewer outcome for a workflow child issue or PR")
    .argument("<project>", "Project ID from config")
    .argument("<pr-or-issue-ref>", "Child issue ref, issue label, PR number, PR URL, or PR branch")
    .requiredOption(
      "--outcome <outcome>",
      `Review outcome: ${REVIEW_OUTCOMES.join(", ")}`,
      parseWorkflowReviewOutcome,
    )
    .requiredOption("--summary <text>", "Reviewer summary for the selected outcome")
    .option("--follow-up-title <title>", "Title for a follow-up child task when outcome=create_follow_up")
    .action(
      async (
        projectId: string,
        ref: string,
        opts: { outcome: WorkflowReviewOutcome; summary: string; followUpTitle?: string },
      ) => {
        const config = loadConfig();
        const project = config.projects[projectId];
        if (!project) {
          console.error(
            chalk.red(
              `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
            ),
          );
          process.exit(1);
        }

        const workflowKey = project.workflow;
        const workflowConfig = workflowKey ? config.workflow?.[workflowKey] : undefined;
        const childIssueRole = workflowConfig?.childIssueRole;
        if (!workflowKey || !workflowConfig || !childIssueRole) {
          console.error(
            chalk.red(
              `Project ${projectId} is missing workflow.childIssueRole configuration for workflow reviewer outcomes.`,
            ),
          );
          process.exit(1);
        }

        const spinner = ora("Recording workflow reviewer outcome").start();

        try {
          const summary = requireOptionText(opts.summary, "--summary");
          const tracker = await getTrackerForProject(config, project, {
            requireUpdateIssue: true,
            requireCreateIssue: opts.outcome === "create_follow_up",
          });
          const context = resolveWorkflowReviewContext(projectId, project, ref);
          const childComment = buildWorkflowReviewSummaryComment(opts.outcome, summary, context);
          let nextState = context.child.state;
          let implementerAction: Awaited<
            ReturnType<typeof routeRequestedChangesToImplementer>
          > | null = null;
          let followUpIssue: TaskLineageChildIssue | null = null;

          spinner.text = `Updating ${context.child.issueLabel}`;
          switch (opts.outcome) {
            case "approve":
              nextState = "approved";
              transitionTaskLineageChildState(project.path, context.child.issueId, nextState);
              if (!(await maybePublishWorkflowReviewToSCM(
                config,
                project,
                context.child.pr,
                opts.outcome,
                summary,
              ))) {
                await tracker.updateIssue!(context.child.issueId, { comment: childComment }, project);
              }
              break;
            case "request_changes":
              nextState = "changes_requested";
              transitionTaskLineageChildState(project.path, context.child.issueId, nextState);
              if (!(await maybePublishWorkflowReviewToSCM(
                config,
                project,
                context.child.pr,
                opts.outcome,
                summary,
              ))) {
                await tracker.updateIssue!(context.child.issueId, { comment: childComment }, project);
              }
              implementerAction = await routeRequestedChangesToImplementer(
                config,
                projectId,
                childIssueRole,
                context,
                summary,
              );
              break;
            case "create_follow_up": {
              const followUpTitle = requireOptionText(opts.followUpTitle, "--follow-up-title");
              const nextTask = buildFollowUpTask(context, followUpTitle, summary);
              const nextTaskPlan: TaskPlan = {
                ...context.taskPlan,
                childTasks: [...context.taskPlan.childTasks, nextTask],
              };
              writeFileSync(context.taskPlanFilePath, taskPlanToYaml(nextTaskPlan), "utf-8");
              if (context.taskPlanRelocated) {
                updateTaskLineageTaskPlanPath(
                  project.path,
                  context.taskPlan.parentIssue,
                  context.taskPlanPath,
                );
              }

              const createdIssue = await tracker.createIssue!(
                {
                  title: nextTask.title,
                  description: buildChildIssueBody(nextTaskPlan, nextTask, tracker, project),
                  labels: [...nextTask.labels],
                  parentIssueId: context.taskPlan.parentIssue,
                },
                project,
              );
              followUpIssue = {
                taskIndex: nextTaskPlan.childTasks.length - 1,
                title: nextTask.title,
                issueId: createdIssue.id,
                issueUrl: createdIssue.url,
                issueLabel: tracker.issueLabel?.(createdIssue.url, project) ?? createdIssue.id,
                labels: [...nextTask.labels],
                dependencies: [...nextTask.dependencies],
                state: "queued",
                implementationSessions: [],
                reviewSessions: [],
                pr: null,
              };

              mergeTaskLineageChildIssues(
                context.lineagePath,
                {
                  projectId,
                  parentIssue: context.taskPlan.parentIssue,
                  taskPlanPath: context.taskPlanPath,
                  trackerPlugin: context.lineage.trackerPlugin,
                  createdAt: context.lineage.createdAt,
                },
                [...context.lineage.childIssues, followUpIssue],
              );
              nextState = "blocked";
              transitionTaskLineageChildState(project.path, context.child.issueId, nextState);
              await tracker.updateIssue!(
                context.child.issueId,
                {
                  comment: `${childComment}\n\nCreated follow-up child issue: ${followUpIssue.issueLabel} (${followUpIssue.issueUrl})`,
                },
                project,
              );
              break;
            }
            case "update_parent_summary":
              transitionTaskLineageChildState(project.path, context.child.issueId, nextState);
              await tracker.updateIssue!(
                context.taskPlan.parentIssue,
                { comment: buildParentSummaryComment(summary, context) },
                project,
              );
              break;
          }

          const updatedLineage = readTaskLineageFile(context.lineagePath);
          const updatedChild =
            updatedLineage.childIssues.find((child) => child.issueId === context.child.issueId) ??
            context.child;

          spinner.succeed(`Recorded reviewer outcome ${chalk.green(opts.outcome)}`);
          console.log(`  Parent:    ${chalk.dim(context.taskPlan.parentIssue)}`);
          console.log(`  Child:     ${chalk.dim(`${context.child.issueLabel} ${context.child.title}`)}`);
          console.log(`  Outcome:   ${chalk.dim(opts.outcome)}`);
          console.log(`  State:     ${chalk.dim(`${context.child.state} -> ${updatedChild.state}`)}`);
          console.log(`  Lineage:   ${chalk.dim(context.lineagePath)}`);
          if (opts.outcome === "update_parent_summary") {
            console.log(`  Commented: ${chalk.dim(context.taskPlan.parentIssue)}`);
          } else {
            console.log(`  Commented: ${chalk.dim(context.child.issueLabel)}`);
          }
          if (implementerAction) {
            console.log(
              `  Implementer:${chalk.dim(` ${implementerAction.action} ${implementerAction.sessionId}`)}`,
            );
          }
          if (followUpIssue) {
            console.log(
              `  Follow-up: ${chalk.dim(`${followUpIssue.issueLabel} ${followUpIssue.title}`)}`,
            );
          }
        } catch (err) {
          spinner.fail("Failed to record workflow reviewer outcome");
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
      },
    );

  workflow
    .command("set-state")
    .description("Manually transition a workflow child issue state")
    .argument("<project>", "Project ID from config")
    .argument("<issue-or-pr-ref>", "Child issue ref, issue label, PR number, PR URL, or PR branch")
    .argument("<state>", "Target workflow child state")
    .action(async (projectId: string, ref: string, state: string) => {
      const config = loadConfig();
      const project = config.projects[projectId];
      if (!project) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      try {
        const context = resolveWorkflowLineageChild(project, ref);
        const nextState = parseTaskLineageChildState(state);
        const allowed = getAllowedTaskLineageChildStateTransitions(context.child.state);

        if (context.child.state !== nextState && !allowed.includes(nextState)) {
          throw new Error(
            `Cannot move ${context.child.issueLabel} from ${context.child.state} to ${nextState}. Allowed: ${allowed.join(", ") || "none"}`,
          );
        }

        const updatedLineage = transitionTaskLineageChildState(
          project.path,
          context.child.issueId,
          nextState,
        );
        if (!updatedLineage) {
          throw new Error(`Failed to update lineage state for ${context.child.issueLabel}.`);
        }

        const updatedChild =
          updatedLineage.childIssues.find((child) => child.issueId === context.child.issueId) ??
          context.child;

        console.log(chalk.bold(`Workflow child state updated for ${projectId}`));
        console.log(`  Parent:  ${chalk.dim(context.lineage.parentIssue)}`);
        console.log(`  Child:   ${chalk.dim(`${context.child.issueLabel} ${context.child.title}`)}`);
        console.log(`  Match:   ${chalk.dim(context.matchedBy)}`);
        console.log(`  File:    ${chalk.dim(context.lineagePath)}`);
        console.log(
          `  State:   ${chalk.dim(
            context.child.state === updatedChild.state
              ? updatedChild.state
              : `${context.child.state} -> ${updatedChild.state}`,
          )}`,
        );
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  workflow
    .command("relocate-task-plan")
    .description("Update workflow lineage to point at a moved task-plan file")
    .argument("<project>", "Project ID from config")
    .argument("<parent-issue>", "Parent issue identifier")
    .argument("<task-plan>", "New task-plan path (project-relative or absolute)")
    .action((projectId: string, parentIssue: string, taskPlanPath: string) => {
      const config = loadConfig();
      const project = config.projects[projectId];
      if (!project) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      try {
        const match = findTaskLineageByParentIssue(project.path, parentIssue);
        if (!match) {
          throw new Error(`No lineage found for parent issue ${parentIssue}.`);
        }

        const resolvedTaskPlanPath = resolveProjectFilePath(project.path, taskPlanPath);
        const validatedTaskPlan = readTaskPlanFile(resolvedTaskPlanPath, {
          expectedParentIssue: parentIssue,
        });
        const storedTaskPlanPath = toStoredProjectPath(project.path, resolvedTaskPlanPath);
        const updated = updateTaskLineageTaskPlanPath(project.path, parentIssue, storedTaskPlanPath);
        if (!updated) {
          throw new Error(`Failed to update task-plan path for parent issue ${parentIssue}.`);
        }

        console.log(chalk.bold(`Workflow task-plan path updated for ${projectId}`));
        console.log(`  Parent:    ${chalk.dim(parentIssue)}`);
        console.log(`  Lineage:   ${chalk.dim(match.filePath)}`);
        console.log(`  Task plan: ${chalk.dim(`${match.lineage.taskPlanPath} -> ${storedTaskPlanPath}`)}`);
        console.log(`  Child tasks:${chalk.dim(` ${validatedTaskPlan.childTasks.length}`)}`);
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  workflow
    .command("lineage")
    .description("Show workflow lineage for a parent issue")
    .argument("<project>", "Project ID from config")
    .argument("<parent-issue>", "Parent issue identifier")
    .option("--json", "Output the lineage store as JSON")
    .action(async (projectId: string, parentIssue: string, opts: { json?: boolean }) => {
      const config = loadConfig();
      const project = config.projects[projectId];
      if (!project) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      const match = findTaskLineageByParentIssue(project.path, parentIssue);
      if (!match) {
        console.error(chalk.red(`No lineage found for parent issue ${parentIssue}.`));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(match.lineage, null, 2));
        return;
      }

      console.log(chalk.bold(`Workflow lineage for ${parentIssue}`));
      console.log(`  File:      ${chalk.dim(match.filePath)}`);
      console.log(`  Task plan: ${chalk.dim(match.lineage.taskPlanPath)}`);
      console.log(`  Tracker:   ${chalk.dim(match.lineage.trackerPlugin)}`);
      console.log(
        `  Planning:  ${chalk.dim(match.lineage.planningSession?.sessionId ?? "-")}`,
      );
      console.log(`  Children:  ${chalk.dim(String(match.lineage.childIssues.length))}`);
      const summary = summarizeTaskLineageStates(match.lineage);
      console.log(
        `  States:    ${chalk.dim(
          Object.entries(summary)
            .filter(([, count]) => count > 0)
            .map(([state, count]) => `${state}=${count}`)
            .join(", ") || "none",
        )}`,
      );
      for (const child of match.lineage.childIssues) {
        const impl = child.implementationSessions.map((session) => session.sessionId).join(", ") || "-";
        const review = child.reviewSessions.map((session) => session.sessionId).join(", ") || "-";
        console.log(
          `  ${chalk.green(child.issueLabel)} ${chalk.dim(child.title)} ${chalk.dim(`[${child.state}]`)}`,
        );
        console.log(`    Impl:   ${chalk.dim(impl)}`);
        console.log(`    Review: ${chalk.dim(review)}`);
        console.log(`    PR:     ${chalk.dim(child.pr?.url ?? "-")}`);
      }
    });

  workflow
    .command("audit-lineage")
    .description("Audit a workflow lineage artifact for corruption or drift")
    .argument("<project>", "Project ID from config")
    .argument("[parent-issue]", "Parent issue identifier")
    .option("--lineage <path>", "Inspect this lineage file instead of resolving by parent issue")
    .option("--task-plan <path>", "Override taskPlanPath during audit or repair")
    .option("--repair", "Apply safe supported lineage repairs in place")
    .option("--json", "Emit machine-readable audit output")
    .action(
      async (
        projectId: string,
        parentIssue: string | undefined,
        opts: { lineage?: string; taskPlan?: string; repair?: boolean; json?: boolean },
      ) => {
        const config = loadConfig();
        const project = config.projects[projectId];
        if (!project) {
          console.error(
            chalk.red(
              `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
            ),
          );
          process.exit(1);
        }

        try {
          const lineagePath = resolveWorkflowLineagePath(project, parentIssue, opts.lineage);
          const audit = auditTaskLineageFile(lineagePath, {
            projectPath: project.path,
            repair: opts.repair,
            taskPlanPathOverride: opts.taskPlan,
          });

          if (opts.json) {
            console.log(JSON.stringify(audit, null, 2));
          } else {
            console.log(chalk.bold(`Workflow lineage audit for ${projectId}`));
            console.log(`  File:     ${chalk.dim(lineagePath)}`);
            if (audit.lineage?.parentIssue) {
              console.log(`  Parent:   ${chalk.dim(audit.lineage.parentIssue)}`);
            }
            console.log(`  Status:   ${audit.ok ? chalk.green("ok") : chalk.red("issues found")}`);
            if (audit.repaired) {
              console.log(`  Repair:   ${chalk.green("applied safe fixes")}`);
            } else if (opts.repair) {
              console.log(`  Repair:   ${chalk.dim("no safe fixes applied")}`);
            }
            if (audit.findings.length === 0) {
              console.log(`  Findings: ${chalk.dim("none")}`);
            } else {
              console.log("  Findings:");
              for (const finding of audit.findings) {
                console.log(`  ${formatLineageAuditFinding(finding)}`);
              }
            }
          }

          if (!audit.ok) {
            process.exit(1);
          }
        } catch (err) {
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
      },
    );
}
