/**
 * Core Session → DashboardSession serialization.
 *
 * Converts core types (Date objects, PRInfo) into dashboard types
 * (string dates, flattened DashboardPR) suitable for JSON serialization.
 */

import {
  type Session,
  type Agent,
  type SCM,
  type PRInfo,
  type Tracker,
  type ProjectConfig,
  type OrchestratorConfig,
  type PluginRegistry,
  type TaskLineage,
  type TaskLineageChildIssue,
  findTaskLineageByChildIssue,
  findTaskLineageByParentIssue,
  findTaskLineageBySession,
  resolveModelRuntimeConfig,
} from "@composio/ao-core";
import type {
  DashboardSession,
  DashboardPR,
  DashboardStats,
  DashboardPromptPolicy,
  DashboardSessionRuntime,
  DashboardWorkflowChild,
  DashboardWorkflowContext,
  DashboardWorkflowEvent,
  DashboardWorkflowParent,
} from "./types.js";
import { TTLCache, prCache, prCacheKey, type PREnrichmentData } from "./cache";

/** Cache for issue titles (5 min TTL — issue titles rarely change) */
const issueTitleCache = new TTLCache<string>(300_000);
const workflowParentCache = new TTLCache<DashboardWorkflowParent>(300_000);

/** Resolve which project a session belongs to. */
export function resolveProject(
  core: Session,
  projects: Record<string, ProjectConfig>,
): ProjectConfig | undefined {
  // Try explicit projectId first
  const direct = projects[core.projectId];
  if (direct) return direct;

  // Match by session prefix
  const entry = Object.entries(projects).find(([, p]) => core.id.startsWith(p.sessionPrefix));
  if (entry) return entry[1];

  // Fall back to first project
  const firstKey = Object.keys(projects)[0];
  return firstKey ? projects[firstKey] : undefined;
}

function emptyRuntimeMetadata(): DashboardSessionRuntime {
  return {
    role: null,
    agent: null,
    provider: null,
    model: null,
    authProfile: null,
    authMode: null,
    promptPolicy: null,
  };
}

function parseMetadataStringArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    }
    if (typeof parsed === "string" && parsed.length > 0) {
      return [parsed];
    }
  } catch {
    // Fall back to treating the raw value as a single entry.
  }
  return value.trim() ? [value.trim()] : [];
}

function readPromptPolicyFromMetadata(metadata: Session["metadata"]): DashboardPromptPolicy | null {
  const rulesFiles = parseMetadataStringArray(metadata["promptRulesFiles"]);
  const promptPrefix = metadata["promptPrefix"]?.trim() || null;
  const guardrails = parseMetadataStringArray(metadata["promptGuardrails"]);

  if (rulesFiles.length === 0 && !promptPrefix && guardrails.length === 0) {
    return null;
  }

  return {
    rulesFiles,
    promptPrefix,
    guardrails,
    source: "metadata",
  };
}

function resolvePromptPolicyFromConfig(
  session: Session,
  config: OrchestratorConfig,
  agent: string | null,
): DashboardPromptPolicy | null {
  const roleKey = session.metadata["role"];
  if (!agent || !roleKey || roleKey === "orchestrator") {
    return null;
  }

  try {
    const resolved = resolveModelRuntimeConfig({
      config,
      projectId: session.projectId,
      agent,
      roleKey,
    });
    const rulesFiles = resolved.promptSettings.rulesFiles ?? [];
    const promptPrefix = resolved.promptSettings.promptPrefix ?? null;
    const guardrails = resolved.promptSettings.guardrails ?? [];

    if (rulesFiles.length === 0 && !promptPrefix && guardrails.length === 0) {
      return null;
    }

    return {
      rulesFiles,
      promptPrefix,
      guardrails,
      source: "resolved-config",
    };
  } catch {
    return null;
  }
}

function formatActivityLabel(activity: Session["activity"]): string {
  if (!activity) return "Unknown";
  return activity.replace(/_/g, " ");
}

function pickLatestEvent(events: DashboardWorkflowEvent[]): DashboardWorkflowEvent | null {
  const withTimestamps = events.filter((event) => event.at && !Number.isNaN(Date.parse(event.at)));
  if (withTimestamps.length === 0) {
    return events[0] ?? null;
  }
  return withTimestamps.sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""))[0] ?? null;
}

