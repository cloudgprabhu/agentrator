import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Command } from "commander";
import {
  type CreateIssueInput,
  type OrchestratorConfig,
  type ProjectConfig,
  type SCM,
  type Session,
  type TaskLineage,
  type TaskLineageChildIssue,
  type TaskPlan,
  type Tracker,
  createPluginRegistry,
  createTaskLineageSessionRef,
  findTaskLineageByChildOrPRRef,
  findTaskLineageByParentIssue,
  loadConfig,
  mergeTaskLineageChildIssues,
  parseTaskLineageChildState,
  readTaskLineageFile,
  summarizeTaskLineageStates,
  taskPlanToYaml,
  transitionTaskLineageChildState,
  updateTaskLineageTaskPlanPath,
  upsertTaskLineagePlanningSession,
} from "@composio/ao-core";
import { auditTaskLineageFile, taskLineageToYaml } from "@composio/ao-core/task-lineage";
import { readTaskPlanFile } from "@composio/ao-core/task-plan";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker } from "../lib/lifecycle-service.js";

type ReviewOutcome = "approve" | "request_changes" | "create_follow_up" | "update_parent_summary";
type TaskLineageChildOrPRMatch = NonNullable<ReturnType<typeof findTaskLineageByChildOrPRRef>>;

interface WorkflowContext {
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
  workflow: NonNullable<OrchestratorConfig["workflow"]>[string];
}

interface PluginContext extends WorkflowContext {
  tracker: Tracker | null;
  scm: SCM | null;
}

function exitWithError(message: string): never {
  console.error(message);
  process.exit(1);
}

function resolveProjectFilePath(project: ProjectConfig, filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(project.path, filePath);
}

function writeLineageYaml(filePath: string, lineage: TaskLineage): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, taskLineageToYaml(lineage), "utf-8");
}

function asProjectRelativePath(project: ProjectConfig, filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  const relativePath = relative(project.path, filePath);
  return relativePath.startsWith("..") ? filePath : relativePath;
}

function defaultTaskPlanPath(parentIssue: string): string {
  return `docs/plans/${parentIssue.toLowerCase()}.task-plan.yaml`;
}

function listProjectFiles(rootPath: string, limit = 50): string[] {
  const results: string[] = [];
  const stack = [rootPath];

  while (stack.length > 0 && results.length < limit) {
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

    for (const entry of entries.sort()) {
      if (entry === ".git" || entry === "node_modules") continue;
      const filePath = join(current, entry);

      const childEntries = (() => {
        try {
          return readdirSync(filePath);
        } catch {
          return null;
        }
      })();
      if (childEntries) {
        stack.push(filePath);
        continue;
      }

      results.push(relative(rootPath, filePath));
      if (results.length >= limit) break;
    }
  }

  return results.sort();
}

function listTaskPlanFiles(rootPath: string): string[] {
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
      const childEntries = (() => {
        try {
          return readdirSync(filePath);
        } catch {
          return null;
        }
      })();
      if (childEntries) {
        stack.push(filePath);
        continue;
      }

      if (filePath.endsWith(".task-plan.yaml") || filePath.endsWith(".task-plan.yml")) {
        results.push(filePath);
      }
    }
  }

  return results.sort();
}

function requireWorkflowContext(projectId: string): WorkflowContext {
  const config = loadConfig();
  const project = config.projects[projectId];
  if (!project) {
    exitWithError(`Unknown project: ${projectId}`);
  }
  const workflowKey = project.workflow;
  const workflow = workflowKey ? config.workflow?.[workflowKey] : undefined;
  if (!workflow?.parentIssueRole) {
    exitWithError(`Project ${projectId} is missing workflow.parentIssueRole`);
  }

  return { config, projectId, project, workflow };
}

