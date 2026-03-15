import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import type { OrchestratorConfig, ProjectConfig } from "./types.js";
import { listMetadata, normalizeMetadataRecord } from "./metadata.js";
import { parseKeyValueContent } from "./key-value.js";
import { getSessionsDir } from "./paths.js";

export interface ConfigMigrationResult {
  migratedConfig: Record<string, unknown>;
  migratedYaml: string;
  warnings: string[];
  manualActions: string[];
}

export interface SessionMetadataRelocationProjectResult {
  projectId: string;
  canonicalSessionsDir: string;
  movedActiveSessions: string[];
  movedArchiveEntries: string[];
  dedupedActiveSessions: string[];
  dedupedArchiveEntries: string[];
}

export interface SessionMetadataRelocationSkippedEntry {
  sourcePath: string;
  reason: string;
  /** Project IDs that were candidates when ownership could not be resolved. Present for ambiguous shared-path skips. */
  candidateProjectIds?: string[];
}

export interface SessionMetadataRelocationResult {
  projects: SessionMetadataRelocationProjectResult[];
  skipped: SessionMetadataRelocationSkippedEntry[];
  scannedLegacyDirs: string[];
}

function inferProviderKindFromAgent(agent: unknown): string {
  if (agent === "claude-code") return "anthropic";
  if (agent === "codex") return "openai";
  if (agent === "opencode") return "openai";
  if (agent === "aider") return "custom";
  return "custom";
}

function toObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function deriveDefaultOutputPath(sourcePath: string): string {
  const dir = dirname(sourcePath);
  const file = basename(sourcePath);
  if (file.endsWith(".yaml")) {
    return join(dir, `${file.slice(0, -5)}.migrated.yaml`);
  }
  if (file.endsWith(".yml")) {
    return join(dir, `${file.slice(0, -4)}.migrated.yml`);
  }
  return join(dir, `${file}.migrated.yaml`);
}

