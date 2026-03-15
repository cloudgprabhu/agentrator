import { describe, expect, it } from "vitest";
import {
  createOpenAICodexBrowserAuthAdapter,
  formatCodexAuthStatusForCli,
} from "../auth-adapters/openai-codex-browser.js";
import type { AuthAdapterContext } from "../types.js";

function makeContext(overrides: Partial<AuthAdapterContext> = {}): AuthAdapterContext {
  return {
    profileKey: "codex-browser",
    profile: {
      type: "browser-account",
      provider: "openai",
      accountType: "chatgpt-plus",
    },
    providerKey: "openai",
    provider: {
      kind: "openai",
    },
    ...overrides,
  };
}

describe("openai codex browser auth adapter", () => {
  it("supports openai browser-account profiles", () => {
    const adapter = createOpenAICodexBrowserAuthAdapter({
      runCodexCli: async () => ({ success: true, stdout: "authenticated", stderr: "" }),
    });
    expect(adapter.supports(makeContext())).toBe(true);
    expect(
      adapter.supports(
        makeContext({
          profile: { type: "api-key", provider: "openai" },
        }),
      ),
    ).toBe(false);
  });

  it("supports chatgpt-pro account hints", () => {
    const adapter = createOpenAICodexBrowserAuthAdapter({
      runCodexCli: async () => ({ success: true, stdout: "authenticated", stderr: "" }),
    });

    expect(
      adapter.supports(
        makeContext({
          profile: {
            type: "browser-account",
            provider: "openai",
            accountType: "chatgpt-pro",
          },
        }),
      ),
    ).toBe(true);
  });

  it.each([
    { name: "json authenticated boolean", stdout: '{"authenticated":true}', stderr: "" },
    { name: "json loggedIn boolean", stdout: '{"loggedIn":true}', stderr: "" },
    { name: "json status field", stdout: '{"status":"authenticated"}', stderr: "" },
    { name: "legacy text stdout", stdout: "Authenticated", stderr: "" },
    { name: "legacy text stderr", stdout: "", stderr: "active session" },
  ])("returns authenticated status for supported Codex CLI output shape: $name", async (fixture) => {
    const adapter = createOpenAICodexBrowserAuthAdapter({
      runCodexCli: async () => ({ success: true, stdout: fixture.stdout, stderr: fixture.stderr }),
    });

    const status = await adapter.getStatus!(makeContext());
    expect(status.status).toBe("authenticated");
  });

  it.each([
    {
      name: "json authenticated false",
      success: true,
      stdout: '{"authenticated":false}',
      stderr: "",
    },
    {
      name: "json loggedIn false",
      success: true,
      stdout: '{"loggedIn":false}',
      stderr: "",
    },
    {
      name: "json not_authenticated status",
      success: true,
      stdout: '{"status":"not_authenticated"}',
      stderr: "",
    },
    {
      name: "legacy login required stderr",
      success: false,
      stdout: "",
      stderr: "login required",
    },
    {
      name: "legacy not logged stdout",
      success: true,
      stdout: "not logged in",
      stderr: "",
    },
  ])("returns not_authenticated status for supported Codex CLI output shape: $name", async (fixture) => {
    const adapter = createOpenAICodexBrowserAuthAdapter({
      runCodexCli: async () => ({
        success: fixture.success,
        stdout: fixture.stdout,
        stderr: fixture.stderr,
      }),
    });

    const status = await adapter.getStatus!(makeContext());
    expect(status.status).toBe("not_authenticated");
  });

  it("returns unavailable when Codex CLI is not installed", async () => {
    const adapter = createOpenAICodexBrowserAuthAdapter({
      runCodexCli: async () => ({ success: false, stdout: "", stderr: "", unavailable: true }),
    });

    const status = await adapter.getStatus!(makeContext());
    expect(status.status).toBe("unavailable");
  });

  it("returns unsupported_environment for login in CI", async () => {
    const adapter = createOpenAICodexBrowserAuthAdapter({
      runCodexCli: async () => ({ success: true, stdout: "", stderr: "" }),
      isCi: true,
    });

    const status = await adapter.login!(makeContext());
    expect(status.status).toBe("unsupported_environment");
  });

  it("login delegates to codex login before re-checking status", async () => {
    const calls: string[][] = [];
    const adapter = createOpenAICodexBrowserAuthAdapter({
      runCodexCli: async (args) => {
        calls.push(args);
        if (args[0] === "login" && args.length === 1) {
          return { success: true, stdout: "", stderr: "" };
        }
        return { success: true, stdout: "Logged in using ChatGPT", stderr: "" };
      },
      platform: "darwin",
    });

    const status = await adapter.login!(makeContext());
    expect(status.status).toBe("authenticated");
    expect(calls).toEqual([
      ["login"],
      ["login", "status"],
    ]);
  });

  it("falls back to legacy codex auth subcommands when the new login command shape is unsupported", async () => {
    const calls: string[][] = [];
    const adapter = createOpenAICodexBrowserAuthAdapter({
      runCodexCli: async (args) => {
        calls.push(args);
        if (args[0] === "login" && args[1] === "status") {
          return {
            success: false,
            stdout: "",
            stderr: "error: unrecognized subcommand 'status'",
          };
        }
        if (args[0] === "auth" && args[1] === "status") {
          return { success: true, stdout: '{"authenticated":true}', stderr: "" };
        }
        return { success: false, stdout: "", stderr: "unexpected invocation" };
      },
    });

    const status = await adapter.getStatus!(makeContext());
    expect(status.status).toBe("authenticated");
    expect(calls).toEqual([
      ["login", "status"],
      ["auth", "status", "--json"],
    ]);
  });

  it("returns safe error messages for failed login output", async () => {
    const adapter = createOpenAICodexBrowserAuthAdapter({
      runCodexCli: async () => ({
        success: false,
        stdout: "",
        stderr: "fatal: token sk-secret-value invalid",
      }),
      platform: "darwin",
    });

    const status = await adapter.login!(makeContext());
    expect(status).toEqual({
      status: "not_authenticated",
      message: "Codex browser auth login failed",
    });
  });

  it("logout delegates to codex logout", async () => {
    const calls: string[][] = [];
    const adapter = createOpenAICodexBrowserAuthAdapter({
      runCodexCli: async (args) => {
        calls.push(args);
        return { success: true, stdout: "", stderr: "" };
      },
    });

    const status = await adapter.logout!(makeContext());
    expect(status.status).toBe("not_authenticated");
    expect(calls[0]).toEqual(["logout"]);
  });

  it("returns safe status output when CLI failure text is opaque", async () => {
    const adapter = createOpenAICodexBrowserAuthAdapter({
      runCodexCli: async () => ({
        success: false,
        stdout: "",
        stderr: "fatal: token sk-secret-value invalid",
      }),
    });

    const status = await adapter.getStatus!(makeContext());
    expect(status).toEqual({
      status: "unavailable",
      message: "Codex browser auth status check failed",
    });
  });

  it("formats codex auth status for CLI output", () => {
    expect(
      formatCodexAuthStatusForCli({
        status: "authenticated",
        message: "Codex CLI is authenticated",
      }),
    ).toBe("authenticated: Codex CLI is authenticated");
  });

  it("does not misread JSON false payloads as authenticated", async () => {
    const adapter = createOpenAICodexBrowserAuthAdapter({
      runCodexCli: async () => ({
        success: true,
        stdout: '{"authenticated":false,"status":"not_authenticated"}',
        stderr: "",
      }),
    });

    const status = await adapter.getStatus!(makeContext());
    expect(status).toEqual({
      status: "not_authenticated",
      message: "Codex CLI is not authenticated",
    });
  });
});