async function loadPluginContext(
  projectId: string,
  options: { requireTracker?: boolean; requireSCM?: boolean } = {},
): Promise<PluginContext> {
  const context = requireWorkflowContext(projectId);
  const registry = createPluginRegistry();
  await registry.loadFromConfig(context.config, (pkg: string) => import(pkg));

  const tracker = context.project.tracker
    ? registry.get<Tracker>("tracker", context.project.tracker.plugin)
    : null;
  const scm = context.project.scm ? registry.get<SCM>("scm", context.project.scm.plugin) : null;

  if (options.requireTracker && !tracker) {
    exitWithError(`Project ${projectId} is missing a tracker plugin`);
  }
  if (options.requireSCM && !scm) {
    exitWithError(`Project ${projectId} is missing an SCM plugin`);
  }

  return { ...context, tracker, scm };
}

function buildTaskPlanTemplate(parentIssue: string): string {
  return [
    "version: 1",
    `parentIssue: ${parentIssue}`,
    "specPath: null",
    "adrPath: null",
    "childTasks:",
    "  - title: <task title>",
    "    summary: <task summary>",
    "    acceptanceCriteria:",
    "      - <criterion>",
    "    dependencies: []",
    "    suggestedFiles: []",
    "    labels: []",
  ].join("\n");
}

function buildPlanningPrompt(
  project: ProjectConfig,
  workflowRole: string,
  parentIssue: string,
  artifactPath: string,
): string {
  const repoFiles = listProjectFiles(project.path, 25);
  const lines: string[] = [];
  lines.push("## Workflow Planning");
  lines.push(`Workflow role: ${workflowRole}`);
  lines.push(`Parent issue: ${parentIssue}`);
  lines.push(`Task plan artifact: ${artifactPath}`);
  lines.push("");
  lines.push("## Artifact Contract");
  lines.push(buildTaskPlanTemplate(parentIssue));
  lines.push("");
  lines.push("## Repository Context");
  for (const file of repoFiles) {
    lines.push(`- ${file}`);
  }
  lines.push("");
  lines.push("Write a valid task-plan YAML artifact at the exact target path above.");
  return lines.join("\n");
}

function buildTrackerIssueDescription(
  taskPlan: TaskPlan,
  childTask: TaskPlan["childTasks"][number],
): string {
  const lines: string[] = [];
  lines.push("## Parent Issue");
  lines.push(`ID: ${taskPlan.parentIssue}`);
  lines.push("");
  if (taskPlan.specPath) {
    lines.push("## Spec");
    lines.push(taskPlan.specPath);
    lines.push("");
  }
  if (taskPlan.adrPath) {
    lines.push("## ADR");
    lines.push(taskPlan.adrPath);
    lines.push("");
  }
  lines.push("## Summary");
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
    for (const item of childTask.dependencies) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join("\n");
}

function buildReviewPrompt(
  match: TaskLineageChildOrPRMatch,
  taskPlan: TaskPlan,
  taskPlanDisplayPath: string,
  childTask: TaskPlan["childTasks"][number],
): string {
  const child = match.lineage.childIssues[match.childIndex];
  const lines: string[] = [];
  lines.push("## Workflow Review");
  lines.push(`Match source: ${match.matchSource}`);
  lines.push(`Parent issue: ${match.lineage.parentIssue}`);
  lines.push(`Child issue: ${child.issueLabel} (${child.issueId})`);
  lines.push(`Current lineage state: ${child.state}`);
  lines.push(`Lineage file: ${match.filePath}`);
  lines.push(`Task plan: ${taskPlanDisplayPath}`);
  if (child.pr?.url) {
    lines.push(`PR: ${child.pr.url}`);
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
    for (const item of childTask.dependencies) {
      lines.push(`- ${item}`);
    }
  }
  lines.push("");
  lines.push("## Suggested Files");
  if (childTask.suggestedFiles.length === 0) {
    lines.push("- None");
  } else {
    for (const item of childTask.suggestedFiles) {
      lines.push(`- ${item}`);
    }
  }
  if (taskPlan.specPath) {
    lines.push("");
    lines.push("## Spec");
    lines.push(taskPlan.specPath);
  }
  if (taskPlan.adrPath) {
    lines.push("");
    lines.push("## ADR");
    lines.push(taskPlan.adrPath);
  }
  return lines.join("\n");
}

