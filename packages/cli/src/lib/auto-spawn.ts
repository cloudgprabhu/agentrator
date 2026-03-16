import chalk from "chalk";
import {
  TERMINAL_STATUSES,
  type OrchestratorConfig,
  type Session,
  type SessionManager,
  type Tracker,
} from "@composio/ao-core";
import { getPluginRegistry, getSessionManager } from "./create-session-manager.js";
import { exec } from "./shell.js";

const DEFAULT_SPAWN_DELAY_MS = 500;
const AUTO_SPAWN_ISSUE_LIMIT = 200;

export interface SpawnIssuesWithDedupOptions {
  config: OrchestratorConfig;
  projectId: string;
  issues: readonly string[];
  delayMs?: number;
  openTabs?: boolean;
  verbose?: boolean;
  sessionManager?: SessionManager;
}

export interface SpawnIssueResult {
  issue: string;
  session: string;
}

export interface SkippedIssueResult {
  issue: string;
  existing: string;
}

export interface FailedIssueResult {
  issue: string;
  error: string;
}

export interface SpawnIssuesSummary {
  created: SpawnIssueResult[];
  skipped: SkippedIssueResult[];
  failed: FailedIssueResult[];
}

export interface AutoSpawnSummary extends SpawnIssuesSummary {
  openIssues: string[];
}

function normalizeIssueId(issue: string): string {
  return issue.trim().toLowerCase();
}

function hasActiveIssue(
  session: Session,
): session is Session & {
  issueId: string;
} {
  return Boolean(session.issueId) && !TERMINAL_STATUSES.has(session.status);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeOpenTab(sessionId: string): Promise<void> {
  try {
    await exec("open-iterm-tab", [sessionId]);
  } catch {
    // best effort
  }
}

async function getProjectTracker(
  config: OrchestratorConfig,
  projectId: string,
): Promise<Tracker> {
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  if (!project.tracker) {
    throw new Error(`Project ${projectId} does not have a tracker configured.`);
  }

  const registry = await getPluginRegistry(config);
  const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
  if (!tracker) {
    throw new Error(`Tracker plugin "${project.tracker.plugin}" is not available.`);
  }

  return tracker;
}

export async function spawnIssuesWithDedup(
  options: SpawnIssuesWithDedupOptions,
): Promise<SpawnIssuesSummary> {
  const {
    config,
    projectId,
    issues,
    delayMs = DEFAULT_SPAWN_DELAY_MS,
    openTabs = false,
    verbose = false,
  } = options;
  const sm = options.sessionManager ?? (await getSessionManager(config));

  const created: SpawnIssueResult[] = [];
  const skipped: SkippedIssueResult[] = [];
  const failed: FailedIssueResult[] = [];
  const spawnedIssues = new Set<string>();

  const existingSessions = await sm.list(projectId);
  const existingIssueMap = new Map(
    existingSessions
      .filter(hasActiveIssue)
      .map((session) => [normalizeIssueId(session.issueId), session.id]),
  );

  for (const [index, issue] of issues.entries()) {
    const normalizedIssue = normalizeIssueId(issue);
    if (!normalizedIssue) continue;

    if (spawnedIssues.has(normalizedIssue)) {
      if (verbose) {
        console.log(chalk.yellow(`  Skip ${issue} — duplicate in this batch`));
      }
      skipped.push({ issue, existing: "(this batch)" });
      continue;
    }

    const existingSessionId = existingIssueMap.get(normalizedIssue);
    if (existingSessionId) {
      if (verbose) {
        console.log(chalk.yellow(`  Skip ${issue} — already has session ${existingSessionId}`));
      }
      skipped.push({ issue, existing: existingSessionId });
      continue;
    }

    try {
      const session = await sm.spawn({ projectId, issueId: issue });
      created.push({ issue, session: session.id });
      spawnedIssues.add(normalizedIssue);

      if (verbose) {
        console.log(chalk.green(`  Created ${session.id} for ${issue}`));
      }

      if (openTabs) {
        await maybeOpenTab(session.runtimeHandle?.id ?? session.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ issue, error: message });

      if (verbose) {
        console.log(chalk.red(`  Failed ${issue} — ${message}`));
      }
    }

    if (index < issues.length - 1) {
      await sleep(delayMs);
    }
  }

  return { created, skipped, failed };
}

export async function autoSpawnOpenIssues(
  config: OrchestratorConfig,
  projectId: string,
  options: Omit<SpawnIssuesWithDedupOptions, "config" | "projectId" | "issues"> = {},
): Promise<AutoSpawnSummary> {
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  const tracker = await getProjectTracker(config, projectId);
  if (!tracker.listIssues) {
    throw new Error(`Tracker plugin "${tracker.name}" does not support listing issues.`);
  }

  const issues = await tracker.listIssues({ state: "open", limit: AUTO_SPAWN_ISSUE_LIMIT }, project);
  const issueIds = issues.map((issue) => issue.id);
  const summary = await spawnIssuesWithDedup({
    ...options,
    config,
    projectId,
    issues: issueIds,
  });

  return {
    ...summary,
    openIssues: issueIds,
  };
}
