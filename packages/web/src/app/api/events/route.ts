import { getServices, startBacklogPoller } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getAttentionLevel } from "@/lib/types";
import { filterWorkerSessions } from "@/lib/project-utils";
import {
  findTaskLineageByChildIssue,
  findTaskLineageByParentIssue,
  findTaskLineageBySession,
  resolveModelRuntimeConfig,
  type Session,
  type OrchestratorConfig,
  type ProjectConfig,
} from "@composio/ao-core";

export const dynamic = "force-dynamic";

function buildRuntimeVersion(
  session: Session,
  config: OrchestratorConfig,
  project: ProjectConfig | undefined,
): string | null {
  const agent = session.metadata["agent"] ?? project?.agent ?? config.defaults.agent ?? null;
  const role = session.metadata["role"] ?? null;
  const provider = session.metadata["provider"] ?? null;
  const model = session.metadata["model"] ?? null;
  const authProfile = session.metadata["authProfile"] ?? null;
  const authMode = session.metadata["authMode"] ?? null;

  let promptRulesFiles: string | null = session.metadata["promptRulesFiles"] ?? null;
  let promptPrefix: string | null = session.metadata["promptPrefix"] ?? null;
  let promptGuardrails: string | null = session.metadata["promptGuardrails"] ?? null;

  if (!promptRulesFiles && !promptPrefix && !promptGuardrails && agent && role && role !== "orchestrator") {
    try {
      const resolved = resolveModelRuntimeConfig({
        config,
        projectId: session.projectId,
        agent,
        roleKey: role,
      });
      promptRulesFiles = JSON.stringify(resolved.promptSettings.rulesFiles ?? []);
      promptPrefix = resolved.promptSettings.promptPrefix ?? null;
      promptGuardrails = JSON.stringify(resolved.promptSettings.guardrails ?? []);
    } catch {
      // Keep runtime signature based only on persisted fields if resolution fails.
    }
  }

  return JSON.stringify({
    role,
    agent,
    provider,
    model,
    authProfile,
    authMode,
    promptRulesFiles,
    promptPrefix,
    promptGuardrails,
  });
}

function buildWorkflowVersion(session: Session, project: ProjectConfig | undefined): string | null {
  if (!project) return null;

  const bySession = findTaskLineageBySession(project.path, session.id);
  const byChildIssue = session.issueId
    ? findTaskLineageByChildIssue(project.path, session.issueId)
    : null;
  const byParentIssue = session.issueId
    ? findTaskLineageByParentIssue(project.path, session.issueId)
    : null;
  const match =
    bySession ??
    byChildIssue ??
    (byParentIssue
      ? { filePath: byParentIssue.filePath, lineage: byParentIssue.lineage, childIndex: null }
      : null);

  if (!match) return null;

  const child = match.childIndex !== null ? match.lineage.childIssues[match.childIndex] ?? null : null;

  return JSON.stringify({
    filePath: match.filePath,
    updatedAt: match.lineage.updatedAt,
    parentIssue: match.lineage.parentIssue,
    childIndex: match.childIndex,
    childState: child?.state ?? null,
    childIssueId: child?.issueId ?? null,
    prUrl: child?.pr?.url ?? null,
    prState: child?.pr?.state ?? null,
    implementationSessions: child?.implementationSessions.length ?? 0,
    reviewSessions: child?.reviewSessions.length ?? 0,
    childCount: match.lineage.childIssues.length,
  });
}

function buildSnapshotSessions(
  sessions: Session[],
  config: OrchestratorConfig,
): Array<{
  id: string;
  status: Session["status"];
  activity: Session["activity"];
  attentionLevel: ReturnType<typeof getAttentionLevel>;
  lastActivityAt: string;
  runtimeVersion: string | null;
  workflowVersion: string | null;
}> {
  return sessions.map((session) => {
    const dashboard = sessionToDashboard(session);
    const project = config.projects[session.projectId];
    return {
      id: dashboard.id,
      status: dashboard.status,
      activity: dashboard.activity,
      attentionLevel: getAttentionLevel(dashboard),
      lastActivityAt: dashboard.lastActivityAt,
      runtimeVersion: buildRuntimeVersion(session, config, project),
      workflowVersion: buildWorkflowVersion(session, project),
    };
  });
}

/** GET /api/events — SSE stream for real-time lifecycle events
 * Query params:
 * - project: Filter to a specific project. "all" = no filter.
 */
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const projectFilter = searchParams.get("project");

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let updates: ReturnType<typeof setInterval> | undefined;

  const filterSessions = (
    sessions: Session[],
    config: { projects: Record<string, { sessionPrefix?: string }> },
  ) => filterWorkerSessions(sessions, projectFilter, config.projects);

  startBacklogPoller();

  const stream = new ReadableStream({
    start(controller) {
      void (async () => {
        try {
          const { sessionManager, config } = await getServices();
          const sessions = await sessionManager.list();
          const filteredSessions = filterSessions(sessions, config);

          const initialEvent = {
            type: "snapshot",
            sessions: buildSnapshotSessions(filteredSessions, config),
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialEvent)}\n\n`));
        } catch {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "snapshot", sessions: [] })}\n\n`),
          );
        }
      })();

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
          clearInterval(updates);
        }
      }, 15000);

      updates = setInterval(() => {
        void (async () => {
          let dashboardSessions;
          try {
            const { sessionManager, config } = await getServices();
            const sessions = await sessionManager.list();
            const filteredSessions = filterSessions(sessions, config);
            dashboardSessions = buildSnapshotSessions(filteredSessions, config);
          } catch {
            return;
          }

          try {
            const event = {
              type: "snapshot",
              sessions: dashboardSessions,
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            clearInterval(updates);
            clearInterval(heartbeat);
          }
        })();
      }, 5000);
    },
    cancel() {
      clearInterval(heartbeat);
      clearInterval(updates);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