function getLatestWorkflowEvent(
  session: Session,
  lineage: TaskLineage,
  child: TaskLineageChildIssue | null,
): DashboardWorkflowEvent | null {
  const events: DashboardWorkflowEvent[] = [
    {
      label: "Session activity",
      at: session.lastActivityAt.toISOString(),
      description: `${formatActivityLabel(session.activity)} · ${session.status.replace(/_/g, " ")}`,
    },
  ];

  if (lineage.updatedAt) {
    events.push({
      label: "Lineage updated",
      at: lineage.updatedAt,
      description: `${lineage.childIssues.length} child issue${
        lineage.childIssues.length === 1 ? "" : "s"
      } tracked`,
    });
  }

  if (lineage.planningSession) {
    events.push({
      label: "Planning session started",
      at: lineage.planningSession.createdAt,
      description: lineage.planningSession.sessionId,
    });
  }

  if (child) {
    const implementation = [...child.implementationSessions].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )[0];
    const review = [...child.reviewSessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    if (implementation) {
      events.push({
        label: "Implementation session started",
        at: implementation.createdAt,
        description: implementation.sessionId,
      });
    }

    if (review) {
      events.push({
        label: "Review session started",
        at: review.createdAt,
        description: review.sessionId,
      });
    }

    if (child.pr) {
      events.push({
        label: "PR updated",
        at: child.pr.updatedAt,
        description:
          child.pr.number !== undefined
            ? `PR #${child.pr.number}${child.pr.state ? ` · ${child.pr.state}` : ""}`
            : child.pr.url,
      });
    }
  }

  return pickLatestEvent(events);
}

function buildWorkflowChildren(
  lineage: TaskLineage,
  currentChildIssueId: string | null,
): DashboardWorkflowChild[] {
  return lineage.childIssues.map((child) => ({
    taskIndex: child.taskIndex,
    title: child.title,
    issueId: child.issueId,
    issueUrl: child.issueUrl,
    issueLabel: child.issueLabel,
    state: child.state,
    isCurrent: currentChildIssueId === child.issueId,
    hasPR: child.pr !== null,
    prUrl: child.pr?.url ?? null,
    prNumber: child.pr?.number ?? null,
    implementationSessionCount: child.implementationSessions.length,
    reviewSessionCount: child.reviewSessions.length,
  }));
}

async function resolveWorkflowParent(
  lineage: TaskLineage,
  project: ProjectConfig,
  tracker: Tracker | null,
): Promise<DashboardWorkflowParent> {
  const cacheKey = `${project.path}:${lineage.parentIssue}`;
  const cached = workflowParentCache.get(cacheKey);
  if (cached) return cached;

  let issueUrl: string | null = null;
  let issueLabel = lineage.parentIssue;
  let issueTitle: string | null = null;

  if (tracker?.issueUrl) {
    try {
      issueUrl = tracker.issueUrl(lineage.parentIssue, project);
    } catch {
      issueUrl = null;
    }
  }

  if (issueUrl && tracker?.issueLabel) {
    try {
      issueLabel = tracker.issueLabel(issueUrl, project);
    } catch {
      issueLabel = lineage.parentIssue;
    }
  }

  if (issueUrl) {
    const cachedTitle = issueTitleCache.get(issueUrl);
    if (cachedTitle) {
      issueTitle = cachedTitle;
    }
  }

  if (!issueTitle) {
    try {
      const issue = await tracker?.getIssue(lineage.parentIssue, project);
      if (issue?.title) {
        issueTitle = issue.title;
        if (issueUrl) {
          issueTitleCache.set(issueUrl, issue.title);
        }
      }
    } catch {
      issueTitle = null;
    }
  }

  const parent: DashboardWorkflowParent = {
    issueId: lineage.parentIssue,
    issueUrl,
    issueLabel,
    issueTitle,
    childCount: lineage.childIssues.length,
  };
  workflowParentCache.set(cacheKey, parent);
  return parent;
}

