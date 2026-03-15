"use client";

import { cn } from "@/lib/cn";
import { getSessionTitle } from "@/lib/format";
import {
  type DashboardIssue,
  type DashboardSession,
  getAttentionLevel,
  isPRRateLimited,
  TERMINAL_ACTIVITIES,
  TERMINAL_STATUSES,
} from "@/lib/types";

interface DashboardOverviewProps {
  sessions: DashboardSession[];
  issues: DashboardIssue[];
  projectName?: string;
  orchestratorId?: string | null;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

const attentionLabel: Record<ReturnType<typeof getAttentionLevel>, string> = {
  merge: "merge",
  respond: "needs input",
  review: "review",
  pending: "pending",
  working: "working",
  done: "done",
};

const attentionClassName: Record<ReturnType<typeof getAttentionLevel>, string> = {
  merge: "border-[rgba(63,185,80,0.3)] bg-[rgba(63,185,80,0.12)] text-[var(--color-status-ready)]",
  respond:
    "border-[rgba(248,81,73,0.3)] bg-[rgba(248,81,73,0.12)] text-[var(--color-status-error)]",
  review:
    "border-[rgba(209,134,22,0.3)] bg-[rgba(209,134,22,0.12)] text-[var(--color-accent-orange)]",
  pending:
    "border-[rgba(210,153,34,0.3)] bg-[rgba(210,153,34,0.12)] text-[var(--color-status-attention)]",
  working:
    "border-[rgba(88,166,255,0.3)] bg-[rgba(88,166,255,0.12)] text-[var(--color-accent)]",
  done: "border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] text-[var(--color-text-secondary)]",
};

export function DashboardOverview({
  sessions,
  issues,
  projectName,
  orchestratorId,
  onMerge,
  onRestore,
}: DashboardOverviewProps) {
  const readyToMerge = sessions.filter(isSessionMergeReady).slice(0, 3);
  const activeSessions = sessions.filter((session) => !isSessionTerminal(session));
  const completedPRs = sessions.filter(
    (session) => session.pr?.state === "merged" || session.pr?.state === "closed",
  );

  return (
    <div className="mb-8 space-y-5">
      <section className="ops-panel relative overflow-hidden rounded-[20px] border border-[var(--color-border-default)] px-6 py-6">
        <div className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(88,166,255,0.5),transparent)]" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)]">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(88,166,255,0.22)] bg-[rgba(88,166,255,0.08)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-accent)]">
              Home
            </div>
            <div className="space-y-3">
              <h1 className="max-w-2xl text-[30px] font-semibold tracking-[-0.035em] text-[var(--color-text-primary)]">
                {projectName ?? "Orchestrator"} command deck
              </h1>
              <p className="max-w-2xl text-[14px] leading-7 text-[var(--color-text-secondary)]">
                Start from one place: review the merge queue, jump into tmux-backed agent sessions,
                scan completed PRs, and keep issue work visible without drilling into each view.
              </p>
            </div>
            <div className="flex flex-wrap gap-2.5">
              {orchestratorId && (
                <QuickLink
                  href={`/sessions/${encodeURIComponent(orchestratorId)}`}
                  label="Open orchestrator"
                  detail="session terminal"
                />
              )}
              <QuickLink href="#agents" label="All sessions" detail={`${sessions.length} listed`} />
              <QuickLink
                href="#merge-queue"
                label="Merge queue"
                detail={`${readyToMerge.length} ready`}
              />
              <QuickLink href="#prs" label="Pull requests" detail={`${completedPRs.length} closed`} />
              <QuickLink href="#issues" label="Created issues" detail={`${issues.length} open`} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <MetricCard
              label="Active agents"
              value={activeSessions.length}
              detail={`${sessions.length} total sessions`}
            />
            <MetricCard
              label="Ready to merge"
              value={readyToMerge.length}
              detail={readyToMerge.length > 0 ? "human action available" : "queue is clear"}
              tone="success"
            />
            <MetricCard
              label="Completed PRs"
              value={completedPRs.length}
              detail="merged or closed"
            />
            <MetricCard label="Created issues" value={issues.length} detail="open tracker items" />
          </div>
        </div>
      </section>

      {readyToMerge.length > 0 && (
        <section
          id="merge-queue"
          className="ops-panel rounded-[18px] border border-[rgba(63,185,80,0.24)] px-5 py-4"
        >
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">
                Merge queue
              </h2>
              <p className="text-[12px] text-[var(--color-text-secondary)]">
                These pull requests are green and ready for a human merge.
              </p>
            </div>
            <span className="rounded-full border border-[rgba(63,185,80,0.24)] bg-[rgba(63,185,80,0.1)] px-3 py-1 text-[11px] font-medium text-[var(--color-status-ready)]">
              {readyToMerge.length} ready
            </span>
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            {readyToMerge.map((session) => {
              const pr = session.pr;

              return (
                <article
                  key={session.id}
                  className="rounded-[14px] border border-[rgba(63,185,80,0.2)] bg-[rgba(7,20,12,0.72)] px-4 py-4"
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <p className="font-[var(--font-mono)] text-[11px] text-[var(--color-text-muted)]">
                        {session.id}
                      </p>
                      <h3 className="mt-1 text-[14px] font-semibold text-[var(--color-text-primary)]">
                        {getSessionTitle(session)}
                      </h3>
                    </div>
                    <span className="rounded-full border border-[rgba(63,185,80,0.24)] bg-[rgba(63,185,80,0.12)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-status-ready)]">
                      ready
                    </span>
                  </div>
                  <p className="mb-3 text-[12px] text-[var(--color-text-secondary)]">
                    {pr?.title ?? session.issueTitle ?? "Pull request ready for merge"}
                  </p>
                  <div className="flex items-center justify-between gap-3">
                    {pr ? (
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[12px] text-[var(--color-accent)] hover:underline"
                      >
                        PR #{pr.number}
                      </a>
                    ) : (
                      <span className="text-[12px] text-[var(--color-text-secondary)]">
                        No PR link
                      </span>
                    )}
                    {pr && (
                      <button
                        onClick={() => onMerge?.(pr.number)}
                        className="rounded-[8px] bg-[var(--color-status-ready)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-text-inverse)] transition hover:brightness-110"
                      >
                        Merge
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section id="agents" className="ops-panel rounded-[18px] border border-[var(--color-border-default)] px-5 py-5">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">
              All tmux sessions
            </h2>
            <p className="text-[12px] text-[var(--color-text-secondary)]">
              Session roster with terminal shortcuts, merge controls, and agent details.
            </p>
          </div>
          <span className="rounded-full border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)]">
            {sessions.length} sessions
          </span>
        </div>

        {sessions.length === 0 ? (
          <div className="rounded-[14px] border border-dashed border-[var(--color-border-subtle)] px-4 py-8 text-center text-[13px] text-[var(--color-text-secondary)]">
            No sessions yet.
          </div>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {sessions.map((session) => {
              const level = getAttentionLevel(session);
              const isTerminal = isSessionTerminal(session);
              const pr = session.pr;
              const canMerge = pr ? isSessionMergeReady(session) : false;
              const canRestore = isTerminal && session.status !== "merged";
              const issueHref = session.issueUrl;

              return (
                <article
                  key={session.id}
                  className="rounded-[14px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.03)] px-4 py-4"
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className="font-[var(--font-mono)] text-[11px] tracking-wide text-[var(--color-text-muted)]">
                          {session.id}
                        </span>
                        <span
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                            attentionClassName[level],
                          )}
                        >
                          {attentionLabel[level]}
                        </span>
                      </div>
                      <h3 className="truncate text-[14px] font-semibold text-[var(--color-text-primary)]">
                        {getSessionTitle(session)}
                      </h3>
                      <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
                        Last activity {formatRelativeTime(session.lastActivityAt)}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {canMerge && pr && (
                        <button
                          onClick={() => onMerge?.(pr.number)}
                          className="rounded-[8px] bg-[var(--color-status-ready)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-text-inverse)] transition hover:brightness-110"
                        >
                          Merge
                        </button>
                      )}
                      {canRestore ? (
                        <button
                          onClick={() => onRestore?.(session.id)}
                          className="rounded-[8px] border border-[rgba(88,166,255,0.28)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-accent)] transition hover:bg-[rgba(88,166,255,0.08)]"
                        >
                          Restore
                        </button>
                      ) : (
                        <a
                          href={`/sessions/${encodeURIComponent(session.id)}`}
                          className="rounded-[8px] border border-[var(--color-border-default)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-text-primary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] hover:no-underline"
                        >
                          {isTerminal ? "Details" : "Terminal"}
                        </a>
                      )}
                    </div>
                  </div>

                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {getRuntimeBadges(session).map((badge) => (
                      <span
                        key={`${session.id}-${badge}`}
                        className="rounded-[6px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]"
                      >
                        {badge}
                      </span>
                    ))}
                  </div>

                  <div className="space-y-2 text-[12px] text-[var(--color-text-secondary)]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-text-muted)]">
                        {session.branch ?? "no branch"}
                      </span>
                      {pr && (
                        <a
                          href={pr.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--color-accent)] hover:underline"
                        >
                          PR #{pr.number}
                        </a>
                      )}
                    </div>
                    <div className="min-h-[18px]">
                      {issueHref ? (
                        <a
                          href={issueHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--color-accent)] hover:underline"
                        >
                          {session.issueLabel ?? session.issueId ?? "Issue"}
                        </a>
                      ) : (
                        <span>No linked issue</span>
                      )}
                      {session.issueTitle && (
                        <span className="ml-2 text-[var(--color-text-secondary)]">
                          {session.issueTitle}
                        </span>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: number;
  detail: string;
  tone?: "default" | "success";
}) {
  return (
    <div
      className={cn(
        "rounded-[16px] border px-4 py-4",
        tone === "success"
          ? "border-[rgba(63,185,80,0.2)] bg-[rgba(7,20,12,0.72)]"
          : "border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.03)]",
      )}
    >
      <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
        {label}
      </p>
      <p className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-[var(--color-text-primary)]">
        {value}
      </p>
      <p className="mt-2 text-[12px] text-[var(--color-text-secondary)]">{detail}</p>
    </div>
  );
}

function QuickLink({
  href,
  label,
  detail,
}: {
  href: string;
  label: string;
  detail: string;
}) {
  return (
    <a
      href={href}
      className="rounded-full border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-3.5 py-2 text-[12px] text-[var(--color-text-primary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] hover:no-underline"
    >
      <span className="font-medium">{label}</span>
      <span className="ml-2 text-[var(--color-text-secondary)]">{detail}</span>
    </a>
  );
}

function getRuntimeBadges(session: DashboardSession): string[] {
  const values = [
    session.runtime?.role ? `role:${session.runtime.role}` : null,
    session.runtime?.agent ? `agent:${session.runtime.agent}` : null,
    session.runtime?.model ? `model:${session.runtime.model}` : null,
    session.runtime?.provider ? `provider:${session.runtime.provider}` : null,
  ];
  return values.filter((value): value is string => Boolean(value));
}

function isSessionMergeReady(session: DashboardSession): boolean {
  return Boolean(
    session.pr &&
      session.pr.state === "open" &&
      session.pr.mergeability.mergeable &&
      !isPRRateLimited(session.pr),
  );
}

function isSessionTerminal(session: DashboardSession): boolean {
  return (
    TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity))
  );
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "recently";

  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60_000));

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