function buildRequestedChangesPrompt(summary: string): string {
  return [
    "## Requested Changes",
    summary,
    "",
    "Please address the requested review changes and update the existing work.",
  ].join("\n");
}

function isTerminalSession(session: Session): boolean {
  return session.activity === "exited" || ["killed", "done", "merged", "terminated", "cleanup"].includes(session.status);
}

function ensureTaskPlanMatchesParent(taskPlanPath: string, parentIssue: string): TaskPlan {
  return readTaskPlanFile(taskPlanPath, { expectedParentIssue: parentIssue });
}

function resolveTaskPlanForReview(
  project: ProjectConfig,
  lineage: TaskLineage,
): { taskPlan: TaskPlan; taskPlanPath: string; displayPath: string } {
  const configuredPath = resolveProjectFilePath(project, lineage.taskPlanPath);
  try {
    return {
      taskPlan: readTaskPlanFile(configuredPath, { expectedParentIssue: lineage.parentIssue }),
      taskPlanPath: configuredPath,
      displayPath: lineage.taskPlanPath,
    };
  } catch {
    const matches = listTaskPlanFiles(project.path)
      .map((filePath) => {
        try {
          return {
            filePath,
            taskPlan: readTaskPlanFile(filePath, { expectedParentIssue: lineage.parentIssue }),
          };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { filePath: string; taskPlan: TaskPlan } => entry !== null);

    if (matches.length === 1) {
      const displayPath = `${asProjectRelativePath(project, matches[0].filePath)} (resolved after move)`;
      return {
        taskPlan: matches[0].taskPlan,
        taskPlanPath: matches[0].filePath,
        displayPath,
      };
    }

    throw new Error(`Unable to resolve task plan for ${lineage.parentIssue}`);
  }
}

function buildLineageChildIssue(
  taskIndex: number,
  title: string,
  createdIssue: { id: string; url: string; labels?: string[] },
  issueLabel: string,
  dependencies: string[],
): TaskLineageChildIssue {
  return {
    taskIndex,
    title,
    issueId: createdIssue.id,
    issueUrl: createdIssue.url,
    issueLabel,
    labels: createdIssue.labels ?? [],
    dependencies,
    state: "queued",
    implementationSessions: [],
    reviewSessions: [],
    pr: null,
  };
}

async function handlePlan(
  projectId: string,
  parentIssue: string,
  opts: { artifact?: string; verifyArtifact: boolean },
): Promise<void> {
  const { config, project, workflow } = requireWorkflowContext(projectId);
  await ensureLifecycleWorker(config, projectId);
  const sessionManager = await getSessionManager(config);

  const artifactPath = opts.artifact ?? defaultTaskPlanPath(parentIssue);
  const artifactFilePath = resolveProjectFilePath(project, artifactPath);
  const prompt = buildPlanningPrompt(project, workflow.parentIssueRole, parentIssue, artifactPath);
  const session = await sessionManager.spawn({
    projectId,
    issueId: parentIssue,
    role: workflow.parentIssueRole,
    prompt,
  });

  if (opts.verifyArtifact) {
    try {
      ensureTaskPlanMatchesParent(artifactFilePath, parentIssue);
    } catch (error) {
      const latest = await sessionManager.get(session.id);
      const message = error instanceof Error ? error.message : String(error);
      if (!existsSync(artifactFilePath) && latest && isTerminalSession(latest)) {
        exitWithError(`Planner session ${session.id} ended before producing a valid task plan`);
      }
      exitWithError(message);
    }
  }

  const lineagePath = resolveProjectFilePath(project, artifactPath.replace(/\.task-plan\.ya?ml$/i, ".lineage.yaml"));
  const sessionRef = createTaskLineageSessionRef(session, workflow.parentIssueRole);
  upsertTaskLineagePlanningSession(project.path, parentIssue, sessionRef, {
    version: 1,
    projectId,
    parentIssue,
    taskPlanPath: artifactPath,
    trackerPlugin: project.tracker?.plugin ?? "unknown",
    createdAt: session.createdAt.toISOString(),
    childIssues: [],
  });

  if (!existsSync(lineagePath)) {
    writeLineageYaml(lineagePath, {
      version: 1,
      projectId,
      parentIssue,
      taskPlanPath: artifactPath,
      trackerPlugin: project.tracker?.plugin ?? "unknown",
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.createdAt.toISOString(),
      planningSession: sessionRef,
      childIssues: [],
    });
  }
}

async function handleValidatePlan(taskPlanPath: string): Promise<void> {
  const taskPlan = readTaskPlanFile(taskPlanPath);
  console.log(`Valid task plan: ${taskPlanPath}`);
  console.log(`Parent issue: ${taskPlan.parentIssue}`);
  console.log(`Child tasks: ${taskPlan.childTasks.length}`);
}

async function handleCreateIssues(
  projectId: string,
  taskPlanPathArg: string,
  opts: { lineage?: string },
): Promise<void> {
  const { project, tracker } = await loadPluginContext(projectId, { requireTracker: true });
  if (!tracker?.createIssue) {
    exitWithError(`Tracker plugin ${project.tracker?.plugin ?? "<unknown>"} does not support issue creation`);
  }

  const taskPlanFilePath = resolveProjectFilePath(project, taskPlanPathArg);
  const taskPlan = readTaskPlanFile(taskPlanFilePath);
  const lineageFilePath = resolveProjectFilePath(
    project,
    opts.lineage ?? taskPlanPathArg.replace(/\.task-plan\.ya?ml$/i, ".lineage.yaml"),
  );

  const createdChildren: TaskLineageChildIssue[] = [];
  for (const [taskIndex, childTask] of taskPlan.childTasks.entries()) {
    const createdIssue = await tracker.createIssue(
      {
        title: childTask.title,
        parentIssueId: taskPlan.parentIssue,
        labels: childTask.labels,
        description: buildTrackerIssueDescription(taskPlan, childTask),
      } as CreateIssueInput,
      project,
    );

    const issueLabel = tracker.issueLabel
      ? tracker.issueLabel(createdIssue.url, project)
      : `#${createdIssue.id}`;
    createdChildren.push(
      buildLineageChildIssue(
        taskIndex,
        childTask.title,
        createdIssue,
        issueLabel,
        childTask.dependencies,
      ),
    );
  }

  const existing = existsSync(lineageFilePath) ? readTaskLineageFile(lineageFilePath) : null;
  const baseLineage: TaskLineage = existing ?? {
    version: 1,
    projectId,
    parentIssue: taskPlan.parentIssue,
    taskPlanPath: taskPlanPathArg,
    trackerPlugin: project.tracker?.plugin ?? "unknown",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    planningSession: null,
    childIssues: [],
  };

  writeLineageYaml(
    lineageFilePath,
    mergeTaskLineageChildIssues(
      {
        ...baseLineage,
        taskPlanPath: taskPlanPathArg,
      },
      createdChildren,
    ),
  );
}

async function handleLineage(projectId: string, parentIssue: string): Promise<void> {
  const { project } = requireWorkflowContext(projectId);
  const match = findTaskLineageByParentIssue(project.path, parentIssue);
  if (!match) {
    exitWithError(`No workflow lineage found for ${parentIssue}`);
  }

  console.log(`Workflow lineage for ${parentIssue}`);
  if (match.lineage.planningSession) {
    console.log(`Planning session: ${match.lineage.planningSession.sessionId}`);
  }
  const summary = summarizeTaskLineageStates(match.lineage);
  console.log(
    Object.entries(summary)
      .filter(([, count]) => count > 0)
      .map(([state, count]) => `${state}=${count}`)
      .join(" "),
  );
  for (const child of match.lineage.childIssues) {
    console.log(`${child.issueLabel} [${child.state}] ${child.title}`);
  }
}

async function handleAuditLineage(
  projectId: string,
  opts: { lineage: string; taskPlan?: string; repair?: boolean },
): Promise<void> {
  const { project } = requireWorkflowContext(projectId);
  const lineageFilePath = resolveProjectFilePath(project, opts.lineage);
  const result = auditTaskLineageFile(project.path, lineageFilePath, {
    projectId,
    taskPlanPath: opts.taskPlan,
    repair: opts.repair,
  });

  console.log(`Workflow lineage audit for ${projectId}`);
  for (const finding of result.findings) {
    console.log(`${finding.code}: ${finding.message}`);
  }
  if (result.repaired) {
    console.log("applied safe fixes");
  }

  const unresolved = result.findings.some((finding) => finding.severity !== "info" && !finding.repaired);
  if (unresolved) {
    process.exit(1);
  }
}

async function handleImplement(
  projectId: string,
  parentIssue: string,
  opts: { concurrency?: string },
): Promise<void> {
  const { config, project, workflow } = requireWorkflowContext(projectId);
  const match = findTaskLineageByParentIssue(project.path, parentIssue);
  if (!match) {
    exitWithError(`No workflow lineage found for ${parentIssue}`);
  }

  const concurrency = opts.concurrency ? Number.parseInt(opts.concurrency, 10) : Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    exitWithError("--concurrency must be a positive integer");
  }

  const sessionManager = await getSessionManager(config);
  const sessions = await sessionManager.list(projectId);
  let activeImplementers = sessions.filter(
    (session) => session.metadata["role"] === workflow.childIssueRole && !isTerminalSession(session),
  ).length;

  const pluginContext = await loadPluginContext(projectId, { requireTracker: true });
  const tracker = pluginContext.tracker;
  if (!tracker) {
    exitWithError(`Project ${projectId} is missing a tracker plugin`);
  }
  console.log(`Workflow implementation for ${parentIssue}`);

  for (const child of match.lineage.childIssues) {
    const active = sessions.find(
      (session) =>
        session.issueId === child.issueId &&
        session.metadata["role"] === workflow.childIssueRole &&
        !isTerminalSession(session),
    );
    if (active) {
      console.log(`${child.issueLabel}: already in progress`);
      continue;
    }

    if (await tracker.isCompleted(child.issueId, project)) {
      if (child.state !== "done") {
        transitionTaskLineageChildState(project.path, child.issueLabel, "done");
      }
      console.log(`${child.issueLabel}: already completed`);
      continue;
    }

    if (activeImplementers >= concurrency) {
      console.log(`${child.issueLabel}: concurrency limit reached`);
      continue;
    }

    await sessionManager.spawn({
      projectId,
      issueId: child.issueId,
      role: workflow.childIssueRole,
    });
    activeImplementers += 1;
    console.log(`${child.issueLabel}: spawned`);
  }
}

async function resolveReviewMatch(
  projectId: string,
  reference: string,
): Promise<{
  context: PluginContext;
  match: TaskLineageChildOrPRMatch;
  taskPlan: TaskPlan;
  taskPlanPath: string;
  taskPlanDisplayPath: string;
}> {
  const context = await loadPluginContext(projectId, { requireTracker: true });
  const match = findTaskLineageByChildOrPRRef(context.project.path, reference);
  if (!match) {
    exitWithError(`No workflow child issue found for ${reference}`);
  }

  const resolvedTaskPlan = resolveTaskPlanForReview(context.project, match.lineage);
  return {
    context,
    match,
    taskPlan: resolvedTaskPlan.taskPlan,
    taskPlanPath: resolvedTaskPlan.taskPlanPath,
    taskPlanDisplayPath: resolvedTaskPlan.displayPath,
  };
}

async function handleReview(projectId: string, reference: string): Promise<void> {
  const { context, match, taskPlan, taskPlanDisplayPath } = await resolveReviewMatch(
    projectId,
    reference,
  );
  const child = match.lineage.childIssues[match.childIndex];
  const childTask = taskPlan.childTasks[child.taskIndex];
  if (!childTask) {
    exitWithError(`Task plan is missing child task ${child.taskIndex}`);
  }

  const sessionManager = await getSessionManager(context.config);
  const session = await sessionManager.spawn({
    projectId,
    issueId: child.issueId,
    role: context.workflow.reviewRole,
    prompt: buildReviewPrompt(match, taskPlan, taskPlanDisplayPath, childTask),
  });

  console.log(`Child: ${child.issueLabel}`);
  if (child.pr?.url) {
    console.log(`PR: ${child.pr.url}`);
  }
  if (taskPlanDisplayPath.includes("(resolved after move)")) {
    console.log(taskPlanDisplayPath);
  }
  console.log(`SESSION=${session.id}`);
}

async function publishOutcomeToSCMOrTracker(
  context: PluginContext,
  child: TaskLineageChildIssue,
  outcome: Exclude<ReviewOutcome, "create_follow_up" | "update_parent_summary">,
  summary: string,
): Promise<void> {
  if (child.pr?.url && context.scm?.publishReview && context.scm.resolvePR) {
    const pr = await context.scm.resolvePR(child.pr.url, context.project);
    await context.scm.publishReview(pr, { outcome, summary });
    return;
  }

  if (!context.tracker?.updateIssue) {
    return;
  }
  await context.tracker.updateIssue(
    child.issueId,
    { comment: `Workflow Review Outcome\nOutcome: ${outcome}\n\n${summary}` },
    context.project,
  );
}

async function handleReviewOutcome(
  projectId: string,
  reference: string,
  opts: { outcome: ReviewOutcome; summary: string; followUpTitle?: string },
): Promise<void> {
  const { context, match, taskPlan, taskPlanPath } =
    await resolveReviewMatch(projectId, reference);
  const child = match.lineage.childIssues[match.childIndex];
  const { config, workflow, tracker, scm, project } = context;
  const sessionManager = await getSessionManager(config);

  if (opts.outcome === "approve") {
    await publishOutcomeToSCMOrTracker({ config, projectId, project, workflow, tracker, scm }, child, "approve", opts.summary);
    transitionTaskLineageChildState(project.path, child.issueLabel, "approved");
    return;
  }

  if (opts.outcome === "request_changes") {
    await publishOutcomeToSCMOrTracker(
      { config, projectId, project, workflow, tracker, scm },
      child,
      "request_changes",
      opts.summary,
    );
    transitionTaskLineageChildState(project.path, child.issueLabel, "changes_requested");

    const sessions = await sessionManager.list(projectId);
    const activeImplementer = sessions.find(
      (session) =>
        session.issueId === child.issueId &&
        session.metadata["role"] === workflow.childIssueRole &&
        !isTerminalSession(session),
    );
    const prompt = buildRequestedChangesPrompt(opts.summary);
    if (activeImplementer) {
      await sessionManager.send(activeImplementer.id, prompt);
    } else {
      await sessionManager.spawn({
        projectId,
        issueId: child.issueId,
        role: workflow.childIssueRole,
        prompt,
      });
    }
    return;
  }

  if (opts.outcome === "update_parent_summary") {
    if (!tracker?.updateIssue) {
      exitWithError("Tracker does not support updating issues");
    }
    await tracker.updateIssue(
      match.lineage.parentIssue,
      { comment: `Workflow Parent Summary Update\n\n${opts.summary}` },
      project,
    );
    return;
  }

  if (opts.outcome === "create_follow_up") {
    if (!tracker?.createIssue || !tracker.updateIssue) {
      exitWithError("Tracker does not support follow-up issue creation");
    }
    if (!opts.followUpTitle) {
      exitWithError("--follow-up-title is required for create_follow_up");
    }

    const nextTaskIndex = taskPlan.childTasks.length;
    const followUpLabels = Array.from(new Set([...(child.labels ?? []), "follow-up"]));
    const updatedTaskPlan: TaskPlan = {
      ...taskPlan,
      childTasks: [
        ...taskPlan.childTasks,
        {
          title: opts.followUpTitle,
          summary: opts.summary,
          acceptanceCriteria: [opts.summary],
          dependencies: [child.title],
          suggestedFiles: [],
          labels: followUpLabels,
        },
      ],
    };
    writeFileSync(taskPlanPath, taskPlanToYaml(updatedTaskPlan), "utf-8");

    const createdIssue = await tracker.createIssue(
      {
        title: opts.followUpTitle,
        parentIssueId: match.lineage.parentIssue,
        description: `Follow-up from review of ${child.issueLabel}\n\n${opts.summary}`,
        labels: followUpLabels,
      },
      project,
    );
    const issueLabel = tracker.issueLabel
      ? tracker.issueLabel(createdIssue.url, project)
      : `#${createdIssue.id}`;
    await tracker.updateIssue(
      child.issueId,
      { comment: `Created follow-up child issue: ${issueLabel}` },
      project,
    );

    const lineagePath = match.filePath;
    const lineage = readTaskLineageFile(lineagePath);
    const updatedChildren = lineage.childIssues.map((entry, index) =>
      index === match.childIndex ? { ...entry, state: "blocked" as const } : entry,
    );
    const merged = mergeTaskLineageChildIssues(
      { ...lineage, childIssues: updatedChildren },
      [
        buildLineageChildIssue(
          nextTaskIndex,
          opts.followUpTitle,
          createdIssue,
          issueLabel,
          [child.title],
        ),
      ],
    );
    writeLineageYaml(lineagePath, merged);
  }
}

async function handleSetState(
  projectId: string,
  childRef: string,
  nextStateInput: string,
): Promise<void> {
  const { project } = requireWorkflowContext(projectId);
  const match = findTaskLineageByChildOrPRRef(project.path, childRef);
  if (!match || match.matchSource !== "issue") {
    exitWithError(`No workflow child issue found for ${childRef}`);
  }
  const currentState = match.lineage.childIssues[match.childIndex]?.state;
  if (!currentState) {
    exitWithError(`No workflow child issue found for ${childRef}`);
  }
  const nextState = parseTaskLineageChildState(nextStateInput);
  transitionTaskLineageChildState(project.path, childRef, nextState);
  console.log(`${currentState} -> ${nextState}`);
}

async function handleRelocateTaskPlan(
  projectId: string,
  parentIssue: string,
  nextTaskPlanPath: string,
): Promise<void> {
  const { project } = requireWorkflowContext(projectId);
  const before = findTaskLineageByParentIssue(project.path, parentIssue);
  if (!before) {
    exitWithError(`No workflow lineage found for ${parentIssue}`);
  }
  updateTaskLineageTaskPlanPath(project.path, parentIssue, nextTaskPlanPath);
  console.log(`${before.lineage.taskPlanPath} -> ${nextTaskPlanPath}`);
}

function withCommandErrors(
  handler: (...args: unknown[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    try {
      await handler(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    }
  };
}

export function registerWorkflow(program: Command): void {
  const workflow = program.command("workflow").description("Workflow planning and lineage management");

  workflow
    .command("plan")
    .argument("<project>", "Project ID from config")
    .argument("<parentIssue>", "Parent issue identifier")
    .option("--artifact <path>", "Task-plan artifact path relative to the project")
    .option("--no-verify-artifact", "Skip validation of the generated artifact")
    .action(
      withCommandErrors(
        async (
          projectId: string,
          parentIssue: string,
          opts: { artifact?: string; verifyArtifact: boolean },
        ) => handlePlan(projectId, parentIssue, opts),
      ),
    );

  workflow
    .command("validate-plan")
    .argument("<path>", "Path to a task-plan YAML file")
    .action(withCommandErrors(async (taskPlanPath: string) => handleValidatePlan(taskPlanPath)));

  workflow
    .command("create-issues")
    .argument("<project>", "Project ID from config")
    .argument("<taskPlan>", "Task-plan path")
    .option("--lineage <path>", "Lineage artifact path")
    .action(
      withCommandErrors(
        async (projectId: string, taskPlanPath: string, opts: { lineage?: string }) =>
          handleCreateIssues(projectId, taskPlanPath, opts),
      ),
    );

  workflow
    .command("lineage")
    .argument("<project>", "Project ID from config")
    .argument("<parentIssue>", "Parent issue identifier")
    .action(withCommandErrors(async (projectId: string, parentIssue: string) => handleLineage(projectId, parentIssue)));

  workflow
    .command("audit-lineage")
    .argument("<project>", "Project ID from config")
    .requiredOption("--lineage <path>", "Lineage artifact path")
    .option("--task-plan <path>", "Explicit task-plan path override")
    .option("--repair", "Apply deterministic repairs in place")
    .action(
      withCommandErrors(
        async (
          projectId: string,
          opts: { lineage: string; taskPlan?: string; repair?: boolean },
        ) => handleAuditLineage(projectId, opts),
      ),
    );

  workflow
    .command("implement")
    .argument("<project>", "Project ID from config")
    .argument("<parentIssue>", "Parent issue identifier")
    .option("--concurrency <n>", "Maximum concurrent implementation sessions")
    .action(
      withCommandErrors(
        async (
          projectId: string,
          parentIssue: string,
          opts: { concurrency?: string },
        ) => handleImplement(projectId, parentIssue, opts),
      ),
    );

  workflow
    .command("review")
    .argument("<project>", "Project ID from config")
    .argument("<reference>", "Child issue ref or PR ref")
    .action(withCommandErrors(async (projectId: string, reference: string) => handleReview(projectId, reference)));

  workflow
    .command("review-outcome")
    .argument("<project>", "Project ID from config")
    .argument("<reference>", "Child issue ref or PR ref")
    .requiredOption("--outcome <outcome>", "approve | request_changes | create_follow_up | update_parent_summary")
    .requiredOption("--summary <summary>", "Structured summary of the review decision")
    .option("--follow-up-title <title>", "Title for the created follow-up issue")
    .action(
      withCommandErrors(
        async (
          projectId: string,
          reference: string,
          opts: { outcome: ReviewOutcome; summary: string; followUpTitle?: string },
        ) => handleReviewOutcome(projectId, reference, opts),
      ),
    );

  workflow
    .command("set-state")
    .argument("<project>", "Project ID from config")
    .argument("<childRef>", "Child issue reference")
    .argument("<state>", `One of: ${TASK_LINEAGE_STATES_TEXT}`)
    .action(
      withCommandErrors(
        async (projectId: string, childRef: string, nextState: string) =>
          handleSetState(projectId, childRef, nextState),
      ),
    );

  workflow
    .command("relocate-task-plan")
    .argument("<project>", "Project ID from config")
    .argument("<parentIssue>", "Parent issue identifier")
    .argument("<path>", "New task-plan path")
    .action(
      withCommandErrors(
        async (projectId: string, parentIssue: string, nextTaskPlanPath: string) =>
          handleRelocateTaskPlan(projectId, parentIssue, nextTaskPlanPath),
      ),
    );
}

const TASK_LINEAGE_STATES_TEXT = [
  "queued",
  "in_progress",
  "blocked",
  "pr_opened",
  "waiting_review",
  "changes_requested",
  "approved",
  "done",
].join(", ");