async function resolveWorkflowContext(
  session: Session,
  project: ProjectConfig,
  tracker: Tracker | null,
): Promise<DashboardWorkflowContext | null> {
  const bySession = findTaskLineageBySession(project.path, session.id);
  const byChildIssue = session.issueId ? findTaskLineageByChildIssue(project.path, session.issueId) : null;
  const byParentIssue = session.issueId
    ? findTaskLineageByParentIssue(project.path, session.issueId)
    : null;

  if (!bySession && !byChildIssue && !byParentIssue) {
    return null;
  }

  const lineageMatch =
    bySession ??
    byChildIssue ??
    (byParentIssue ? { filePath: byParentIssue.filePath, lineage: byParentIssue.lineage, childIndex: null } : null);

  if (!lineageMatch) return null;

  let relationship: DashboardWorkflowContext["relationship"] = "parent";
  if (bySession) {
    relationship = bySession.childIndex === null ? "planning" : "child";
  } else if (byChildIssue) {
    relationship = "child";
  }

  const currentChildIndex =
    bySession && bySession.childIndex !== null
      ? bySession.childIndex
      : byChildIssue
        ? byChildIssue.childIndex
        : null;
  const currentChild = currentChildIndex !== null
    ? lineageMatch.lineage.childIssues[currentChildIndex] ?? null
    : null;
  const children = buildWorkflowChildren(lineageMatch.lineage, currentChild?.issueId ?? null);
  const parent = await resolveWorkflowParent(lineageMatch.lineage, project, tracker);

  let relationshipLabel = `parent of ${children.length} child issue${children.length === 1 ? "" : "s"}`;
  let state: string | null = "parent";
  if (relationship === "planning") {
    relationshipLabel = `planning ${lineageMatch.lineage.parentIssue}`;
    state = "planning";
  } else if (relationship === "child" && currentChild) {
    relationshipLabel = `child of ${lineageMatch.lineage.parentIssue}`;
    state = currentChild.state;
  }

  return {
    relationship,
    relationshipLabel,
    state,
    lineagePath: lineageMatch.filePath,
    taskPlanPath: lineageMatch.lineage.taskPlanPath,
    parent,
    currentChild: currentChild
      ? children.find((child) => child.issueId === currentChild.issueId) ?? null
      : null,
    children,
    linkage: currentChild
      ? {
          prUrl: currentChild.pr?.url ?? null,
          prNumber: currentChild.pr?.number ?? null,
          prState: currentChild.pr?.state ?? null,
          reviewSessionIds: currentChild.reviewSessions.map((entry) => entry.sessionId),
          implementationSessionIds: currentChild.implementationSessions.map((entry) => entry.sessionId),
        }
      : null,
    latestEvent: getLatestWorkflowEvent(session, lineageMatch.lineage, currentChild),
  };
}

/** Convert a core Session to a DashboardSession (without PR/issue enrichment). */
export function sessionToDashboard(session: Session): DashboardSession {
  const agentSummary = session.agentInfo?.summary;
  const summary = agentSummary ?? session.metadata["summary"] ?? null;
  const runtime = emptyRuntimeMetadata();

  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    activity: session.activity,
    branch: session.branch,
    issueId: session.issueId, // Deprecated: kept for backwards compatibility
    issueUrl: session.issueId, // issueId is actually the full URL
    issueLabel: null, // Will be enriched by enrichSessionIssue()
    issueTitle: null, // Will be enriched by enrichSessionIssueTitle()
    summary,
    summaryIsFallback: agentSummary
      ? (session.agentInfo?.summaryIsFallback ?? false)
      : false,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    pr: session.pr ? basicPRToDashboard(session.pr) : null,
    metadata: session.metadata,
    runtime: {
      ...runtime,
      role: session.metadata["role"] ?? null,
      agent: session.metadata["agent"] ?? null,
      provider: session.metadata["provider"] ?? null,
      model: session.metadata["model"] ?? null,
      authProfile: session.metadata["authProfile"] ?? null,
      authMode: session.metadata["authMode"] ?? null,
      promptPolicy: readPromptPolicyFromMetadata(session.metadata),
    },
    workflow: null,
  };
}

/**
 * Convert minimal PRInfo to a DashboardPR with default values for enriched fields.
 * These defaults indicate "data not yet loaded" rather than "failing".
 * Use enrichSessionPR() to populate with live data from SCM.
 */
