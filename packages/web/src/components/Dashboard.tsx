"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type DashboardIssue,
  type DashboardSession,
  type DashboardStats,
  type DashboardPR,
  type AttentionLevel,
  type GlobalPauseState,
  getAttentionLevel,
  hasActiveOpenPR,
  hasCompletedPR,
  isPRRateLimited,
  sessionNeedsReview,
} from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { AttentionZone } from "./AttentionZone";
import { PRTableRow } from "./PRStatus";
import { DynamicFavicon } from "./DynamicFavicon";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { ProjectSidebar } from "./ProjectSidebar";
import type { ProjectInfo } from "@/lib/project-name";
import { DashboardOverview } from "./DashboardOverview";

interface DashboardProps {
  initialSessions: DashboardSession[];
  initialIssues?: DashboardIssue[];
  orchestratorId?: string | null;
  projectId?: string;
  projectName?: string;
  projects?: ProjectInfo[];
  initialGlobalPause?: GlobalPauseState | null;
}

const KANBAN_LEVELS = ["working", "pending", "review", "respond", "merge"] as const;

export function Dashboard({
  initialSessions,
  initialIssues = [],
  orchestratorId,
  projectId,
  projectName,
  projects = [],
  initialGlobalPause = null,
}: DashboardProps) {
  const { sessions, globalPause } = useSessionEvents(
    initialSessions,
    initialGlobalPause,
    projectId,
  );
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const [globalPauseDismissed, setGlobalPauseDismissed] = useState(false);
  const showSidebar = projects.length > 1;
  const completedPRs = useMemo(
    () =>
      sessions
        .filter(hasCompletedPR)
        .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)),
    [sessions],
  );
  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      merge: [],
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of sessions) {
      zones[getAttentionLevel(session)].push(session);
    }
    return zones;
  }, [sessions]);

  const openPRs = useMemo(() => {
    return sessions
      .filter(hasActiveOpenPR)
      .map((s) => s.pr)
      .sort((a, b) => mergeScore(a) - mergeScore(b));
  }, [sessions]);

  const handleSend = async (sessionId: string, message: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to send message to ${sessionId}:`, await res.text());
    }
  };

  const handleKill = async (sessionId: string) => {
    if (!confirm(`Kill session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to kill ${sessionId}:`, await res.text());
    }
  };

  const handleMerge = async (prNumber: number) => {
    const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
    if (!res.ok) {
      console.error(`Failed to merge PR #${prNumber}:`, await res.text());
    }
  };

  const handleRestore = async (sessionId: string) => {
    if (!confirm(`Restore session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to restore ${sessionId}:`, await res.text());
    }
  };

  const hasKanbanSessions = KANBAN_LEVELS.some((l) => grouped[l].length > 0);

  const anyRateLimited = useMemo(
    () => sessions.some((s) => s.pr && isPRRateLimited(s.pr)),
    [sessions],
  );
  const liveStats = useMemo<DashboardStats>(
    () => ({
      totalSessions: sessions.length,
      workingSessions: sessions.filter((s) => s.activity !== null && s.activity !== "exited")
        .length,
      openPRs: sessions.filter(hasActiveOpenPR).length,
      needsReview: sessions.filter(sessionNeedsReview).length,
    }),
    [sessions],
  );
  const resumeAtLabel = useMemo(() => {
    if (!globalPause) return null;
    return new Date(globalPause.pausedUntil).toLocaleString();
  }, [globalPause]);

  useEffect(() => {
    setGlobalPauseDismissed(false);
  }, [globalPause?.pausedUntil, globalPause?.reason, globalPause?.sourceSessionId]);

  return (
    <div className="flex h-screen">
      {showSidebar && <ProjectSidebar projects={projects} activeProjectId={projectId} />}
      <div className="flex-1 overflow-y-auto px-8 py-7">
        <DynamicFavicon sessions={sessions} projectName={projectName} />
        <div className="mb-6 flex items-center justify-between gap-6">
          <StatusLine stats={liveStats} />
          {orchestratorId && (
            <a
              href={`/sessions/${encodeURIComponent(orchestratorId)}`}
              className="orchestrator-btn flex items-center gap-2 rounded-[7px] px-4 py-2 text-[12px] font-semibold hover:no-underline"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
              orchestrator
              <svg
                className="h-3 w-3 opacity-70"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
              </svg>
            </a>
          )}
        </div>

        <DashboardOverview
          sessions={sessions}
          issues={initialIssues}
          projectName={projectName}
          orchestratorId={orchestratorId}
          onMerge={handleMerge}
          onRestore={handleRestore}
        />

        {/* Global pause banner */}
        {globalPause && !globalPauseDismissed && (
          <div className="mb-6 flex items-center gap-2.5 rounded border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.05)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-error)]">
            <svg
              className="h-3.5 w-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            <span className="flex-1">
              <strong>Orchestrator paused:</strong> {globalPause.reason}
              {resumeAtLabel && (
                <span className="ml-2 opacity-75">Resume after {resumeAtLabel}</span>
              )}
              {globalPause.sourceSessionId && (
                <span className="ml-2 opacity-75">(Source: {globalPause.sourceSessionId})</span>
              )}
            </span>
            <button
              onClick={() => setGlobalPauseDismissed(true)}
              className="ml-1 shrink-0 opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* Rate limit notice */}
        {anyRateLimited && !rateLimitDismissed && (
          <div className="mb-6 flex items-center gap-2.5 rounded border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.05)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-attention)]">
            <svg
              className="h-3.5 w-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            <span className="flex-1">
              GitHub API rate limited — PR data (CI status, review state, sizes) may be stale. Will
              retry automatically on next refresh.
            </span>
            <button
              onClick={() => setRateLimitDismissed(true)}
              className="ml-1 shrink-0 opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* Kanban columns for active zones */}
        {hasKanbanSessions && (
          <section id="board" className="mb-8">
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                  Active board
                </h2>
                <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
                  Attention-ordered view of live agent work.
                </p>
              </div>
            </div>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {KANBAN_LEVELS.map((level) =>
                grouped[level].length > 0 ? (
                  <div key={level} className="min-w-[200px] flex-1">
                    <AttentionZone
                      level={level}
                      sessions={grouped[level]}
                      variant="column"
                      onSend={handleSend}
                      onKill={handleKill}
                      onMerge={handleMerge}
                      onRestore={handleRestore}
                    />
                  </div>
                ) : null,
              )}
            </div>
          </section>
        )}

        {/* Done — full-width grid below Kanban */}
        {grouped.done.length > 0 && (
          <div className="mb-8">
            <AttentionZone
              level="done"
              sessions={grouped.done}
              variant="grid"
              onSend={handleSend}
              onKill={handleKill}
              onMerge={handleMerge}
              onRestore={handleRestore}
            />
          </div>
        )}

        {/* PR Table */}
        {openPRs.length > 0 && (
          <section id="prs" className="mx-auto mb-8 max-w-[980px]">
            <h2 className="mb-3 px-1 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
              Pull Requests
            </h2>
            <div className="overflow-hidden rounded-[6px] border border-[var(--color-border-default)]">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border-muted)]">
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      PR
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Title
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Size
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      CI
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Review
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Unresolved
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {openPRs.map((pr) => (
                    <PRTableRow key={pr.number} pr={pr} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {completedPRs.length > 0 && (
          <section id="completed-prs" className="mx-auto mb-8 max-w-[980px]">
            <div className="mb-3 px-1">
              <h2 className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
                Completed PRs
              </h2>
              <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
                Recently merged or closed work linked to agent sessions.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {completedPRs.slice(0, 8).map((session) => (
                <article
                  key={session.id}
                  className="rounded-[12px] border border-[var(--color-border-default)] bg-[rgba(255,255,255,0.03)] px-4 py-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-[var(--font-mono)] text-[11px] text-[var(--color-text-muted)]">
                        {session.id}
                      </p>
                      <a
                        href={session.pr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 block truncate text-[14px] font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-accent)] hover:no-underline"
                      >
                        {session.pr.title}
                      </a>
                    </div>
                    <span className="rounded-full border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
                      {session.pr.state}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
                    <span>PR #{session.pr.number}</span>
                    <span className="text-[var(--color-border-strong)]">·</span>
                    <span className="text-[var(--color-status-ready)]">+{session.pr.additions}</span>
                    <span className="text-[var(--color-status-error)]">-{session.pr.deletions}</span>
                    {session.issueLabel && (
                      <>
                        <span className="text-[var(--color-border-strong)]">·</span>
                        <span>{session.issueLabel}</span>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        <section id="issues" className="mx-auto max-w-[980px]">
          <div className="mb-3 px-1">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
              Created Issues
            </h2>
            <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
              Open tracker items visible from the current project scope.
            </p>
          </div>

          {initialIssues.length === 0 ? (
            <div className="rounded-[12px] border border-dashed border-[var(--color-border-subtle)] px-4 py-8 text-center text-[13px] text-[var(--color-text-secondary)]">
              No open issues returned by the tracker.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {initialIssues.map((issue) => (
                <article
                  key={`${issue.projectId}-${issue.id}`}
                  className="rounded-[12px] border border-[var(--color-border-default)] bg-[rgba(255,255,255,0.03)] px-4 py-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-[var(--font-mono)] text-[11px] text-[var(--color-text-muted)]">
                        {issue.id}
                      </p>
                      <a
                        href={issue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 block text-[14px] font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-accent)] hover:no-underline"
                      >
                        {issue.title}
                      </a>
                    </div>
                    <span className="rounded-full border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">
                      {issue.projectId}
                    </span>
                  </div>
                  {issue.labels.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {issue.labels.slice(0, 4).map((label) => (
                        <span
                          key={`${issue.projectId}-${issue.id}-${label}`}
                          className="rounded-[6px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatusLine({ stats }: { stats: DashboardStats }) {
  if (stats.totalSessions === 0) {
    return <span className="text-[13px] text-[var(--color-text-muted)]">no sessions</span>;
  }

  const parts: Array<{ value: number; label: string; color?: string }> = [
    { value: stats.totalSessions, label: "sessions" },
    ...(stats.workingSessions > 0
      ? [{ value: stats.workingSessions, label: "working", color: "var(--color-status-working)" }]
      : []),
    ...(stats.openPRs > 0 ? [{ value: stats.openPRs, label: "PRs" }] : []),
    ...(stats.needsReview > 0
      ? [{ value: stats.needsReview, label: "need review", color: "var(--color-status-attention)" }]
      : []),
  ];

  return (
    <div className="flex items-baseline gap-0.5">
      {parts.map((p, i) => (
        <span key={p.label} className="flex items-baseline">
          {i > 0 && <span className="mx-3 text-[11px] text-[var(--color-border-strong)]">·</span>}
          <span
            className="text-[20px] font-bold tabular-nums tracking-tight"
            style={{ color: p.color ?? "var(--color-text-primary)" }}
          >
            {p.value}
          </span>
          <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">{p.label}</span>
        </span>
      ))}
    </div>
  );
}

function mergeScore(
  pr: Pick<DashboardPR, "ciStatus" | "reviewDecision" | "mergeability" | "unresolvedThreads">,
): number {
  let score = 0;
  if (!pr.mergeability.noConflicts) score += 40;
  if (pr.ciStatus === CI_STATUS.FAILING) score += 30;
  else if (pr.ciStatus === CI_STATUS.PENDING) score += 5;
  if (pr.reviewDecision === "changes_requested") score += 20;
  else if (pr.reviewDecision !== "approved") score += 10;
  score += pr.unresolvedThreads * 5;
  return score;
}
