import { describe, expect, it } from "vitest";
import {
  createAnthropicClaudeBrowserAuthAdapter,
  formatAuthStatusForCli,
} from "../auth-adapters/anthropic-claude-browser.js";
import type { AuthAdapterContext } from "../types.js";

function makeContext(overrides: Partial<AuthAdapterContext> = {}): AuthAdapterContext {
  return {
    profileKey: "claude-browser",
    profile: {
      type: "browser-account",
      provider: "anthropic",
      accountType: "claude-pro",
    },
    providerKey: "anthropic",
    provider: {
      kind: "anthropic",
    },
    ...overrides,
  };
}

describe("anthropic claude browser auth adapter", () => {
  it("supports anthropic browser-account profiles", () => {
    const adapter = createAnthropicClaudeBrowserAuthAdapter({
      runClaudeCli: async () => ({ success: true, stdout: "authenticated", stderr: "" }),
    });
    expect(adapter.supports(makeContext())).toBe(true);
    expect(
      adapter.supports(
        makeContext({
          profile: { type: "api-key", provider: "anthropic" },
        }),
      ),
    ).toBe(false);
  });

  it.each([
    { name: "json authenticated boolean", stdout: '{"authenticated":true}', stderr: "" },
    { name: "json loggedIn boolean", stdout: '{"loggedIn":true}', stderr: "" },
    { name: "json status field", stdout: '{"status":"authenticated"}', stderr: "" },
    { name: "legacy text stdout", stdout: "authenticated", stderr: "" },
    { name: "legacy text stderr", stdout: "", stderr: "active session" },
  ])("returns authenticated status for supported Claude CLI output shape: $name", async (fixture) => {
    const adapter = createAnthropicClaudeBrowserAuthAdapter({
      runClaudeCli: async () => ({ success: true, stdout: fixture.stdout, stderr: fixture.stderr }),
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
  ])("returns not_authenticated status for supported Claude CLI output shape: $name", async (fixture) => {
    const adapter = createAnthropicClaudeBrowserAuthAdapter({
      runClaudeCli: async () => ({
        success: fixture.success,
        stdout: fixture.stdout,
        stderr: fixture.stderr,
      }),
    });

    const status = await adapter.getStatus!(makeContext());
    expect(status.status).toBe("not_authenticated");
  });

  it("returns unavailable when Claude CLI is not installed", async () => {
    const adapter = createAnthropicClaudeBrowserAuthAdapter({
      runClaudeCli: async () => ({ success: false, stdout: "", stderr: "", unavailable: true }),
    });

    const status = await adapter.getStatus!(makeContext());
    expect(status.status).toBe("unavailable");
  });

  it("returns unsupported_environment for login in CI", async () => {
    const adapter = createAnthropicClaudeBrowserAuthAdapter({
      runClaudeCli: async () => ({ success: true, stdout: "", stderr: "" }),
      isCi: true,
    });

    const status = await adapter.login!(makeContext());
    expect(status.status).toBe("unsupported_environment");
  });

  it("logout delegates to claude auth logout", async () => {
    const calls: string[][] = [];
    const adapter = createAnthropicClaudeBrowserAuthAdapter({
      runClaudeCli: async (args) => {
        calls.push(args);
        return { success: true, stdout: "", stderr: "" };
      },
    });

    const status = await adapter.logout!(makeContext());
    expect(status.status).toBe("not_authenticated");
    expect(calls[0]).toEqual(["auth", "logout"]);
  });

  it("formats auth status for CLI output", () => {
    expect(
      formatAuthStatusForCli({ status: "authenticated", message: "Claude CLI is authenticated" }),
    ).toBe("authenticated: Claude CLI is authenticated");
  });

  it("does not misread JSON false payloads as authenticated", async () => {
    const adapter = createAnthropicClaudeBrowserAuthAdapter({
      runClaudeCli: async () => ({
        success: true,
        stdout: '{"authenticated":false,"status":"not_authenticated"}',
        stderr: "",
      }),
    });

    const status = await adapter.getStatus!(makeContext());
    expect(status).toEqual({
      status: "not_authenticated",
      message: "Claude CLI is not authenticated",
    });
  });
});