function hasNonEmptyProjectPath(project: ProjectConfig): project is ProjectConfig & { path: string } {
  return typeof project.path === "string" && project.path.length > 0;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function removeDirectoryIfEmpty(path: string): void {
  try {
    if (readdirSync(path).length === 0) {
      rmSync(path, { recursive: false, force: true });
    }
  } catch {
    void 0;
  }
}

function maybeRemoveEmptyLegacySessionsDir(legacySessionsDir: string): void {
  removeDirectoryIfEmpty(join(legacySessionsDir, "archive"));
  const remaining = existsSync(legacySessionsDir)
    ? readdirSync(legacySessionsDir).filter((name) => !name.startsWith("."))
    : [];
  if (remaining.length === 0) {
    rmSync(legacySessionsDir, { recursive: false, force: true });
  }
}

function ensureProjectResult(
  resultMap: Map<string, SessionMetadataRelocationProjectResult>,
  projectId: string,
  canonicalSessionsDir: string,
): SessionMetadataRelocationProjectResult {
  const existing = resultMap.get(projectId);
  if (existing) return existing;

  const created: SessionMetadataRelocationProjectResult = {
    projectId,
    canonicalSessionsDir,
    movedActiveSessions: [],
    movedArchiveEntries: [],
    dedupedActiveSessions: [],
    dedupedArchiveEntries: [],
  };
  resultMap.set(projectId, created);
  return created;
}

function resolveTargetProjectId(
  rawContent: string,
  candidateProjectIds: string[],
  allProjectIds: Set<string>,
): string | null {
  const normalized = normalizeMetadataRecord(parseKeyValueContent(rawContent));
  const explicitProjectId = normalized["projectId"] ?? normalized["project"];
  if (explicitProjectId && allProjectIds.has(explicitProjectId)) {
    return explicitProjectId;
  }
  if (candidateProjectIds.length === 1) {
    return candidateProjectIds[0];
  }
  return null;
}

function relocateMetadataFile(
  sourcePath: string,
  targetPath: string,
): "moved" | "deduped" | "conflict" | "noop" {
  if (sourcePath === targetPath) return "noop";

  if (existsSync(targetPath)) {
    try {
      if (readFileSync(targetPath, "utf-8") === readFileSync(sourcePath, "utf-8")) {
        unlinkSync(sourcePath);
        return "deduped";
      }
    } catch {
      return "conflict";
    }
    return "conflict";
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  renameSync(sourcePath, targetPath);
  return "moved";
}

export function getDefaultMigratedConfigPath(sourcePath: string): string {
  return deriveDefaultOutputPath(sourcePath);
}

export function migrateLegacyConfig(
  rawConfig: unknown,
  sourcePath = "<inline config>",
): ConfigMigrationResult {
  const source = toObject(rawConfig);
  const migrated: Record<string, unknown> = { ...source };

  const warnings: string[] = [];
  const manualActions: string[] = [];

  const projects = toObject(migrated["projects"]);
  const defaults = toObject(migrated["defaults"]);

  // Ensure new top-level schema keys exist (backward-compatible additive migration)
  if (!migrated["providers"]) migrated["providers"] = {};
  if (!migrated["authProfiles"]) migrated["authProfiles"] = {};
  if (!migrated["modelProfiles"]) migrated["modelProfiles"] = {};
  if (!migrated["roles"]) migrated["roles"] = {};
  if (!migrated["workflow"]) migrated["workflow"] = {};

  const providers = toObject(migrated["providers"]);

  // Add a minimal inferred provider only when none exist and defaults.agent is present.
  if (Object.keys(providers).length === 0 && typeof defaults["agent"] === "string") {
    providers["legacy-default"] = {
      kind: inferProviderKindFromAgent(defaults["agent"]),
      defaultAgentPlugin: defaults["agent"],
      displayName: "Legacy default provider (inferred)",
    };
    migrated["providers"] = providers;
    manualActions.push(
      "Review providers. Added providers.legacy-default by inference from defaults.agent.",
    );
  }

  const basenameToProjects = new Map<string, string[]>();

  for (const [projectKey, projectValue] of Object.entries(projects)) {
    const project = toObject(projectValue);
    const projectPath = typeof project["path"] === "string" ? project["path"] : "";

    if (!projectPath) {
      warnings.push(
        `projects.${projectKey} has no path; migration could not assess path-derived assumptions.`,
      );
      continue;
    }

    const pathBase = basename(projectPath);
    const list = basenameToProjects.get(pathBase) ?? [];
    list.push(projectKey);
    basenameToProjects.set(pathBase, list);

    if (!project["sessionPrefix"]) {
      warnings.push(
        `projects.${projectKey} has no explicit sessionPrefix (legacy behavior derives it from path basename "${pathBase}").`,
      );
    }

    if (projectKey === pathBase) {
      warnings.push(
        `projects.${projectKey} key matches path basename "${pathBase}"; legacy path-derived identity assumptions may exist in scripts/tooling.`,
      );
    }

    if (!project["workflow"]) {
      manualActions.push(
        `Assign projects.${projectKey}.workflow to a workflow key after defining roles/workflow.`,
      );
    }
  }

  for (const [pathBase, relatedProjects] of basenameToProjects.entries()) {
    if (relatedProjects.length > 1) {
      warnings.push(
        `Multiple projects share path basename "${pathBase}" (${relatedProjects.join(", ")}); verify legacy path-derived scripts and tmux/session naming assumptions.`,
      );
    }
  }

  if (Object.keys(toObject(migrated["authProfiles"])).length === 0) {
    manualActions.push(
      "Define authProfiles (browser-account/api-key/aws-profile/console) for each provider strategy.",
    );
  }
  if (Object.keys(toObject(migrated["modelProfiles"])).length === 0) {
    manualActions.push("Define modelProfiles (agent + authProfile + model + runtime options).");
  }
  if (Object.keys(toObject(migrated["roles"])).length === 0) {
    manualActions.push(
      "Define roles (planner/implementer/reviewer/fixer) mapping to modelProfiles.",
    );
  }
  if (Object.keys(toObject(migrated["workflow"])).length === 0) {
    manualActions.push(
      "Define workflow mappings (parentIssueRole/childIssueRole/reviewRole/ciFixRole).",
    );
  }

  const headerLines = [
    "# Migrated by `ao config migrate`.",
    `# Source: ${sourcePath}`,
    "#",
    "# This file is generated for review. Original config was not modified.",
  ];

  if (warnings.length > 0) {
    headerLines.push("#", "# Warnings:");
    for (const warning of warnings) headerLines.push(`# - ${warning}`);
  }

  if (manualActions.length > 0) {
    headerLines.push("#", "# Manual actions required:");
    for (const action of manualActions) headerLines.push(`# - ${action}`);
  }

  const migratedYaml = `${headerLines.join("\n")}\n\n${yamlStringify(migrated, { indent: 2 })}`;

  return {
    migratedConfig: migrated,
    migratedYaml,
    warnings,
    manualActions,
  };
}

export function migrateLegacyConfigFile(configPath: string): ConfigMigrationResult {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);
  return migrateLegacyConfig(parsed, configPath);
}

export function relocateLegacySessionMetadata(
  config: Pick<OrchestratorConfig, "configPath" | "projects">,
): SessionMetadataRelocationResult {
  const allProjectIds = new Set(Object.keys(config.projects));
  const projectResults = new Map<string, SessionMetadataRelocationProjectResult>();
  const skipped: SessionMetadataRelocationSkippedEntry[] = [];
  const scannedLegacyDirs = new Set<string>();

  const candidatesByLegacyDir = new Map<string, string[]>();
  const canonicalDirByProjectId = new Map<string, string>();

  for (const [projectId, project] of Object.entries(config.projects)) {
    if (!hasNonEmptyProjectPath(project)) continue;

    const canonicalSessionsDir = getSessionsDir(config.configPath, projectId);
    canonicalDirByProjectId.set(projectId, canonicalSessionsDir);

    const legacySessionsDir = getSessionsDir(config.configPath, project.path);
    const candidates = candidatesByLegacyDir.get(legacySessionsDir) ?? [];
    candidates.push(projectId);
    candidatesByLegacyDir.set(legacySessionsDir, candidates);
  }

  for (const [legacySessionsDir, candidateProjectIds] of candidatesByLegacyDir.entries()) {
    if (!existsSync(legacySessionsDir)) continue;
    scannedLegacyDirs.add(legacySessionsDir);

    for (const sessionId of listMetadata(legacySessionsDir)) {
      const sourcePath = join(legacySessionsDir, sessionId);
      const rawContent = readFileSync(sourcePath, "utf-8");
      const targetProjectId = resolveTargetProjectId(rawContent, candidateProjectIds, allProjectIds);
      if (!targetProjectId) {
        const isAmbiguous = candidateProjectIds.length > 1;
        skipped.push({
          sourcePath,
          reason: isAmbiguous
            ? `ambiguous project ownership across ${candidateProjectIds.join(", ")}`
            : "unable to resolve target project",
          ...(isAmbiguous ? { candidateProjectIds } : {}),
        });
        continue;
      }

      const canonicalSessionsDir = canonicalDirByProjectId.get(targetProjectId);
      if (!canonicalSessionsDir) {
        skipped.push({ sourcePath, reason: `unknown canonical sessions dir for ${targetProjectId}` });
        continue;
      }

      const outcome = relocateMetadataFile(sourcePath, join(canonicalSessionsDir, sessionId));
      const projectResult = ensureProjectResult(projectResults, targetProjectId, canonicalSessionsDir);
      if (outcome === "moved") {
        projectResult.movedActiveSessions.push(sessionId);
      } else if (outcome === "deduped") {
        projectResult.dedupedActiveSessions.push(sessionId);
      } else if (outcome === "conflict") {
        skipped.push({
          sourcePath,
          reason: `target metadata already exists with different content for ${targetProjectId}`,
        });
      }
    }

    const legacyArchiveDir = join(legacySessionsDir, "archive");
    if (existsSync(legacyArchiveDir)) {
      for (const fileName of readdirSync(legacyArchiveDir)) {
        const sourcePath = join(legacyArchiveDir, fileName);
        if (fileName.startsWith(".") || !isRegularFile(sourcePath)) continue;

        const rawContent = readFileSync(sourcePath, "utf-8");
        const targetProjectId = resolveTargetProjectId(rawContent, candidateProjectIds, allProjectIds);
        if (!targetProjectId) {
          const isAmbiguous = candidateProjectIds.length > 1;
          skipped.push({
            sourcePath,
            reason: isAmbiguous
              ? `ambiguous archive ownership across ${candidateProjectIds.join(", ")}`
              : "unable to resolve target project for archive",
            ...(isAmbiguous ? { candidateProjectIds } : {}),
          });
          continue;
        }

        const canonicalSessionsDir = canonicalDirByProjectId.get(targetProjectId);
        if (!canonicalSessionsDir) {
          skipped.push({ sourcePath, reason: `unknown canonical sessions dir for ${targetProjectId}` });
          continue;
        }

        const outcome = relocateMetadataFile(
          sourcePath,
          join(canonicalSessionsDir, "archive", fileName),
        );
        const projectResult = ensureProjectResult(projectResults, targetProjectId, canonicalSessionsDir);
        if (outcome === "moved") {
          projectResult.movedArchiveEntries.push(fileName);
        } else if (outcome === "deduped") {
          projectResult.dedupedArchiveEntries.push(fileName);
        } else if (outcome === "conflict") {
          skipped.push({
            sourcePath,
            reason: `target archive already exists with different content for ${targetProjectId}`,
          });
        }
      }
    }

    maybeRemoveEmptyLegacySessionsDir(legacySessionsDir);
  }

  return {
    projects: [...projectResults.values()].sort((a, b) => a.projectId.localeCompare(b.projectId)),
    skipped,
    scannedLegacyDirs: [...scannedLegacyDirs].sort(),
  };
}
