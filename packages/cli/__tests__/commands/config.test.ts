import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";

const {
  mockFindConfigFile,
  mockGetDefaultMigratedConfigPath,
  mockMigrateLegacyConfigFile,
  mockLoadConfigWithPath,
  mockRelocateLegacySessionMetadata,
} = vi.hoisted(() => ({
    mockFindConfigFile: vi.fn(),
    mockGetDefaultMigratedConfigPath: vi.fn(),
    mockMigrateLegacyConfigFile: vi.fn(),
    mockLoadConfigWithPath: vi.fn(),
    mockRelocateLegacySessionMetadata: vi.fn(),
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    findConfigFile: mockFindConfigFile,
    getDefaultMigratedConfigPath: mockGetDefaultMigratedConfigPath,
    migrateLegacyConfigFile: mockMigrateLegacyConfigFile,
    loadConfigWithPath: mockLoadConfigWithPath,
    relocateLegacySessionMetadata: mockRelocateLegacySessionMetadata,
  };
});

import { registerConfig } from "../../src/commands/config.js";

let program: Command;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let tmpDir: string;

beforeEach(() => {
  program = new Command();
  program.exitOverride();
  registerConfig(program);

  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  tmpDir = mkdtempSync(join(tmpdir(), "ao-config-command-"));

  mockFindConfigFile.mockReset();
  mockGetDefaultMigratedConfigPath.mockReset();
  mockMigrateLegacyConfigFile.mockReset();
  mockLoadConfigWithPath.mockReset();
  mockRelocateLegacySessionMetadata.mockReset();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("config migrate command", () => {
  it("writes migrated config next to source by default and preserves original", async () => {
    const sourcePath = join(tmpDir, "agent-orchestrator.yaml");
    const outputPath = join(tmpDir, "agent-orchestrator.migrated.yaml");
    writeFileSync(sourcePath, "projects: {}\n", "utf-8");

    mockFindConfigFile.mockReturnValue(sourcePath);
    mockGetDefaultMigratedConfigPath.mockReturnValue(outputPath);
    mockMigrateLegacyConfigFile.mockReturnValue({
      migratedConfig: {},
      migratedYaml: "# migrated\nprojects: {}\n",
      warnings: ["legacy path assumption"],
      manualActions: ["define roles"],
    });

    await program.parseAsync(["node", "test", "config", "migrate"]);

    expect(readFileSync(outputPath, "utf-8")).toContain("# migrated");
    expect(readFileSync(sourcePath, "utf-8")).toBe("projects: {}\n");

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain(`Migrated config written: ${outputPath}`);
    expect(output).toContain(`Original preserved: ${sourcePath}`);
    expect(output).toContain("Warnings:");
    expect(output).toContain("Manual actions:");
  });

  it("refuses to overwrite an existing output file unless --force is provided", async () => {
    const sourcePath = join(tmpDir, "agent-orchestrator.yaml");
    const outputPath = join(tmpDir, "agent-orchestrator.migrated.yaml");
    writeFileSync(sourcePath, "projects: {}\n", "utf-8");
    writeFileSync(outputPath, "existing output\n", "utf-8");

    mockFindConfigFile.mockReturnValue(sourcePath);
    mockGetDefaultMigratedConfigPath.mockReturnValue(outputPath);

    await expect(program.parseAsync(["node", "test", "config", "migrate"])).rejects.toThrow(
      "process.exit(1)",
    );

    const errorOutput = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errorOutput).toContain(`Output file already exists: ${outputPath}`);
    expect(readFileSync(outputPath, "utf-8")).toBe("existing output\n");
    expect(mockMigrateLegacyConfigFile).not.toHaveBeenCalled();
  });

  it("overwrites the source config only when --in-place is explicitly requested", async () => {
    const sourcePath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(sourcePath, "projects: {}\n", "utf-8");

    mockMigrateLegacyConfigFile.mockReturnValue({
      migratedConfig: {},
      migratedYaml: "# migrated in place\nprojects: {}\n",
      warnings: [],
      manualActions: [],
    });

    await program.parseAsync(["node", "test", "config", "migrate", sourcePath, "--in-place"]);

    expect(readFileSync(sourcePath, "utf-8")).toContain("# migrated in place");
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain(`Migrated config written in place: ${sourcePath}`);
  });
});

describe("config relocate-session-metadata command", () => {
  it("relocates legacy session metadata and prints a summary", async () => {
    const sourcePath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(sourcePath, "projects: {}\n", "utf-8");

    mockFindConfigFile.mockReturnValue(sourcePath);
    mockLoadConfigWithPath.mockReturnValue({
      config: { configPath: sourcePath, projects: {} },
      path: sourcePath,
    });
    mockRelocateLegacySessionMetadata.mockReturnValue({
      scannedLegacyDirs: [join(tmpDir, ".agent-orchestrator", "hash-shared", "sessions")],
      projects: [
        {
          projectId: "planner",
          canonicalSessionsDir: join(tmpDir, ".agent-orchestrator", "hash-planner", "sessions"),
          movedActiveSessions: ["pla-1"],
          movedArchiveEntries: ["pla-1_2026-01-01T00-00-00-000Z"],
          dedupedActiveSessions: [],
          dedupedArchiveEntries: [],
        },
      ],
      skipped: [],
    });

    await program.parseAsync(["node", "test", "config", "relocate-session-metadata"]);

    expect(mockLoadConfigWithPath).toHaveBeenCalledWith(sourcePath);
    expect(mockRelocateLegacySessionMetadata).toHaveBeenCalled();

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Project planner:");
    expect(output).toContain("moved 1 active session(s), 1 archive entry");
  });

  it("reports skipped entries without silently guessing ownership", async () => {
    const sourcePath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(sourcePath, "projects: {}\n", "utf-8");

    mockFindConfigFile.mockReturnValue(sourcePath);
    mockLoadConfigWithPath.mockReturnValue({
      config: { configPath: sourcePath, projects: {} },
      path: sourcePath,
    });
    mockRelocateLegacySessionMetadata.mockReturnValue({
      scannedLegacyDirs: [join(tmpDir, ".agent-orchestrator", "hash-shared", "sessions")],
      projects: [],
      skipped: [
        {
          sourcePath: join(tmpDir, ".agent-orchestrator", "hash-shared", "sessions", "shared-1"),
          reason: "ambiguous project ownership across planner, implementer",
          candidateProjectIds: ["planner", "implementer"],
        },
      ],
    });

    await program.parseAsync(["node", "test", "config", "relocate-session-metadata"]);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Skipped entries (not moved");
    expect(output).toContain("ambiguous project ownership");
    expect(output).toContain("Candidates: planner, implementer");
    expect(output).toContain("project: planner");
    expect(output).toContain("ao config relocate-session-metadata");
  });
});
