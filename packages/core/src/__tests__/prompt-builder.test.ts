import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { buildPrompt, BASE_AGENT_PROMPT } from "../prompt-builder.js";
import type { ProjectConfig } from "../types.js";

let tmpDir: string;
let project: ProjectConfig;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-prompt-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  project = {
    name: "Test App",
    repo: "org/test-app",
    path: tmpDir,
    defaultBranch: "main",
    sessionPrefix: "test",
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildPrompt", () => {
  it("includes base prompt on bare spawns", () => {
    const result = buildPrompt({ project, projectId: "test-app" });
    expect(result).toContain(BASE_AGENT_PROMPT);
    expect(result).toContain("## Project Context");
    expect(result).toContain("Project: Test App");
  });

  it("includes base prompt when issue is provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).not.toBeNull();
    expect(result).toContain(BASE_AGENT_PROMPT);
  });

  it("includes project context", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Test App");
    expect(result).toContain("org/test-app");
    expect(result).toContain("main");
  });

  it("includes issue ID in task section", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Work on issue: INT-1343");
    expect(result).toContain("feat/INT-1343");
  });

  it("includes issue context when provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      issueContext: "## Linear Issue INT-1343\nTitle: Layered Prompt System\nPriority: High",
    });
    expect(result).toContain("## Issue Details");
    expect(result).toContain("Layered Prompt System");
    expect(result).toContain("Priority: High");
  });

  it("includes inline agentRules", () => {
    project.agentRules = "Always run pnpm test before pushing.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("## Project Rules");
    expect(result).toContain("Always run pnpm test before pushing.");
  });

  it("reads agentRulesFile content", () => {
    const rulesPath = join(tmpDir, "agent-rules.md");
    writeFileSync(rulesPath, "Use conventional commits.\nNo force pushes.");
    project.agentRulesFile = "agent-rules.md";

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Use conventional commits.");
    expect(result).toContain("No force pushes.");
  });

  it("includes both agentRules and agentRulesFile", () => {
    project.agentRules = "Inline rule.";
    const rulesPath = join(tmpDir, "rules.txt");
    writeFileSync(rulesPath, "File rule.");
    project.agentRulesFile = "rules.txt";

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Inline rule.");
    expect(result).toContain("File rule.");
  });

  it("handles missing agentRulesFile gracefully", () => {
    project.agentRulesFile = "nonexistent-rules.md";

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    // Should not throw, should still build prompt without rules
    expect(result).not.toBeNull();
    expect(result).not.toContain("## Project Rules");
  });

  it("includes role rules from role/model rules files", () => {
    writeFileSync(join(tmpDir, "model-rules.md"), "Model rule: prefer safer migrations.");
    writeFileSync(join(tmpDir, "role-rules.md"), "Role rule: start with a short plan.");

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      roleRulesFiles: ["model-rules.md", "role-rules.md"],
    });

    expect(result).toContain("## Role Rules");
    expect(result).toContain("Model rule: prefer safer migrations.");
    expect(result).toContain("Role rule: start with a short plan.");
  });

  it("includes role promptPrefix and guardrails", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      rolePromptPrefix: "Think through edge cases before coding.",
      roleGuardrails: ["Do not weaken auth checks", "Keep PR scope focused"],
    });

    expect(result).toContain("## Role Prompt Prefix");
    expect(result).toContain("Think through edge cases before coding.");
    expect(result).toContain("## Guardrails");
    expect(result).toContain("- Do not weaken auth checks");
    expect(result).toContain("- Keep PR scope focused");
  });

  it("dedupes repeated role rules files and guardrails", () => {
    writeFileSync(join(tmpDir, "shared-rules.md"), "Shared role rule.");

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      roleRulesFiles: [" shared-rules.md ", "shared-rules.md"],
      rolePromptPrefix: "  Think through edge cases before coding.  ",
      roleGuardrails: [
        " Keep PR scope focused ",
        "Keep PR scope focused",
        "",
        "Do not weaken auth checks",
      ],
    });

    expect(result).toContain("## Role Rules");
    expect(result.match(/Shared role rule\./g)).toHaveLength(1);
    expect(result).toContain("## Role Prompt Prefix");
    expect(result).toContain("Think through edge cases before coding.");
    expect(result.match(/- Keep PR scope focused/g)).toHaveLength(1);
    expect(result.match(/- Do not weaken auth checks/g)).toHaveLength(1);
  });

  it("applies role rules after project rules", () => {
    project.agentRules = "Project baseline rule.";
    writeFileSync(join(tmpDir, "role-rules.md"), "Role-specific rule.");

    const result = buildPrompt({
      project,
      projectId: "test-app",
      roleRulesFiles: ["role-rules.md"],
    });

    const projectRuleIdx = result.indexOf("Project baseline rule.");
    const roleRuleIdx = result.indexOf("Role-specific rule.");
    expect(projectRuleIdx).toBeLessThan(roleRuleIdx);
  });

  it("appends userPrompt last", () => {
    project.agentRules = "Project rule.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      userPrompt: "Focus on the API layer only.",
    });

    expect(result).not.toBeNull();
    const promptStr = result!;

    // User prompt should come after project rules
    const rulesIdx = promptStr.indexOf("Project rule.");
    const userIdx = promptStr.indexOf("Focus on the API layer only.");
    expect(rulesIdx).toBeLessThan(userIdx);
    expect(promptStr).toContain("## Additional Instructions");
  });

  it("builds prompt from rules alone (no issue)", () => {
    project.agentRules = "Always lint before committing.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
    });
    expect(result).not.toBeNull();
    expect(result).toContain(BASE_AGENT_PROMPT);
    expect(result).toContain("Always lint before committing.");
  });

  it("builds prompt from userPrompt alone (no issue, no rules)", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      userPrompt: "Just explore the codebase.",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("Just explore the codebase.");
  });

  it("includes tracker info in context", () => {
    project.tracker = { plugin: "linear" };
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(result).toContain("Tracker: linear");
  });

  it("uses project name in context", () => {
    const result = buildPrompt({
      project,
      projectId: "my-project",
      issueId: "INT-100",
    });
    expect(result).toContain("Project: Test App");
  });

  it("includes reaction hints for auto send-to-agent reactions", () => {
    project.reactions = {
      "ci-failed": { auto: true, action: "send-to-agent" },
      "approved-and-green": { auto: false, action: "notify" },
    };
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(result).toContain("ci-failed");
    expect(result).not.toContain("approved-and-green");
  });
});

describe("BASE_AGENT_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof BASE_AGENT_PROMPT).toBe("string");
    expect(BASE_AGENT_PROMPT.length).toBeGreaterThan(100);
  });

  it("covers key topics", () => {
    expect(BASE_AGENT_PROMPT).toContain("Session Lifecycle");
    expect(BASE_AGENT_PROMPT).toContain("Git Workflow");
    expect(BASE_AGENT_PROMPT).toContain("PR Best Practices");
    expect(BASE_AGENT_PROMPT).toContain("ao session claim-pr");
  });
});