function basicPRToDashboard(pr: PRInfo): DashboardPR {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    owner: pr.owner,
    repo: pr.repo,
    branch: pr.branch,
    baseBranch: pr.baseBranch,
    isDraft: pr.isDraft,
    state: "open",
    additions: 0,
    deletions: 0,
    ciStatus: "none", // "none" is neutral (no checks configured)
    ciChecks: [],
    reviewDecision: "none", // "none" is neutral (no review required)
    mergeability: {
      mergeable: false,
      ciPassing: false, // Conservative default
      approved: false,
      noConflicts: true, // Optimistic default (conflicts are rare)
      blockers: ["Data not loaded"], // Explicit blocker
    },
    unresolvedThreads: 0,
    unresolvedComments: [],
  };
}

/**
 * Enrich a DashboardSession's PR with live data from the SCM plugin.
 * Uses cache to reduce API calls and handles rate limit errors gracefully.
 */
export async function enrichSessionPR(
  dashboard: DashboardSession,
  scm: SCM,
  pr: PRInfo,
  opts?: { cacheOnly?: boolean },
): Promise<boolean> {
  if (!dashboard.pr) return false;

  const cacheKey = prCacheKey(pr.owner, pr.repo, pr.number);

  // Check cache first
  const cached = prCache.get(cacheKey);
  if (cached && dashboard.pr) {
    dashboard.pr.state = cached.state;
    dashboard.pr.title = cached.title;
    dashboard.pr.additions = cached.additions;
    dashboard.pr.deletions = cached.deletions;
    dashboard.pr.ciStatus = cached.ciStatus;
    dashboard.pr.ciChecks = cached.ciChecks;
    dashboard.pr.reviewDecision = cached.reviewDecision;
    dashboard.pr.mergeability = cached.mergeability;
    dashboard.pr.unresolvedThreads = cached.unresolvedThreads;
    dashboard.pr.unresolvedComments = cached.unresolvedComments;
    return true;
  }

  // Cache miss — if cacheOnly, signal caller to refresh in background
  if (opts?.cacheOnly) return false;

  // Fetch from SCM
  const results = await Promise.allSettled([
    scm.getPRSummary
      ? scm.getPRSummary(pr)
      : scm.getPRState(pr).then((state) => ({ state, title: "", additions: 0, deletions: 0 })),
    scm.getCIChecks(pr),
    scm.getCISummary(pr),
    scm.getReviewDecision(pr),
    scm.getMergeability(pr),
    scm.getPendingComments(pr),
  ]);

  const [summaryR, checksR, ciR, reviewR, mergeR, commentsR] = results;

  // Check if most critical requests failed (likely rate limit)
  // Note: Some methods (like getCISummary) return fallback values instead of rejecting,
  // so we can't rely on "all rejected" — check if majority failed instead
  const failedCount = results.filter((r) => r.status === "rejected").length;
  const mostFailed = failedCount >= results.length / 2;

  if (mostFailed) {
    const rejectedResults = results.filter(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult[];
    const firstError = rejectedResults[0]?.reason;
    console.warn(
      `[enrichSessionPR] ${failedCount}/${results.length} API calls failed for PR #${pr.number} (rate limited or unavailable):`,
      String(firstError),
    );
    // Don't return early — apply any successful results below
  }

  // Apply successful results
  if (summaryR.status === "fulfilled") {
    dashboard.pr.state = summaryR.value.state;
    dashboard.pr.additions = summaryR.value.additions;
    dashboard.pr.deletions = summaryR.value.deletions;
    if (summaryR.value.title) {
      dashboard.pr.title = summaryR.value.title;
    }
  }

  if (checksR.status === "fulfilled") {
    dashboard.pr.ciChecks = checksR.value.map((c) => ({
      name: c.name,
      status: c.status,
      url: c.url,
    }));
  }

  if (ciR.status === "fulfilled") {
    dashboard.pr.ciStatus = ciR.value;
  }

  if (reviewR.status === "fulfilled") {
    dashboard.pr.reviewDecision = reviewR.value;
  }

  if (mergeR.status === "fulfilled") {
    dashboard.pr.mergeability = mergeR.value;
  } else {
    // Mergeability failed — mark as unavailable
    dashboard.pr.mergeability.blockers = ["Merge status unavailable"];
  }

  if (commentsR.status === "fulfilled") {
    const comments = commentsR.value;
    dashboard.pr.unresolvedThreads = comments.length;
    dashboard.pr.unresolvedComments = comments.map((c) => ({
      url: c.url,
      path: c.path ?? "",
      author: c.author,
      body: c.body,
    }));
  }

  // Add rate-limit warning blocker if most requests failed
  // (but we still applied any successful results above)
  if (
    mostFailed &&
    !dashboard.pr.mergeability.blockers.includes("API rate limited or unavailable")
  ) {
    dashboard.pr.mergeability.blockers.push("API rate limited or unavailable");
  }

  // If rate limited, cache the partial data with a long TTL (5 min) so we stop
  // hammering the API on every page load. The rate-limit blocker flag tells the
  // UI to show stale-data warnings instead of making decisions on bad data.
  if (mostFailed) {
    const rateLimitedData: PREnrichmentData = {
      state: dashboard.pr.state,
      title: dashboard.pr.title,
      additions: dashboard.pr.additions,
      deletions: dashboard.pr.deletions,
      ciStatus: dashboard.pr.ciStatus,
      ciChecks: dashboard.pr.ciChecks,
      reviewDecision: dashboard.pr.reviewDecision,
      mergeability: dashboard.pr.mergeability,
      unresolvedThreads: dashboard.pr.unresolvedThreads,
      unresolvedComments: dashboard.pr.unresolvedComments,
    };
    prCache.set(cacheKey, rateLimitedData, 60 * 60_000); // 60 min — GitHub rate limit resets hourly
    return true;
  }

  const cacheData: PREnrichmentData = {
    state: dashboard.pr.state,
    title: dashboard.pr.title,
    additions: dashboard.pr.additions,
    deletions: dashboard.pr.deletions,
    ciStatus: dashboard.pr.ciStatus,
    ciChecks: dashboard.pr.ciChecks,
    reviewDecision: dashboard.pr.reviewDecision,
    mergeability: dashboard.pr.mergeability,
    unresolvedThreads: dashboard.pr.unresolvedThreads,
    unresolvedComments: dashboard.pr.unresolvedComments,
  };
  prCache.set(cacheKey, cacheData);
  return true;
}

/** Enrich a DashboardSession's issue label using the tracker plugin. */
export function enrichSessionIssue(
  dashboard: DashboardSession,
  tracker: Tracker,
  project: ProjectConfig,
): void {
  if (!dashboard.issueUrl) return;

  // Use tracker plugin to extract human-readable label from URL
  if (tracker.issueLabel) {
    try {
      dashboard.issueLabel = tracker.issueLabel(dashboard.issueUrl, project);
    } catch {
      // If extraction fails, fall back to extracting from URL manually
      const parts = dashboard.issueUrl.split("/");
      dashboard.issueLabel = parts[parts.length - 1] || dashboard.issueUrl;
    }
  } else {
    // Fallback if tracker doesn't implement issueLabel method
    const parts = dashboard.issueUrl.split("/");
    dashboard.issueLabel = parts[parts.length - 1] || dashboard.issueUrl;
  }
}

/**
 * Enrich a DashboardSession's summary by calling agent.getSessionInfo().
 * Only fetches when the session doesn't already have a summary.
 * Reads the agent's JSONL file on disk — fast local I/O, not an API call.
 */
export async function enrichSessionAgentSummary(
  dashboard: DashboardSession,
  coreSession: Session,
  agent: Agent,
): Promise<void> {
  if (dashboard.summary) return;
  try {
    const info = await agent.getSessionInfo(coreSession);
    if (info?.summary) {
      dashboard.summary = info.summary;
      dashboard.summaryIsFallback = info.summaryIsFallback ?? false;
    }
  } catch {
    // Can't read agent session info — keep summary null
  }
}

/**
 * Enrich a DashboardSession's issue title by calling tracker.getIssue().
 * Extracts the identifier from the issue URL using issueLabel(),
 * then fetches full issue details for the title.
 */
export async function enrichSessionIssueTitle(
  dashboard: DashboardSession,
  tracker: Tracker,
  project: ProjectConfig,
): Promise<void> {
  if (!dashboard.issueUrl || !dashboard.issueLabel) return;

  // Check cache first
  const cached = issueTitleCache.get(dashboard.issueUrl);
  if (cached) {
    dashboard.issueTitle = cached;
    return;
  }

  try {
    // Strip "#" prefix from GitHub-style labels to get the identifier
    const identifier = dashboard.issueLabel.replace(/^#/, "");
    const issue = await tracker.getIssue(identifier, project);
    if (issue.title) {
      dashboard.issueTitle = issue.title;
      issueTitleCache.set(dashboard.issueUrl, issue.title);
    }
  } catch {
    // Can't fetch issue — keep issueTitle null
  }
}

/**
 * Enrich dashboard sessions with metadata (issue labels, agent summaries, issue titles).
 * Orchestrates sync + async enrichment in parallel. Does NOT enrich PR data — callers
 * handle that separately since strategies differ (e.g. terminal-session cache optimization).
 */
export async function enrichSessionsMetadata(
  coreSessions: Session[],
  dashboardSessions: DashboardSession[],
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Promise<void> {
  // Resolve projects once per session (avoids repeated Object.entries lookups)
  const projects = coreSessions.map((core) => resolveProject(core, config.projects));
  const trackers = projects.map((project) =>
    project?.tracker ? registry.get<Tracker>("tracker", project.tracker.plugin) : null,
  );

  coreSessions.forEach((core, i) => {
    const project = projects[i];
    const agent = core.metadata["agent"] ?? project?.agent ?? config.defaults.agent ?? null;
    dashboardSessions[i].runtime = {
      role: core.metadata["role"] ?? null,
      agent,
      provider: core.metadata["provider"] ?? null,
      model: core.metadata["model"] ?? null,
      authProfile: core.metadata["authProfile"] ?? null,
      authMode: core.metadata["authMode"] ?? null,
      promptPolicy:
        readPromptPolicyFromMetadata(core.metadata) ??
        resolvePromptPolicyFromConfig(core, config, agent),
    };
  });

  // Enrich issue labels (synchronous — must run before async title enrichment)
  projects.forEach((project, i) => {
    if (!dashboardSessions[i].issueUrl || !project?.tracker) return;
    const tracker = trackers[i];
    if (!tracker) return;
    enrichSessionIssue(dashboardSessions[i], tracker, project);
  });

  // Enrich agent summaries (reads agent's JSONL — local I/O, not an API call)
  const summaryPromises = coreSessions.map((core, i) => {
    if (dashboardSessions[i].summary) return Promise.resolve();
    const agentName = projects[i]?.agent ?? config.defaults.agent;
    if (!agentName) return Promise.resolve();
    const agent = registry.get<Agent>("agent", agentName);
    if (!agent) return Promise.resolve();
    return enrichSessionAgentSummary(dashboardSessions[i], core, agent);
  });

  // Enrich issue titles (fetches from tracker API, cached with TTL)
  const issueTitlePromises = projects.map((project, i) => {
    if (!dashboardSessions[i].issueUrl || !dashboardSessions[i].issueLabel) {
      return Promise.resolve();
    }
    if (!project) return Promise.resolve();
    const tracker = trackers[i];
    if (!tracker) return Promise.resolve();
    return enrichSessionIssueTitle(dashboardSessions[i], tracker, project);
  });

  const workflowPromises = projects.map((project, i) => {
    if (!project) {
      dashboardSessions[i].workflow = null;
      return Promise.resolve();
    }
    return resolveWorkflowContext(coreSessions[i], project, trackers[i]).then((workflow) => {
      dashboardSessions[i].workflow = workflow;
    });
  });

  await Promise.allSettled([...summaryPromises, ...issueTitlePromises, ...workflowPromises]);
}

/** Compute dashboard stats from a list of sessions. */
export function computeStats(sessions: DashboardSession[]): DashboardStats {
  return {
    totalSessions: sessions.length,
    workingSessions: sessions.filter((s) => s.activity !== null && s.activity !== "exited").length,
    openPRs: sessions.filter((s) => s.pr?.state === "open").length,
    needsReview: sessions.filter((s) => s.pr && !s.pr.isDraft && s.pr.reviewDecision === "pending")
      .length,
  };
}
