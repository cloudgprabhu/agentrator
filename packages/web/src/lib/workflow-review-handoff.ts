import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  TERMINAL_STATUSES,
  findTaskLineageByPREvent,
  readTaskPlanFile,
  type OrchestratorConfig,
  type ProjectConfig,
  type SCMWebhookEvent,
  type Session,
  type SessionManager,
  type Tracker,
} from "@composio/ao-core";

const HANDOFF_TTL_MS = 10 * 60_000;
const HANDOFF_STORE_DIR = join(".ao", "webhook-review-handoffs");

export interface WorkflowReviewHandoffResult {
  spawnedSessionId?: string;
  skippedReason?: string;
  childIssueId?: string;
  parentIssue?: string;
}

function resolveProjectFilePath(projectPath: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(projectPath, filePath);
}

function getHandoffStorePath(projectPath: string): string {
  return join(projectPath, HANDOFF_STORE_DIR);
}

function getHandoffClaimFilePath(projectPath: string, handoffKey: string): string {
  const digest = createHash("sha1").update(handoffKey).digest("hex");
  return join(getHandoffStorePath(projectPath), `${digest}.json`);
}

function readHandoffClaim(filePath: string): { key: string; claimedAt: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as {
      key?: unknown;
      claimedAt?: unknown;
    };
    if (typeof parsed.key !== "string" || typeof parsed.claimedAt !== "number") {
      return null;
    }
    return { key: parsed.key, claimedAt: parsed.claimedAt };
  } catch {
    return null;
  }
}

function isExpiredClaim(claim: { claimedAt: number } | null, now = Date.now()): boolean {
  if (!claim) return true;
  return now - claim.claimedAt > HANDOFF_TTL_MS;
}

function prunePersistedHandoffs(projectPath: string, now = Date.now()): void {
  const storePath = getHandoffStorePath(projectPath);
  try {
    for (const entry of readdirSync(storePath)) {
      if (!entry.endsWith(".json")) continue;
      const filePath = join(storePath, entry);
      const claim = readHandoffClaim(filePath);
      if (isExpiredClaim(claim, now)) {
        rmSync(filePath, { force: true });
      }
    }
  } catch {
    // Ignore missing/unreadable dedupe stores and continue best-effort.
  }
}

function claimWorkflowHandoff(projectPath: string, handoffKey: string): { duplicate: boolean; filePath: string } {
  const storePath = getHandoffStorePath(projectPath);
  const filePath = getHandoffClaimFilePath(projectPath, handoffKey);

  mkdirSync(storePath, { recursive: true });
  prunePersistedHandoffs(projectPath);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = Date.now();
    try {
      writeFileSync(
        filePath,
        JSON.stringify({ key: handoffKey, claimedAt: now }),
        { encoding: "utf-8", flag: "wx" },
      );
      return { duplicate: false, filePath };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }

      const existing = readHandoffClaim(filePath);
      if (isExpiredClaim(existing, now)) {
        rmSync(filePath, { force: true });
        continue;
      }

      return { duplicate: true, filePath };
    }
  }

  return { duplicate: true, filePath };
}

function releaseWorkflowHandoffClaim(filePath: string | null | undefined): void {
  if (!filePath) return;
  rmSync(filePath, { force: true });
}

function buildHandoffKey(projectId: string, event: SCMWebhookEvent): string | null {
  const prRef = event.prNumber !== undefined ? String(event.prNumber) : event.branch;
  if (!prRef) return null;
  const burstRef = event.sha
    ? `sha:${event.sha}`
    : event.deliveryId
      ? `delivery:${event.deliveryId}`
      : `branch:${event.branch ?? "no-ref"}`;
  return [
    projectId,
    event.action,
    prRef,
    burstRef,
  ].join(":");
}

function hasActiveReviewerSession(
  sessions: Session[],
  projectId: string,
  childIssueId: string,
  reviewRole: string,
): boolean {
  return sessions.some((session) => {
    if (session.projectId !== projectId) return false;
    if (session.issueId !== childIssueId) return false;
    if (TERMINAL_STATUSES.has(session.status)) return false;
    return session.metadata["role"] === reviewRole;
  });
}

