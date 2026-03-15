import chalk from "chalk";
import type { Command } from "commander";
import {
  createAuthManager,
  loadConfig,
  type AuthManager,
  type AuthHealthCheckResult,
  type AuthStatusResult,
} from "@composio/ao-core";

function formatProfileSummary(key: string, profile: Record<string, unknown>): string {
  const type = String(profile["type"] ?? "unknown");
  const provider = String(profile["provider"] ?? "-");
  const accountType = profile["accountType"] ? ` (${String(profile["accountType"])})` : "";

  const hasEnvRef = typeof profile["credentialEnvVar"] === "string";
  const hasCredRef = typeof profile["credentialRef"] === "string";
  const refLabel = hasEnvRef || hasCredRef ? "ref:configured" : "ref:none";

  return `${chalk.cyan(key)}  ${chalk.dim(type + accountType)}  ${chalk.dim(`provider:${provider}`)}  ${chalk.dim(refLabel)}`;
}

function nextStepForStatus(profile: string, status: AuthStatusResult): string | null {
  if (status.status === "not_authenticated") {
    return `Next: ao auth login ${profile}`;
  }
  if (status.status === "unavailable") {
    return "Next: install/provider CLI or configure referenced credentials";
  }
  if (status.status === "unsupported_environment") {
    return "Next: run from a supported local interactive environment";
  }
  return null;
}

function availabilityForStatus(status: AuthStatusResult): boolean {
  return status.status !== "unavailable" && status.status !== "unsupported_environment";
}

function failureReasonForStatus(
  status: AuthStatusResult,
  health: AuthHealthCheckResult,
): string | null {
  if (status.status !== "authenticated") {
    return status.message;
  }
  if (health.state === "invalid") {
    return health.message;
  }
  const failedCheck = health.checks.find((check) => check.status === "fail");
  return failedCheck?.detail ?? null;
}

function buildAuthStatusJsonEntry(
  profileKey: string,
  profile: Record<string, unknown>,
  status: AuthStatusResult,
  health: AuthHealthCheckResult,
) {
  const warnings = health.checks
    .filter((check) => check.status === "warn")
    .map((check) => check.detail);

  return {
    profile: profileKey,
    provider: typeof profile["provider"] === "string" ? profile["provider"] : null,
    mode: typeof profile["type"] === "string" ? profile["type"] : "unknown",
    accountType: typeof profile["accountType"] === "string" ? profile["accountType"] : null,
    status: status.status,
    available: availabilityForStatus(status),
    message: status.message,
    healthState: health.state,
    warnings,
    failureReason: failureReasonForStatus(status, health),
    nextStep: nextStepForStatus(profileKey, status),
    checks: health.checks,
  };
}

function withConfig(): ReturnType<typeof loadConfig> {
  return loadConfig();
}

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Auth profile management");

  auth
    .command("list")
    .description("List configured authProfiles")
    .action(async () => {
      try {
        const config = withConfig();
        const profiles = Object.entries(config.authProfiles ?? {});

        if (profiles.length === 0) {
          console.log(chalk.yellow("No authProfiles configured."));
          console.log(
            chalk.dim("Add authProfiles to agent-orchestrator.yaml to enable auth commands."),
          );
          return;
        }

        console.log(chalk.bold("Configured authProfiles:"));
        for (const [key, profile] of profiles) {
          console.log(`  ${formatProfileSummary(key, profile as Record<string, unknown>)}`);
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  auth
    .command("status")
    .description("Show auth status for configured authProfiles")
    .option("--json", "Emit machine-readable auth status")
    .option("--live", "Run opt-in live validation where supported")
    .action(async (opts: { json?: boolean; live?: boolean }) => {
      try {
        const config = withConfig();
        const profiles = Object.entries(config.authProfiles ?? {});

        if (profiles.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ profiles: [] }, null, 2));
            return;
          }
          console.log(chalk.yellow("No authProfiles configured."));
          console.log(
            chalk.dim("Add authProfiles to agent-orchestrator.yaml to enable auth commands."),
          );
          return;
        }

        const manager: AuthManager = createAuthManager({ config });
        if (opts.json) {
          const entries = await Promise.all(
            profiles.map(async ([key, profile]) => {
              const [status, health] = await Promise.all([
                manager.getProfileStatus(key),
                manager.checkProfileHealth(key, { live: opts.live }),
              ]);
              return buildAuthStatusJsonEntry(
                key,
                profile as Record<string, unknown>,
                status,
                health,
              );
            }),
          );
          console.log(JSON.stringify({ profiles: entries }, null, 2));
          return;
        }

        console.log(
          chalk.bold(opts.live ? "Auth profile status (live validation):" : "Auth profile status:"),
        );

        for (const [key] of profiles) {
          const [status, health] = await Promise.all([
            manager.getProfileStatus(key),
            manager.checkProfileHealth(key, { live: opts.live }),
          ]);
          const statusText = `${status.status}: ${status.message}`;
          const color =
            status.status === "authenticated"
              ? chalk.green
              : status.status === "not_authenticated"
                ? chalk.yellow
                : chalk.red;
          console.log(`  ${chalk.cyan(key)}  ${color(statusText)}`);

          const next = nextStepForStatus(key, status);
          if (next) {
            console.log(chalk.dim(`    ${next}`));
          }

          for (const check of health.checks.filter((entry) => entry.status === "warn")) {
            console.log(chalk.yellow(`    Warning: ${check.detail}`));
          }
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  auth
    .command("login <profile>")
    .description("Run provider-specific login flow for an auth profile")
    .action(async (profile: string) => {
      try {
        const config = withConfig();
        const manager = createAuthManager({ config });
        const result = await manager.loginProfile(profile);

        const color = result.status === "authenticated" ? chalk.green : chalk.yellow;
        console.log(color(`${result.status}: ${result.message}`));

        const next = nextStepForStatus(profile, result);
        if (next) {
          console.log(chalk.dim(next));
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  auth
    .command("logout <profile>")
    .description("Run provider-specific logout flow for an auth profile")
    .action(async (profile: string) => {
      try {
        const config = withConfig();
        const manager = createAuthManager({ config });
        const result = await manager.logoutProfile(profile);

        const color =
          result.status === "not_authenticated" || result.status === "authenticated"
            ? chalk.green
            : chalk.yellow;
        console.log(color(`${result.status}: ${result.message}`));

        const next = nextStepForStatus(profile, result);
        if (next) {
          console.log(chalk.dim(next));
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
