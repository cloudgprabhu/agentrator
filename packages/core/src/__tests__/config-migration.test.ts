import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  getDefaultMigratedConfigPath,
  migrateLegacyConfig,
  migrateLegacyConfigFile,
  relocateLegacySessionMetadata,
} from "../config-migration.js";
import type { OrchestratorConfig } from "../types.js";
import { getSessionsDir } from "../paths.js";

type RelocationConfig = Pick<OrchestratorConfig, "configPath" | "projects">;

describe("config migration", () => {
  const cleanupDirs: string[] = [];
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves legacy defaults/projects and adds new schema maps", () => {
    const result = migrateLegacyConfig({
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        app: {
          repo: "org/app",
          path: "/repos/app",
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      },
    });

    const migrated = result.migratedConfig;
    expect((migrated["defaults"] as Record<string, unknown>)["agent"]).toBe("claude-code");
    expect((migrated["projects"] as Record<string, unknown>)["app"]).toBeDefined();
    expect((migrated["providers"] as Record<string, unknown>)["legacy-default"]).toBeDefined();
    expect(migrated["authProfiles"]).toEqual({});
    expect(migrated["modelProfiles"]).toEqual({});
    expect(migrated["roles"]).toEqual({});
    expect(migrated["workflow"]).toEqual({});
  });

  it("emits warnings for path-derived assumptions", () => {
    const result = migrateLegacyConfig({
      projects: {
        app: {
          repo: "org/app",
          path: "/repos/app",
          defaultBranch: "main",
        },
      },
    });

    expect(result.warnings.some((w) => w.includes("no explicit sessionPrefix"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("key matches path basename"))).toBe(true);
  });

  it("renders migration yaml with warnings and manual actions comments", () => {
    const result = migrateLegacyConfig(
      {
        projects: {
          app: {
            repo: "org/app",
            path: "/repos/app",
            defaultBranch: "main",
          },
        },
      },
      "/tmp/agent-orchestrator.yaml",
    );

    expect(result.migratedYaml).toContain("# Migrated by `ao config migrate`.");
    expect(result.migratedYaml).toContain("# Source: /tmp/agent-orchestrator.yaml");
    expect(result.migratedYaml).toContain("# Warnings:");
    expect(result.migratedYaml).toContain("# Manual actions required:");
  });

  it("migrates from config file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-config-migrate-"));
    cleanupDirs.push(dir);
    const configPath = join(dir, "agent-orchestrator.yaml");

    writeFileSync(
      configPath,
      [
        "defaults:",
        "  agent: codex",
        "projects:",
        "  backend:",
        "    repo: org/backend",
        "    path: /repos/backend",
      ].join("\n"),
      "utf-8",
    );

    const result = migrateLegacyConfigFile(configPath);
    expect(result.migratedYaml).toContain("providers:");
    expect(result.migratedYaml).toContain("legacy-default:");
  });

  it("derives migrated output path without overwriting source by default", () => {
    expect(getDefaultMigratedConfigPath("/tmp/agent-orchestrator.yaml")).toBe(
      "/tmp/agent-orchestrator.migrated.yaml",
    );
    expect(getDefaultMigratedConfigPath("/tmp/agent-orchestrator.yml")).toBe(
      "/tmp/agent-orchestrator.migrated.yml",
    );
  });

  it("relocates legacy path-derived session metadata into canonical project dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-metadata-relocate-"));
    cleanupDirs.push(dir);
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    const configPath = join(dir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}\n", "utf-8");

    const config: RelocationConfig = {
      configPath,
      projects: {
        planner: {
          name: "Planner",
          repo: "org/shared",
          path: "/repos/shared",
          defaultBranch: "main",
          sessionPrefix: "pla",
          tracker: { plugin: "linear" },
          scm: { plugin: "github" },
        },
        implementer: {
          name: "Implementer",
          repo: "org/shared",
          path: "/repos/shared",
          defaultBranch: "main",
          sessionPrefix: "imp",
          tracker: { plugin: "linear" },
          scm: { plugin: "github" },
        },
      },
    };

    const legacySessionsDir = getSessionsDir(configPath, "/repos/shared");
    mkdirSync(join(legacySessionsDir, "archive"), { recursive: true });

    writeFileSync(
      join(legacySessionsDir, "pla-1"),
      "branch=feat/PLAN-1\nstatus=working\nproject=planner\n",
      "utf-8",
    );
    writeFileSync(
      join(legacySessionsDir, "archive", "imp-1_2026-01-01T00-00-00-000Z"),
      "branch=feat/IMP-1\nstatus=killed\nproject=implementer\n",
      "utf-8",
    );

    const result = relocateLegacySessionMetadata(config);
    const plannerSessionsDir = getSessionsDir(configPath, "planner");
    const implementerSessionsDir = getSessionsDir(configPath, "implementer");

    expect(result.scannedLegacyDirs).toEqual([legacySessionsDir]);
    expect(result.skipped).toEqual([]);
    expect(readFileSync(join(plannerSessionsDir, "pla-1"), "utf-8")).toContain("project=planner");
    expect(
      readFileSync(
        join(implementerSessionsDir, "archive", "imp-1_2026-01-01T00-00-00-000Z"),
        "utf-8",
      ),
    ).toContain("project=implementer");
    expect(existsSync(join(legacySessionsDir, "pla-1"))).toBe(false);
  });

  it("skips ambiguous legacy metadata when shared-path ownership cannot be resolved", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-metadata-ambiguous-"));
    cleanupDirs.push(dir);
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    const configPath = join(dir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}\n", "utf-8");

    const config: RelocationConfig = {
      configPath,
      projects: {
        planner: {
          name: "Planner",
          repo: "org/shared",
          path: "/repos/shared",
          defaultBranch: "main",
          sessionPrefix: "pla",
          tracker: { plugin: "linear" },
          scm: { plugin: "github" },
        },
        implementer: {
          name: "Implementer",
          repo: "org/shared",
          path: "/repos/shared",
          defaultBranch: "main",
          sessionPrefix: "imp",
          tracker: { plugin: "linear" },
          scm: { plugin: "github" },
        },
      },
    };

    const legacySessionsDir = getSessionsDir(configPath, "/repos/shared");
    mkdirSync(legacySessionsDir, { recursive: true });
    writeFileSync(join(legacySessionsDir, "shared-1"), "branch=feat/x\nstatus=working\n", "utf-8");

    const result = relocateLegacySessionMetadata(config);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("ambiguous project ownership");
    expect(result.skipped[0]?.candidateProjectIds).toEqual(
      expect.arrayContaining(["planner", "implementer"]),
    );
    expect(existsSync(join(legacySessionsDir, "shared-1"))).toBe(true);
  });
});
