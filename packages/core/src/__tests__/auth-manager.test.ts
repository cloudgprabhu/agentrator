import { describe, expect, it } from "vitest";
import type { AuthProviderAdapter, OrchestratorConfig } from "../types.js";
import { createAuthManager } from "../auth-manager.js";
import { resolveAuthProfile } from "../auth-profile-resolver.js";
import { createOpenAICodexBrowserAuthAdapter } from "../auth-adapters/openai-codex-browser.js";
import { createOpenAIApiKeyAuthAdapter } from "../auth-adapters/non-browser-auth.js";

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    providers: {
      openai: {
        kind: "openai",
        capabilities: { apiAuth: true, browserAuth: true },
      },
    },
    authProfiles: {
      browser: {
        type: "browser-account",
        provider: "openai",
      },
      api: {
        type: "api-key",
        provider: "openai",
        credentialEnvVar: "OPENAI_API_KEY",
      },
    },
    projects: {
      app: {
        name: "app",
        repo: "org/app",
        path: "/repos/app",
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    ...overrides,
  };
}

describe("auth profile resolver", () => {
  it("resolves profile and provider", () => {
    const config = makeConfig();
    const resolved = resolveAuthProfile(config, "api");

    expect(resolved.key).toBe("api");
    expect(resolved.providerKey).toBe("openai");
    expect(resolved.provider?.kind).toBe("openai");
  });

  it("rejects unknown auth profile", () => {
    expect(() => resolveAuthProfile(makeConfig(), "missing")).toThrow(/Unknown auth profile/);
  });

  it("rejects inline secret values", () => {
    const config = makeConfig({
      authProfiles: {
        bad: {
          type: "api-key",
          provider: "openai",
          token: "sk-live-secret",
        },
      },
    });

    expect(() => resolveAuthProfile(config, "bad")).toThrow(/inline secret values/);
  });
});

describe("auth manager", () => {
  it("reports healthy api-key profile with reference", async () => {
    const manager = createAuthManager({ config: makeConfig(), defaultAdapters: [] });
    const health = await manager.checkProfileHealth("api");

    expect(health.state).toBe("healthy");
    expect(health.checks.some((check) => check.key === "credential-reference")).toBe(true);
  });

  it("reports invalid api-key profile missing references", async () => {
    const config = makeConfig({
      authProfiles: {
        api: {
          type: "api-key",
          provider: "openai",
        },
      },
    });
    const manager = createAuthManager({ config, defaultAdapters: [] });
    const health = await manager.checkProfileHealth("api");

    expect(health.state).toBe("invalid");
    expect(health.message).toContain("invalid");
  });

  it("supports pluggable provider adapters", async () => {
    const adapter: AuthProviderAdapter = {
      name: "custom-openai-adapter",
      supports: (context) => context.providerKey === "openai",
      checkHealth: async () => ({
        state: "healthy",
        message: "adapter result",
        checks: [{ key: "adapter", status: "pass", detail: "ok" }],
      }),
    };

    const manager = createAuthManager({
      config: makeConfig(),
      defaultAdapters: [],
      adapters: [adapter],
    });
    const health = await manager.checkProfileHealth("api");

    expect(health.message).toBe("adapter result");
    expect(health.checks[0]?.key).toBe("adapter");
  });

  it("checks all profiles", async () => {
    const manager = createAuthManager({ config: makeConfig(), defaultAdapters: [] });
    const statuses = await manager.checkAllProfilesHealth();

    expect(statuses.browser).toBeDefined();
    expect(statuses.api).toBeDefined();
  });

  it("integrates OpenAI Codex adapter for browser-account status", async () => {
    const manager = createAuthManager({
      config: makeConfig(),
      defaultAdapters: [
        createOpenAICodexBrowserAuthAdapter({
          runCodexCli: async () => ({
            success: true,
            stdout: '{"authenticated":true}',
            stderr: "",
          }),
        }),
      ],
    });

    const status = await manager.getProfileStatus("browser");
    expect(status.status).toBe("authenticated");
  });

  it("warns when browser auth runs in an unsupported environment", async () => {
    const manager = createAuthManager({
      config: makeConfig(),
      defaultAdapters: [
        createOpenAICodexBrowserAuthAdapter({
          isCi: true,
          runCodexCli: async () => ({
            success: true,
            stdout: '{"authenticated":true}',
            stderr: "",
          }),
        }),
      ],
    });

    const health = await manager.checkProfileHealth("browser");
    expect(health.state).toBe("degraded");
    expect(health.checks).toContainEqual(
      expect.objectContaining({
        key: "browser-environment",
        status: "warn",
      }),
    );
  });

  it("integrates OpenAI API-key adapter status", async () => {
    const manager = createAuthManager({
      config: makeConfig(),
      defaultAdapters: [createOpenAIApiKeyAuthAdapter({ OPENAI_API_KEY: "sk-ref" })],
    });

    const status = await manager.getProfileStatus("api");
    expect(status.status).toBe("authenticated");
  });

  it("uses live validation when explicitly requested", async () => {
    const manager = createAuthManager({
      config: makeConfig(),
      defaultAdapters: [
        createOpenAIApiKeyAuthAdapter(
          { OPENAI_API_KEY: "sk-ref" },
          async () => ({
            ok: true,
            status: 200,
            text: async () => "{}",
          }),
        ),
      ],
    });

    const health = await manager.checkProfileHealth("api", { live: true });
    expect(health.state).toBe("healthy");
    expect(health.checks).toContainEqual(
      expect.objectContaining({
        key: "openai-live-validation",
        status: "pass",
      }),
    );
  });

  it("degrades live validation when an adapter does not support it", async () => {
    const manager = createAuthManager({
      config: makeConfig(),
      defaultAdapters: [],
    });

    const health = await manager.checkProfileHealth("browser", { live: true });
    expect(health.state).toBe("degraded");
    expect(health.checks).toContainEqual(
      expect.objectContaining({
        key: "live-validation",
        status: "warn",
      }),
    );
  });

  it("exposes CLI-compatible auth status values", async () => {
    const manager = createAuthManager({ config: makeConfig(), defaultAdapters: [] });
    const status = await manager.getProfileStatus("api");

    expect(status.status).toBe("authenticated");
  });

  it("supports login/logout via pluggable adapter methods", async () => {
    const browserConfig = makeConfig({
      providers: {
        anthropic: {
          kind: "anthropic",
        },
      },
      authProfiles: {
        claudeBrowser: {
          type: "browser-account",
          provider: "anthropic",
          accountType: "claude-pro",
        },
      },
    });

    const adapter: AuthProviderAdapter = {
      name: "stub-browser-adapter",
      supports: (context) => context.profileKey === "claudeBrowser",
      checkHealth: async () => ({
        state: "healthy",
        authStatus: "authenticated",
        message: "ok",
        checks: [{ key: "stub", status: "pass", detail: "ok" }],
      }),
      getStatus: async () => ({ status: "authenticated", message: "stub status" }),
      login: async () => ({ status: "authenticated", message: "stub login" }),
      logout: async () => ({ status: "not_authenticated", message: "stub logout" }),
    };

    const manager = createAuthManager({
      config: browserConfig,
      defaultAdapters: [],
      adapters: [adapter],
    });

    const loginResult = await manager.loginProfile("claudeBrowser");
    const logoutResult = await manager.logoutProfile("claudeBrowser");
    const statusResult = await manager.getProfileStatus("claudeBrowser");

    expect(loginResult.status).toBe("authenticated");
    expect(logoutResult.status).toBe("not_authenticated");
    expect(statusResult.status).toBe("authenticated");
  });
});