function buildReviewerPrompt(
  project: ProjectConfig,
  tracker: Tracker,
  reviewRole: string,
  context: {
    parentIssue: string;
    lineagePath: string;
    childIssueId: string;
    childIssueLabel: string;
    childTitle: string;
    childState: string;
    childIssueUrl: string;
    prUrl?: string;
    prState?: string;
    taskSummary: string;
    acceptanceCriteria: string[];
    dependencies: string[];
    suggestedFiles: string[];
    specPath: string | null;
    adrPath: string | null;
  },
): string {
  const lines: string[] = [];
  lines.push("## Workflow Review Handoff");
  lines.push(`- Review role: ${reviewRole}`);
  lines.push(`- Parent issue: ${context.parentIssue}`);
  lines.push(`- Parent URL: ${tracker.issueUrl(context.parentIssue, project)}`);
  lines.push(`- Child issue: ${context.childIssueLabel} (${context.childIssueId})`);
  lines.push(`- Child URL: ${context.childIssueUrl}`);
  lines.push(`- Child state: ${context.childState}`);
  lines.push(`- Lineage file: ${context.lineagePath}`);
  if (context.prUrl) lines.push(`- PR: ${context.prUrl}`);
  if (context.prState) lines.push(`- PR state: ${context.prState}`);

  lines.push("");
  lines.push("## Task Summary");
  lines.push(context.taskSummary);

  lines.push("");
  lines.push("## Acceptance Criteria");
  for (const item of context.acceptanceCriteria) {
    lines.push(`- ${item}`);
  }

  lines.push("");
  lines.push("## Dependencies");
  if (context.dependencies.length === 0) {
    lines.push("- None");
  } else {
    for (const item of context.dependencies) {
      lines.push(`- ${item}`);
    }
  }

  lines.push("");
  lines.push("## Suggested Files");
  if (context.suggestedFiles.length === 0) {
    lines.push("- None");
  } else {
    for (const item of context.suggestedFiles) {
      lines.push(`- ${item}`);
    }
  }

  if (context.specPath) {
    lines.push("");
    lines.push("## Spec");
    lines.push(`- ${context.specPath}`);
  }

  if (context.adrPath) {
    lines.push("");
    lines.push("## ADR");
    lines.push(`- ${context.adrPath}`);
  }

  lines.push("");
  lines.push("## Review Instructions");
  lines.push("- Review the implementation against the acceptance criteria and linked design artifacts.");
  lines.push("- Inspect the PR diff when available and call out concrete defects first.");
  lines.push("- End with one explicit outcome: approved, changes_requested, blocked, or done.");
  return lines.join("\n");
}

export async function maybeAutoSpawnWorkflowReviewer(opts: {
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
  tracker: Tracker;
  sessionManager: SessionManager;
  sessions: Session[];
  event: SCMWebhookEvent;
}): Promise<WorkflowReviewHandoffResult | null> {
  const { config, projectId, project, tracker, sessionManager, sessions, event } = opts;
  if (event.kind !== "pull_request") return null;
  if (event.action !== "opened" && event.action !== "synchronize") return null;

  const workflowKey = project.workflow;
  const workflowConfig = workflowKey ? config.workflow?.[workflowKey] : undefined;
  const reviewRole = workflowConfig?.reviewRole;
  if (!workflowKey || !workflowConfig || !reviewRole) return null;

  const handoffKey = buildHandoffKey(projectId, event);
  const match = findTaskLineageByPREvent(project.path, {
    prNumber: event.prNumber,
    branch: event.branch,
  });
  if (!match) {
    return { skippedReason: "no_lineage_match" };
  }

  const child = match.lineage.childIssues[match.childIndex];
  if (!child) {
    return { skippedReason: "no_child_issue" };
  }

  if (child.state === "approved" || child.state === "done") {
    return {
      skippedReason: "child_already_complete",
      childIssueId: child.issueId,
      parentIssue: match.lineage.parentIssue,
    };
  }

  if (hasActiveReviewerSession(sessions, projectId, child.issueId, reviewRole)) {
    return {
      skippedReason: "reviewer_already_active",
      childIssueId: child.issueId,
      parentIssue: match.lineage.parentIssue,
    };
  }

  const handoffClaim =
    handoffKey ? claimWorkflowHandoff(project.path, handoffKey) : null;
  if (handoffClaim?.duplicate) {
    return {
      skippedReason: "duplicate_delivery",
      childIssueId: child.issueId,
      parentIssue: match.lineage.parentIssue,
    };
  }

  const taskPlan = readTaskPlanFile(resolveProjectFilePath(project.path, match.lineage.taskPlanPath));
  const childTask = taskPlan.childTasks[child.taskIndex];
  if (!childTask) {
    releaseWorkflowHandoffClaim(handoffClaim?.filePath);
    return {
      skippedReason: "missing_task_plan_entry",
      childIssueId: child.issueId,
      parentIssue: match.lineage.parentIssue,
    };
  }

  try {
    const session = await sessionManager.spawn({
      projectId,
      issueId: child.issueId,
      role: reviewRole,
      prompt: buildReviewerPrompt(project, tracker, reviewRole, {
        parentIssue: match.lineage.parentIssue,
        lineagePath: match.filePath,
        childIssueId: child.issueId,
        childIssueLabel: child.issueLabel,
        childTitle: child.title,
        childState: child.state,
        childIssueUrl: child.issueUrl,
        prUrl: child.pr?.url,
        prState: child.pr?.state,
        taskSummary: childTask.summary,
        acceptanceCriteria: childTask.acceptanceCriteria,
        dependencies: childTask.dependencies,
        suggestedFiles: childTask.suggestedFiles,
        specPath: taskPlan.specPath,
        adrPath: taskPlan.adrPath,
      }),
    });

    return {
      spawnedSessionId: session.id,
      childIssueId: child.issueId,
      parentIssue: match.lineage.parentIssue,
    };
  } catch (error) {
    releaseWorkflowHandoffClaim(handoffClaim?.filePath);
    throw error;
  }
}
