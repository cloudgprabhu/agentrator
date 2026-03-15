import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import {
  findConfigFile,
  getDefaultMigratedConfigPath,
  loadConfigWithPath,
  migrateLegacyConfigFile,
  relocateLegacySessionMetadata,
} from "@composio/ao-core";

interface MigrateOptions {
  output?: string;
  inPlace?: boolean;
  force?: boolean;
}

function resolveSourceConfigPath(configPathArg?: string): string {
  const discovered = configPathArg ? resolve(configPathArg) : findConfigFile();
  if (!discovered) {
    throw new Error("No agent-orchestrator.yaml found. Run `ao init` to create one.");
  }
  return discovered;
}

function resolveOutputPath(sourcePath: string, opts: MigrateOptions): string {
  if (opts.inPlace && opts.output) {
    throw new Error("Cannot use --in-place with --output. Choose one output mode.");
  }

  if (opts.inPlace) return sourcePath;
  if (opts.output) return resolve(opts.output);
  return getDefaultMigratedConfigPath(sourcePath);
}

function ensureWritableTarget(sourcePath: string, targetPath: string, opts: MigrateOptions): void {
  if (targetPath === sourcePath && !opts.inPlace) {
    throw new Error(
      "Refusing to overwrite source config. Use --in-place explicitly, or choose --output.",
    );
  }

  const isExplicitInPlaceOverwrite = opts.inPlace && targetPath === sourcePath;

  if (existsSync(targetPath) && !opts.force && !isExplicitInPlaceOverwrite) {
    throw new Error(
      `Output file already exists: ${targetPath}\n` +
        "Use --force to overwrite, or pass a different --output path.",
    );
  }
}

export function registerConfig(program: Command): void {
  const config = program.command("config").description("Configuration utilities");

  config
    .command("migrate [path]")
    .description("Generate migrated config with notes for manual follow-up")
    .option("-o, --output <path>", "Write migrated config to this file")
    .option("--in-place", "Overwrite source config (explicit only)")
    .option("--force", "Overwrite output file if it exists")
    .action(async (configPathArg: string | undefined, opts: MigrateOptions) => {
      try {
        const sourcePath = resolveSourceConfigPath(configPathArg);
        const outputPath = resolveOutputPath(sourcePath, opts);
        ensureWritableTarget(sourcePath, outputPath, opts);

        const result = migrateLegacyConfigFile(sourcePath);

        writeFileSync(outputPath, result.migratedYaml, "utf-8");

        if (opts.inPlace) {
          console.log(chalk.yellow(`Migrated config written in place: ${outputPath}`));
        } else {
          console.log(chalk.green(`Migrated config written: ${outputPath}`));
          console.log(chalk.dim(`Original preserved: ${sourcePath}`));
        }

        if (result.warnings.length > 0) {
          console.log(chalk.yellow("\nWarnings:"));
          for (const warning of result.warnings) {
            console.log(chalk.yellow(`  - ${warning}`));
          }
        }

        if (result.manualActions.length > 0) {
          console.log(chalk.cyan("\nManual actions:"));
          for (const action of result.manualActions) {
            console.log(chalk.cyan(`  - ${action}`));
          }
        }

        console.log();
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  config
    .command("relocate-session-metadata [path]")
    .description("Move legacy path-derived session metadata into canonical project-key storage")
    .action(async (configPathArg: string | undefined) => {
      try {
        const sourcePath = resolveSourceConfigPath(configPathArg);
        const { config: loadedConfig } = loadConfigWithPath(sourcePath);
        const result = relocateLegacySessionMetadata(loadedConfig);

        if (result.scannedLegacyDirs.length === 0) {
          console.log(chalk.dim("No legacy session metadata directories found."));
          return;
        }

        let movedAnything = false;
        for (const project of result.projects) {
          const movedActiveCount = project.movedActiveSessions.length;
          const movedArchiveCount = project.movedArchiveEntries.length;
          const dedupedCount =
            project.dedupedActiveSessions.length + project.dedupedArchiveEntries.length;
          if (movedActiveCount + movedArchiveCount + dedupedCount === 0) continue;

          movedAnything = movedAnything || movedActiveCount + movedArchiveCount > 0;
          console.log(chalk.green(`Project ${project.projectId}:`));
          console.log(
            chalk.green(
              `  moved ${movedActiveCount} active session(s), ${movedArchiveCount} archive entr${movedArchiveCount === 1 ? "y" : "ies"}`,
            ),
          );
          if (dedupedCount > 0) {
            console.log(chalk.dim(`  deduped ${dedupedCount} already-migrated file(s)`));
          }
        }

        if (!movedAnything && result.projects.length === 0) {
          console.log(chalk.dim("Legacy session metadata already appears to be migrated."));
        }

        if (result.skipped.length > 0) {
          console.log(chalk.yellow("\nSkipped entries (not moved — manual action required):"));
          for (const skipped of result.skipped) {
            console.log(chalk.yellow(`  - ${skipped.sourcePath}`));
            console.log(chalk.yellow(`    Reason: ${skipped.reason}`));
            if (skipped.candidateProjectIds && skipped.candidateProjectIds.length > 0) {
              console.log(
                chalk.yellow(
                  `    Candidates: ${skipped.candidateProjectIds.join(", ")}`,
                ),
              );
              console.log(
                chalk.dim(
                  `    Fix: open the file and add a line like  project: ${skipped.candidateProjectIds[0]}`,
                ),
              );
              console.log(chalk.dim(`    Then re-run: ao config relocate-session-metadata`));
            }
          }
          console.log(
            chalk.dim(
              "\nSee docs/migration-guide.md § Ambiguous shared-path installs for full remediation steps.",
            ),
          );
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
