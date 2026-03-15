import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AuthAdapterContext,
  AuthHealthCheckResult,
  AuthProviderAdapter,
  AuthStatusResult,
} from "../types.js";

const execFileAsync = promisify(execFile);

export interface ClaudeCliCommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  code?: number;
  unavailable?: boolean;
}

export type ClaudeCliRunner = (args: string[]) => Promise<ClaudeCliCommandResult>;

export interface AnthropicClaudeBrowserAdapterOptions {
  runClaudeCli?: ClaudeCliRunner;
  platform?: NodeJS.Platform;
  isCi?: boolean;
}

function normalizeText(value: string): string {
  return value.toLowerCase().trim();
}

function toSafeMessage(reason: "unavailable" | "failed" | "unsupported", action: string): string {
  if (reason === "unavailable") {
    return "Claude CLI is not available on this machine";
  }
  if (reason === "unsupported") {
    return `Claude browser auth ${action} is not supported in this environment`;
  }
  return `Claude browser auth ${action} failed`;
}

function getEnvironmentCheck(
  platform: NodeJS.Platform,
  isCi: boolean,
): AuthHealthCheckResult["checks"][number] {
  if (isCi) {
    return {
      key: "browser-environment",
      status: "warn",
      detail: "Browser auth login requires a supported local interactive environment, but CI was detected",
    };
  }

  if (platform === "linux" && !process.env.DISPLAY) {
    return {
      key: "browser-environment",
      status: "warn",
      detail: "Browser auth login requires a local graphical environment, but DISPLAY is not set",
    };
  }

  return {
    key: "browser-environment",
    status: "pass",
    detail: "Local interactive browser auth environment detected",
  };
}

function parseStatusOutput(stdout: string, stderr: string): AuthStatusResult {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (parsed["authenticated"] === true || parsed["loggedIn"] === true) {
      return { status: "authenticated", message: "Claude CLI is authenticated" };
    }
    if (parsed["authenticated"] === false || parsed["loggedIn"] === false) {
      return { status: "not_authenticated", message: "Claude CLI is not authenticated" };
    }
    if (parsed["status"] === "authenticated") {
      return { status: "authenticated", message: "Claude CLI is authenticated" };
    }
    if (parsed["status"] === "not_authenticated") {
      return { status: "not_authenticated", message: "Claude CLI is not authenticated" };
    }
  } catch {
    // Non-JSON output is expected for many CLI builds.
  }

  const normalized = `${normalizeText(stdout)}\n${normalizeText(stderr)}`;

  if (
    normalized.includes("not authenticated") ||
    normalized.includes("not logged") ||
    normalized.includes("login required") ||
    normalized.includes("no active auth")
  ) {
    return { status: "not_authenticated", message: "Claude CLI is not authenticated" };
  }

  if (
    normalized.includes("authenticated") ||
    normalized.includes("logged in") ||
    normalized.includes("active session")
  ) {
    return { status: "authenticated", message: "Claude CLI is authenticated" };
  }

  return { status: "unavailable", message: "Unable to determine Claude auth status" };
}

async function defaultClaudeRunner(args: string[]): Promise<ClaudeCliCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync("claude", args, { timeout: 15_000 });
    return {
      success: true,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    if (error?.code === "ENOENT") {
      return { success: false, stdout: "", stderr: "", unavailable: true };
    }
    return {
      success: false,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? ""),
      code: typeof error?.code === "number" ? error.code : undefined,
    };
  }
}

function supportsAnthropicBrowser(context: AuthAdapterContext): boolean {
  if (context.profile.type !== "browser-account") return false;

  const providerKind = context.provider?.kind?.toLowerCase();
  const providerKey = context.providerKey?.toLowerCase();
  return (
    providerKind === "anthropic" ||
    providerKey === "anthropic" ||
    context.profile.accountType === "claude-pro" ||
    context.profile.accountType === "claude-max"
  );
}

export function formatAuthStatusForCli(status: AuthStatusResult): string {
  return `${status.status}: ${status.message}`;
}

export function createAnthropicClaudeBrowserAuthAdapter(
  options: AnthropicClaudeBrowserAdapterOptions = {},
): AuthProviderAdapter {
  const runClaudeCli = options.runClaudeCli ?? defaultClaudeRunner;
  const isCi = options.isCi ?? process.env.CI === "true";
  const platform = options.platform ?? process.platform;

  async function getStatus(): Promise<AuthStatusResult> {
    const result = await runClaudeCli(["auth", "status", "--json"]);
    if (result.unavailable) {
      return { status: "unavailable", message: toSafeMessage("unavailable", "status check") };
    }
    if (!result.success) {
      const parsed = parseStatusOutput(result.stdout, result.stderr);
      if (parsed.status === "authenticated" || parsed.status === "not_authenticated") {
        return parsed;
      }
      return { status: "unavailable", message: toSafeMessage("failed", "status check") };
    }
    const parsed = parseStatusOutput(result.stdout, result.stderr);
    return parsed;
  }

  async function login(): Promise<AuthStatusResult> {
    if (isCi) {
      return {
        status: "unsupported_environment",
        message: toSafeMessage("unsupported", "login"),
      };
    }

    if (platform === "linux" && !process.env.DISPLAY) {
      return {
        status: "unsupported_environment",
        message: toSafeMessage("unsupported", "login"),
      };
    }

    const result = await runClaudeCli(["auth", "login"]);
    if (result.unavailable) {
      return { status: "unavailable", message: toSafeMessage("unavailable", "login") };
    }
    if (!result.success) {
      return { status: "not_authenticated", message: toSafeMessage("failed", "login") };
    }
    return getStatus();
  }

  async function logout(): Promise<AuthStatusResult> {
    const result = await runClaudeCli(["auth", "logout"]);
    if (result.unavailable) {
      return { status: "unavailable", message: toSafeMessage("unavailable", "logout") };
    }
    if (!result.success) {
      return { status: "unavailable", message: toSafeMessage("failed", "logout") };
    }
    return { status: "not_authenticated", message: "Claude CLI is logged out" };
  }

  return {
    name: "anthropic-claude-browser",
    supports: supportsAnthropicBrowser,
    async checkHealth(context): Promise<AuthHealthCheckResult> {
      const status = await getStatus();
      const environmentCheck = getEnvironmentCheck(platform, isCi);
      const checks: AuthHealthCheckResult["checks"] = [environmentCheck];
      if (status.status === "authenticated") {
        return {
          state: environmentCheck.status === "warn" ? "degraded" : "healthy",
          authStatus: status.status,
          message: environmentCheck.status === "warn" ? environmentCheck.detail : status.message,
          checks: [...checks, { key: "claude-auth", status: "pass", detail: status.message }],
        };
      }
      if (status.status === "not_authenticated") {
        return {
          state: "degraded",
          authStatus: status.status,
          message: `Auth profile ${context.profileKey} requires Claude login`,
          checks: [...checks, { key: "claude-auth", status: "warn", detail: status.message }],
        };
      }
      return {
        state: "degraded",
        authStatus: status.status,
        message: status.message,
        checks: [...checks, { key: "claude-auth", status: "warn", detail: status.message }],
      };
    },
    getStatus: async () => getStatus(),
    login: async () => login(),
    logout: async () => logout(),
  };
}
