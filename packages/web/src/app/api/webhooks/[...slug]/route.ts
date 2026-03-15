import { NextResponse } from "next/server";
import type { Tracker } from "@composio/ao-core";
import { getServices } from "@/lib/services";
import {
  buildWebhookRequest,
  eventMatchesProject,
  findAffectedSessions,
  findWebhookProjects,
} from "@/lib/scm-webhooks";
import { maybeAutoSpawnWorkflowReviewer } from "@/lib/workflow-review-handoff";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const services = await getServices();
    const path = new URL(request.url).pathname;
    const candidates = findWebhookProjects(services.config, services.registry, path);

    if (candidates.length === 0) {
      return NextResponse.json(
        { error: "No SCM webhook configured for this path" },
        { status: 404 },
      );
    }

    const rawContentLength = request.headers.get("content-length");
    const contentLength = rawContentLength ? Number(rawContentLength) : NaN;
    const candidateMaxBodyBytes = candidates.map(
      (candidate) => candidate.project.scm?.webhook?.maxBodyBytes,
    );
    const allCandidatesBounded = candidateMaxBodyBytes.every((value) => typeof value === "number");
    const maxBodyBytes = allCandidatesBounded
      ? Math.max(...(candidateMaxBodyBytes as number[]))
      : undefined;
    if (
      maxBodyBytes !== undefined &&
      Number.isFinite(contentLength) &&
      contentLength > maxBodyBytes
    ) {
      return NextResponse.json(
        { error: "Webhook payload exceeds configured maxBodyBytes" },
        { status: 413 },
      );
    }

    const rawBody = new Uint8Array(await request.arrayBuffer());
    const body = new TextDecoder().decode(rawBody);
    const webhookRequest = buildWebhookRequest(request, body, rawBody);

    const sessions = await services.sessionManager.list();
    const sessionIds = new Set<string>();
    const projectIds = new Set<string>();
    let verified = false;
    const errors: string[] = [];
    const parseErrors: string[] = [];
    const lifecycleErrors: string[] = [];
    const reviewSessionIds = new Set<string>();
    const reviewSkips: string[] = [];

    for (const candidate of candidates) {
      const verification = await candidate.scm.verifyWebhook?.(webhookRequest, candidate.project);
      if (!verification?.ok) {
        if (verification?.reason) errors.push(verification.reason);
        continue;
      }
      verified = true;

      let event;
      try {
        event = await candidate.scm.parseWebhook?.(webhookRequest, candidate.project);
      } catch (err) {
        parseErrors.push(err instanceof Error ? err.message : "Invalid webhook payload");
        continue;
      }

      if (!event || !eventMatchesProject(event, candidate.project)) {
        continue;
      }

      projectIds.add(candidate.projectId);
      const affectedSessions = findAffectedSessions(sessions, candidate.projectId, event);
      const tracker = candidate.project.tracker
        ? services.registry.get<Tracker>("tracker", candidate.project.tracker.plugin)
        : null;
      if (tracker) {
        try {
          const reviewHandoff = await maybeAutoSpawnWorkflowReviewer({
            config: services.config,
            projectId: candidate.projectId,
            project: candidate.project,
            tracker,
            sessionManager: services.sessionManager,
            sessions,
            event,
          });
          if (reviewHandoff?.spawnedSessionId) {
            reviewSessionIds.add(reviewHandoff.spawnedSessionId);
          } else if (reviewHandoff?.skippedReason) {
            reviewSkips.push(
              [
                candidate.projectId,
                reviewHandoff.parentIssue ?? "-",
                reviewHandoff.childIssueId ?? "-",
                reviewHandoff.skippedReason,
              ].join(":"),
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Workflow review handoff failed";
          lifecycleErrors.push(`workflow review handoff: ${message}`);
        }
      }

      if (affectedSessions.length === 0) {
        continue;
      }

      const lifecycle = services.lifecycleManager;
      for (const session of affectedSessions) {
        sessionIds.add(session.id);
        try {
          await lifecycle.check(session.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Lifecycle check failed";
          lifecycleErrors.push(`session ${session.id}: ${message}`);
        }
      }
    }

    if (!verified) {
      return NextResponse.json(
        { error: errors[0] ?? "Webhook verification failed", ok: false },
        { status: 401 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        projectIds: [...projectIds],
        sessionIds: [...sessionIds],
        matchedSessions: sessionIds.size,
        reviewSessionIds: [...reviewSessionIds],
        reviewSkips,
        parseErrors,
        lifecycleErrors,
      },
      { status: 202 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to process SCM webhook" },
      { status: 500 },
    );
  }
}
