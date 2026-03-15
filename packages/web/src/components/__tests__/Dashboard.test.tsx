import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Dashboard } from "@/components/Dashboard";
import { makeIssue, makePR, makeSession } from "@/__tests__/helpers";

vi.mock("@/hooks/useSessionEvents", () => ({
  useSessionEvents: (initialSessions: unknown[], initialGlobalPause: unknown) => ({
    sessions: initialSessions,
    globalPause: initialGlobalPause ?? null,
  }),
}));

vi.mock("@/components/DynamicFavicon", () => ({
  DynamicFavicon: () => null,
}));

vi.mock("@/components/ProjectSidebar", () => ({
  ProjectSidebar: () => <div data-testid="project-sidebar" />,
}));

describe("Dashboard", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the overview, completed PRs, and created issues sections", () => {
    const readyPR = makePR({
      number: 42,
      title: "feat: improve landing page",
    });
    const mergedPR = makePR({
      number: 43,
      title: "feat: ship completed cards",
      state: "merged",
    });

    const sessions = [
      makeSession({
        id: "agent-1",
        summary: "Build landing page",
        issueTitle: "UI improvements",
        runtime: {
          role: "implementer",
          agent: "codex",
          provider: "openai",
          model: "gpt-5-codex",
          authProfile: null,
          authMode: null,
          promptPolicy: null,
        },
        pr: readyPR,
      }),
      makeSession({
        id: "agent-2",
        activity: "exited",
        summary: "Wrap up merged work",
        pr: mergedPR,
      }),
    ];

    render(
      <Dashboard
        initialSessions={sessions}
        initialIssues={[makeIssue()]}
        projectName="My App"
        orchestratorId="orchestrator-1"
      />,
    );

    expect(screen.getByText("My App command deck")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Merge queue" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "All tmux sessions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Completed PRs" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Created Issues" })).toBeInTheDocument();
    expect(screen.getByText("Improve dashboard navigation")).toBeInTheDocument();
    expect(screen.getAllByText("feat: ship completed cards").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Terminal" })).toHaveAttribute(
      "href",
      "/sessions/agent-1",
    );
  });

  it("calls the merge API from the overview merge queue", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "agent-1",
            pr: makePR({ number: 77, title: "feat: merge me" }),
          }),
        ]}
        initialIssues={[]}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Merge" })[0]);

    expect(fetchMock).toHaveBeenCalledWith("/api/prs/77/merge", { method: "POST" });
  });
});
