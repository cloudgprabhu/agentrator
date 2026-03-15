import { describe, expect, it } from "vitest";
import { resolveModelRuntimeConfig } from "../model-profile-resolution.js";
import type { OrchestratorConfig } from "../types.js";

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
      },
      anthropic: {
        kind: "anthropic",
      },
    },
    authProfiles: {
      openaiApi: {
        type: "api-key",
        provider: "openai",
        credentialEnvVar: "OPENAI_API_KEY",
      },
    },
    modelProfiles: {
      impl: {
        provider: "openai",
        agent: "codex",
        authProfile: "openaiApi",
        model: "o4-mini",
        rulesFile: ".ao/model-rules.md",
        promptPrefix: "Follow incremental rollout steps.",
        guardrails: ["Never force push", "Always update tests"],
        runtime: {
          approvalPolicy: "suggest",
          reasoningEffort: "high",
        },
      },
    },
    roles: {
      implementer: {
        modelProfile: "impl",
        rulesFile: ".ao/role-rules.md",
        promptPrefix: "Plan first, then implement.",
        guardrails: "Keep changes minimal",
      },
    },
    workflow: {
      default: {
        parentIssueRole: "implementer",
        childIssueRole: "implementer",
        reviewRole: "implementer",
        ciFixRole: "implementer",
      },
    },
    projects: {
      app: {
        name: "app",
        repo: "org/app",
        path: "/repos/app",
        defaultBranch: "main",
        sessionPrefix: "app",
        workflow: "default",
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    ...overrides,
  };
}

