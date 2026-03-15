import { findTaskLineageByParentIssue, summarizeTaskLineageStates } from "@composio/ao-core";
import { type NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * GET /api/lineage?project=<projectId>&parentIssue=<issueId>
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const projectId = searchParams.get("project");
  const parentIssue = searchParams.get("parentIssue");

  if (!projectId) {
    return NextResponse.json({ error: "project is required" }, { status: 400 });
  }
  if (!parentIssue) {
    return NextResponse.json({ error: "parentIssue is required" }, { status: 400 });
  }

  try {
    const { config } = await getServices();
    const project = config.projects[projectId];
    if (!project) {
      return NextResponse.json({ error: `Unknown project: ${projectId}` }, { status: 404 });
    }

    const lineage = findTaskLineageByParentIssue(project.path, parentIssue);
    if (!lineage) {
      return NextResponse.json({ error: `No lineage found for parent issue ${parentIssue}` }, { status: 404 });
    }

    return NextResponse.json({
      filePath: lineage.filePath,
      lineage: lineage.lineage,
      stateSummary: summarizeTaskLineageStates(lineage.lineage),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch lineage" },
      { status: 500 },
    );
  }
}
