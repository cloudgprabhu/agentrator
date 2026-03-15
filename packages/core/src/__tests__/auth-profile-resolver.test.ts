import { describe, expect, it } from "vitest";
import type { OrchestratorConfig } from "../types.js";
import { hasInlineSecretValues, resolveAuthProfile } from "../auth-profile-resolver.js";

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

describe("auth-profile-resolver", () => {
  it("resolves a configured auth profile and provider", () => {
    const resolved = resolveAuthProfile(makeConfig(), "api");

    expect(resolved.key).toBe("api");
    expect(resolved.providerKey).toBe("openai");
    expect(resolved.provider?.kind).toBe("openai");
    expect(resolved.profile.credentialEnvVar).toBe("OPENAI_API_KEY");
  });

  it("rejects unknown auth profiles", () => {
    expect(() => resolveAuthProfile(makeConfig(), "missing")).toThrow(/Unknown auth profile/);
  });

  it("rejects auth profiles that reference an unknown provider", () => {
    const config = makeConfig({
      authProfiles: {
        api: {
          type: "api-key",
          provider: "missing-provider",
          credentialEnvVar: "OPENAI_API_KEY",
        },
      },
    });

    expect(() => resolveAuthProfile(config, "api")).toThrow(
      /references unknown provider "missing-provider"/,
    );
  });

  it("rejects nested inline secret values", () => {
    const config = makeConfig({
      authProfiles: {
        api: {
          type: "api-key",
          provider: "openai",
          options: {
            nested: {
              apiKey: "sk-live-secret",
            },
          },
        },
      },
    });

    expect(() => resolveAuthProfile(config, "api")).toThrow(/options\.nested\.apiKey/);
  });

  it("allows reference-only auth profile fields", () => {
    const config = makeConfig({
      authProfiles: {
        api: {
          type: "api-key",
          provider: "openai",
          credentialEnvVar: "OPENAI_API_KEY",
          credentialRef: "vault://team/openai",
          options: {
            profileRef: "shared-openai-profile",
          },
        },
      },
    });

    expect(() => resolveAuthProfile(config, "api")).not.toThrow();
  });
});

describe("hasInlineSecretValues", () => {
  it("returns nested secret paths only for restricted keys", () => {
    const hits = hasInlineSecretValues({
      credentialEnvVar: "OPENAI_API_KEY",
      options: {
        nested: {
          token: "secret-token",
        },
        label: "safe",
      },
    });

    expect(hits).toEqual(["options.nested.token"]);
  });
});
