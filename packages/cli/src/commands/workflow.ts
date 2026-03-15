import chalk from "chalk";
import type { Command } from "commander";
import {
  type TaskLineageNode,
  validateLineage,
  repairLineage,
} from "@composio/ao-core";

export function registerWorkflow(program: Command): void {
  const workflow = program
    .command("workflow")
    .description("Task workflow and lineage management (audit-lineage)");

  workflow
    .command("audit-lineage")
    .description("Audit and repair task lineage references")
    .argument("<file>", "Path to task lineage JSON file")
    .option("--fix", "Apply repairs (default: dry run)")
    .option("--strict", "Fail on warnings")
    .action(async (file: string, opts: { fix?: boolean; strict?: boolean }) => {
      console.log(chalk.bold("\nTask Lineage Audit"));
      console.log(chalk.dim(`File: ${file}`));
      console.log(chalk.dim(`Mode: ${opts.fix ? "REPAIR" : "DRY RUN"}\n`));

      // Load task lineage data
      let tasks: TaskLineageNode[];
      try {
        const fs = await import("node:fs/promises");
        const data = await fs.readFile(file, "utf-8");
        tasks = JSON.parse(data) as TaskLineageNode[];
      } catch (err) {
        console.error(chalk.red(`Failed to load lineage file: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      console.log(chalk.blue(`Loaded ${tasks.length} tasks\n`));

      // Validate lineage
      console.log(chalk.bold("Validation:"));
      const validation = validateLineage(tasks);

      if (validation.errors.length === 0) {
        console.log(chalk.green("✓ No structural errors found"));
      } else {
        console.log(chalk.red(`✗ Found ${validation.errors.length} errors:`));
        for (const error of validation.errors) {
          console.log(chalk.red(`  - ${error}`));
        }
      }

      // Attempt repair
      if (opts.fix || !validation.success) {
        console.log(chalk.bold("\nRepair Analysis:"));
        const repair = repairLineage(tasks, { apply: opts.fix });

        if (repair.repairedCount > 0) {
          console.log(chalk.green(`✓ Repaired ${repair.repairedCount} references`));
        }

        if (repair.skippedCount > 0) {
          console.log(
            chalk.yellow(`⚠ Skipped ${repair.skippedCount} ambiguous references`),
          );
        }

        if (repair.warnings.length > 0) {
          console.log(chalk.bold("\nWarnings:"));
          for (const warning of repair.warnings) {
            console.log(chalk.yellow(`  ⚠ ${warning}`));
          }
        }

        if (opts.fix && repair.repairedCount > 0) {
          // Write repaired data back
          const fs = await import("node:fs/promises");
          await fs.writeFile(file, JSON.stringify(tasks, null, 2), "utf-8");
          console.log(chalk.green(`\n✓ Wrote repaired lineage to ${file}`));
        }

        // Exit with error if strict mode and warnings exist
        if (opts.strict && repair.warnings.length > 0) {
          console.error(
            chalk.red(`\n✗ Strict mode: ${repair.warnings.length} warnings found`),
          );
          process.exit(1);
        }

        // Exit with error if errors exist
        if (!validation.success) {
          console.error(
            chalk.red(`\n✗ Lineage validation failed with ${validation.errors.length} errors`),
          );
          process.exit(1);
        }
      }

      console.log(chalk.green("\n✓ Audit complete"));
    });
}