describe("model profile resolution", () => {
  it("resolves role -> modelProfile -> authProfile/provider and runtime settings", () => {
    const resolved = resolveModelRuntimeConfig({
      config: makeConfig(),
      projectId: "app",
      agent: "claude-code",
    });

    expect(resolved.roleKey).toBe("implementer");
    expect(resolved.modelProfileKey).toBe("impl");
    expect(resolved.providerKey).toBe("openai");
    expect(resolved.authProfileKey).toBe("openaiApi");
    expect(resolved.agent).toBe("codex");
    expect(resolved.model).toBe("o4-mini");
    expect(resolved.runtimeSettings.approvalPolicy).toBe("suggest");
    expect(resolved.runtimeSettings.reasoningEffort).toBe("high");
    expect(resolved.promptSettings.rulesFiles).toEqual([".ao/model-rules.md", ".ao/role-rules.md"]);
    expect(resolved.promptSettings.promptPrefix).toBe("Plan first, then implement.");
    expect(resolved.promptSettings.guardrails).toEqual([
      "Never force push",
      "Always update tests",
      "Keep changes minimal",
    ]);
  });

  it("supports explicit agent override precedence", () => {
    const resolved = resolveModelRuntimeConfig({
      config: makeConfig(),
      projectId: "app",
      agent: "claude-code",
      agentOverride: "codex",
    });

    expect(resolved.agent).toBe("codex");
  });

  it("uses explicit roleKey over workflow default role", () => {
    const config = makeConfig({
      modelProfiles: {
        impl: {
          provider: "openai",
          agent: "codex",
          authProfile: "openaiApi",
          model: "o4-mini",
        },
        planner: {
          provider: "openai",
          agent: "codex",
          authProfile: "openaiApi",
          model: "o3",
        },
      },
      roles: {
        implementer: { modelProfile: "impl" },
        planner: { modelProfile: "planner" },
      },
    });

    const resolved = resolveModelRuntimeConfig({
      config,
      projectId: "app",
      agent: "claude-code",
      roleKey: "planner",
    });

    expect(resolved.roleKey).toBe("planner");
    expect(resolved.modelProfileKey).toBe("planner");
    expect(resolved.model).toBe("o3");
  });

  it("falls back to modelProfile prompt settings when role does not override them", () => {
    const config = makeConfig({
      roles: {
        implementer: {
          modelProfile: "impl",
        },
      },
      modelProfiles: {
        impl: {
          provider: "openai",
          agent: "codex",
          authProfile: "openaiApi",
          model: "o4-mini",
          rulesFile: ".ao/model-only-rules.md",
          promptPrefix: "Model-level guidance.",
          guardrails: ["Stay within the existing API contract"],
        },
      },
    });

    const resolved = resolveModelRuntimeConfig({
      config,
      projectId: "app",
      agent: "claude-code",
    });

    expect(resolved.promptSettings.rulesFiles).toEqual([".ao/model-only-rules.md"]);
    expect(resolved.promptSettings.promptPrefix).toBe("Model-level guidance.");
    expect(resolved.promptSettings.guardrails).toEqual([
      "Stay within the existing API contract",
    ]);
  });

  it("dedupes merged rules files and guardrails and trims blank prompt settings", () => {
    const config = makeConfig({
      modelProfiles: {
        impl: {
          provider: "openai",
          agent: "codex",
          authProfile: "openaiApi",
          model: "o4-mini",
          rulesFile: "  .ao/shared-rules.md  ",
          promptPrefix: "  Model-level guidance.  ",
          guardrails: [" Keep PR scope focused ", "Always update tests", "Keep PR scope focused"],
        },
      },
      roles: {
        implementer: {
          modelProfile: "impl",
          rulesFile: ".ao/shared-rules.md",
          promptPrefix: "   ",
          guardrails: ["Always update tests", " Keep PR scope focused ", "", "Add migration notes"],
        },
      },
    });

    const resolved = resolveModelRuntimeConfig({
      config,
      projectId: "app",
      agent: "claude-code",
    });

    expect(resolved.promptSettings.rulesFiles).toEqual([".ao/shared-rules.md"]);
    expect(resolved.promptSettings.promptPrefix).toBe("Model-level guidance.");
    expect(resolved.promptSettings.guardrails).toEqual([
      "Keep PR scope focused",
      "Always update tests",
      "Add migration notes",
    ]);
  });

  it("throws clear error when explicit role key is unknown", () => {
    expect(() =>
      resolveModelRuntimeConfig({
        config: makeConfig(),
        projectId: "app",
        agent: "claude-code",
        roleKey: "missing-role",
      }),
    ).toThrow(/Unknown role reference "missing-role"/i);
  });

  it("falls back to legacy project agentConfig model when role mapping is unavailable", () => {
    const config = makeConfig({
      projects: {
        app: {
          name: "app",
          repo: "org/app",
          path: "/repos/app",
          defaultBranch: "main",
          sessionPrefix: "app",
          agentConfig: {
            model: "claude-sonnet-4-20250514",
          },
        },
      },
      workflow: {},
    });

    const resolved = resolveModelRuntimeConfig({
      config,
      projectId: "app",
      agent: "claude-code",
    });

    expect(resolved.model).toBe("claude-sonnet-4-20250514");
    expect(resolved.roleKey).toBeUndefined();
  });

  it("throws clear error when model profile is missing", () => {
    const config = makeConfig({
      roles: {
        implementer: {
          modelProfile: "missing",
        },
      },
    });

    expect(() =>
      resolveModelRuntimeConfig({
        config,
        projectId: "app",
        agent: "claude-code",
      }),
    ).toThrow(/unknown modelProfile "missing"/i);
  });

  it("throws clear error for incompatible model/provider", () => {
    const config = makeConfig({
      modelProfiles: {
        impl: {
          provider: "openai",
          agent: "codex",
          authProfile: "openaiApi",
          model: "claude-sonnet-4-20250514",
        },
      },
    });

    expect(() =>
      resolveModelRuntimeConfig({
        config,
        projectId: "app",
        agent: "codex",
      }),
    ).toThrow(/not compatible with provider "openai"/i);
  });

  it("throws when runtime setting is unsupported by agent", () => {
    const config = makeConfig({
      modelProfiles: {
        impl: {
          provider: "anthropic",
          agent: "claude-code",
          model: "claude-sonnet-4-20250514",
          runtime: {
            reasoningEffort: "high",
          },
        },
      },
      authProfiles: {},
    });

    expect(() =>
      resolveModelRuntimeConfig({
        config,
        projectId: "app",
        agent: "claude-code",
      }),
    ).toThrow(/reasoningEffort is not supported by agent "claude-code"/i);
  });

  it("validates provider compatibility against the effective agent override", () => {
    expect(() =>
      resolveModelRuntimeConfig({
        config: makeConfig(),
        projectId: "app",
        agent: "claude-code",
        agentOverride: "claude-code",
      }),
    ).toThrow(/Resolved agent "claude-code" is not compatible with provider "openai"/i);
  });
});
