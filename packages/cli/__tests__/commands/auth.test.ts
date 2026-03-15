import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const { mockConfigRef, mockManager } = vi.hoisted(() => ({
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockManager: {
    getProfileStatus: vi.fn(),
    checkProfileHealth: vi.fn(),
    loginProfile: vi.fn(),
    logoutProfile: vi.fn(),
  },
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
    createAuthManager: () => mockManager,
  };
});

import { registerAuth } from "../../src/commands/auth.js";

let program: Command;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  program = new Command();
  program.exitOverride();
  registerAuth(program);

  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockManager.getProfileStatus.mockReset();
  mockManager.checkProfileHealth.mockReset();
  mockManager.loginProfile.mockReset();
  mockManager.logoutProfile.mockReset();
  mockManager.checkProfileHealth.mockResolvedValue({
    state: "healthy",
    authStatus: "authenticated",
    message: "ok",
    checks: [],
  });

  mockConfigRef.current = {
    authProfiles: {
      openaiApi: {
        type: "api-key",
        provider: "openai",
        credentialEnvVar: "OPENAI_API_KEY",
      },
      codexBrowser: {
        type: "browser-account",
        provider: "openai",
        accountType: "chatgpt-plus",
      },
    },
  } as Record<string, unknown>;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth command", () => {
  it("shows helpful output when no auth profiles are configured", async () => {
    mockConfigRef.current = { authProfiles: {} } as Record<string, unknown>;

    await program.parseAsync(["node", "test", "auth", "list"]);
    await program.parseAsync(["node", "test", "auth", "status"]);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No authProfiles configured.");
    expect(output).toContain("Add authProfiles to agent-orchestrator.yaml to enable auth commands.");
    expect(mockManager.getProfileStatus).not.toHaveBeenCalled();
  });

  it("emits empty machine-readable status when no auth profiles are configured", async () => {
    mockConfigRef.current = { authProfiles: {} } as Record<string, unknown>;

    await program.parseAsync(["node", "test", "auth", "status", "--json"]);

    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ profiles: [] }, null, 2),
    );
    expect(mockManager.getProfileStatus).not.toHaveBeenCalled();
  });

  it("lists configured auth profiles without exposing secret values", async () => {
    await program.parseAsync(["node", "test", "auth", "list"]);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Configured authProfiles");
    expect(output).toContain("openaiApi");
    expect(output).toContain("codexBrowser");
    expect(output).toContain("ref:configured");
    expect(output).not.toContain("sk-live");
  });

  it("shows status for each configured profile", async () => {
    mockManager.getProfileStatus.mockImplementation(async (profile: string) => {
      if (profile === "openaiApi") {
        return {
          status: "authenticated",
          message: "OpenAI API key reference OPENAI_API_KEY is available",
        };
      }
      return { status: "not_authenticated", message: "Codex CLI is not authenticated" };
    });

    await program.parseAsync(["node", "test", "auth", "status"]);

    expect(mockManager.getProfileStatus).toHaveBeenCalledWith("openaiApi");
    expect(mockManager.getProfileStatus).toHaveBeenCalledWith("codexBrowser");

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("authenticated");
    expect(output).toContain("not_authenticated");
    expect(output).toContain("Next: ao auth login codexBrowser");
  });

  it("emits machine-readable auth status with warnings and failure reasons", async () => {
    mockManager.getProfileStatus.mockImplementation(async (profile: string) => {
      if (profile === "openaiApi") {
        return {
          status: "authenticated",
          message: "OpenAI API key reference OPENAI_API_KEY is available",
        };
      }
      return {
        status: "unsupported_environment",
        message: "Codex browser auth requires a supported local interactive environment",
      };
    });
    mockManager.checkProfileHealth.mockImplementation(async (profile: string) => {
      if (profile === "openaiApi") {
        return {
          state: "healthy",
          authStatus: "authenticated",
          message: "ok",
          checks: [{ key: "credential-reference", status: "pass", detail: "Credential reference configured" }],
        };
      }
      return {
        state: "degraded",
        authStatus: "unsupported_environment",
        message: "warning",
        checks: [
          {
            key: "browser-environment",
            status: "warn",
            detail:
              "Browser auth login requires a supported local interactive environment, but CI was detected",
          },
        ],
      };
    });

    await program.parseAsync(["node", "test", "auth", "status", "--json"]);

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(payload).toEqual({
      profiles: [
        expect.objectContaining({
          profile: "openaiApi",
          provider: "openai",
          mode: "api-key",
          status: "authenticated",
          available: true,
          healthState: "healthy",
          warnings: [],
          failureReason: null,
          nextStep: null,
        }),
        expect.objectContaining({
          profile: "codexBrowser",
          provider: "openai",
          mode: "browser-account",
          accountType: "chatgpt-plus",
          status: "unsupported_environment",
          available: false,
          healthState: "degraded",
          warnings: [
            "Browser auth login requires a supported local interactive environment, but CI was detected",
          ],
          failureReason: "Codex browser auth requires a supported local interactive environment",
          nextStep: "Next: run from a supported local interactive environment",
        }),
      ],
    });
  });

  it("passes live validation through to machine-readable auth status", async () => {
    mockManager.getProfileStatus.mockResolvedValue({
      status: "authenticated",
      message: "OpenAI API key reference OPENAI_API_KEY is available",
    });
    mockManager.checkProfileHealth.mockResolvedValue({
      state: "healthy",
      authStatus: "authenticated",
      message: "live validation ok",
      checks: [
        {
          key: "openai-live-validation",
          status: "pass",
          detail: "OpenAI accepted the configured API key reference",
        },
      ],
    });

    await program.parseAsync(["node", "test", "auth", "status", "--json", "--live"]);

    expect(mockManager.checkProfileHealth).toHaveBeenCalledWith("openaiApi", { live: true });
    expect(mockManager.checkProfileHealth).toHaveBeenCalledWith("codexBrowser", { live: true });

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(payload.profiles[0]).toEqual(
      expect.objectContaining({
        profile: "openaiApi",
        healthState: "healthy",
        checks: [
          expect.objectContaining({
            key: "openai-live-validation",
            status: "pass",
          }),
        ],
      }),
    );
  });

  it("shows browser environment warnings from auth health checks", async () => {
    mockManager.getProfileStatus.mockResolvedValue({
      status: "authenticated",
      message: "Codex CLI is authenticated",
    });
    mockManager.checkProfileHealth.mockResolvedValue({
      state: "degraded",
      authStatus: "authenticated",
      message: "warning",
      checks: [
        {
          key: "browser-environment",
          status: "warn",
          detail:
            "Browser auth login requires a supported local interactive environment, but CI was detected",
        },
      ],
    });

    await program.parseAsync(["node", "test", "auth", "status"]);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Warning:");
    expect(output).toContain("supported local interactive environment");
  });

  it("labels text output when live validation is requested", async () => {
    mockManager.getProfileStatus.mockResolvedValue({
      status: "authenticated",
      message: "OpenAI API key reference OPENAI_API_KEY is available",
    });

    await program.parseAsync(["node", "test", "auth", "status", "--live"]);

    expect(mockManager.checkProfileHealth).toHaveBeenCalledWith("openaiApi", { live: true });
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "Auth profile status (live validation):",
    );
  });

  it("delegates login to auth manager and prints result", async () => {
    mockManager.loginProfile.mockResolvedValue({
      status: "authenticated",
      message: "Codex CLI is authenticated",
    });

    await program.parseAsync(["node", "test", "auth", "login", "codexBrowser"]);

    expect(mockManager.loginProfile).toHaveBeenCalledWith("codexBrowser");
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("authenticated");
  });

  it("delegates logout to auth manager and prints result", async () => {
    mockManager.logoutProfile.mockResolvedValue({
      status: "not_authenticated",
      message: "Codex CLI is logged out",
    });

    await program.parseAsync(["node", "test", "auth", "logout", "codexBrowser"]);

    expect(mockManager.logoutProfile).toHaveBeenCalledWith("codexBrowser");
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("not_authenticated");
  });

  it("shows helpful guidance when not authenticated on login", async () => {
    mockManager.loginProfile.mockResolvedValue({
      status: "not_authenticated",
      message: "Codex browser auth login failed",
    });

    await program.parseAsync(["node", "test", "auth", "login", "codexBrowser"]);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Next: ao auth login codexBrowser");
  });

  it("shows setup guidance when a provider is unavailable", async () => {
    mockManager.getProfileStatus.mockResolvedValue({
      status: "unavailable",
      message: "Codex CLI is not available on this machine",
    });

    await program.parseAsync(["node", "test", "auth", "status"]);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("unavailable");
    expect(output).toContain("Next: install/provider CLI or configure referenced credentials");
  });

  it("exits with error on auth manager failures", async () => {
    mockManager.getProfileStatus.mockRejectedValue(new Error("Unknown auth profile: missing"));
    mockConfigRef.current = {
      authProfiles: {
        missing: { type: "api-key", provider: "openai" },
      },
    } as Record<string, unknown>;

    await expect(program.parseAsync(["node", "test", "auth", "status"])).rejects.toThrow(
      "process.exit(1)",
    );

    expect(errSpy).toHaveBeenCalled();
  });
});
