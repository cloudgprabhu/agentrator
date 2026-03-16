/**
 * Unit tests for config validation (project uniqueness, prefix collisions).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig } from "../config.js";

describe("Config Validation - Project Uniqueness", () => {
  it("accepts projects that share the same path basename", () => {
    const config = {
      projects: {
        alpha: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
        },
        beta: {
          path: "/other/integrator", // Same basename!
          repo: "org/integrator",
          defaultBranch: "main",
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  it("uses config keys for default session prefixes", () => {
    const config = {
      projects: {
        planner: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
        },
        implementer: {
          path: "/other/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.planner.sessionPrefix).toBe("pla");
    expect(validated.projects.implementer.sessionPrefix).toBe("imp");
  });

  it("accepts two logical projects sharing the same repo path", () => {
    const config = {
      projects: {
        planner: {
          path: "/repos/shared-app",
          repo: "org/shared-app",
          defaultBranch: "main",
        },
        implementer: {
          path: "/repos/shared-app",
          repo: "org/shared-app",
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.planner.path).toBe("/repos/shared-app");
    expect(validated.projects.implementer.path).toBe("/repos/shared-app");
    expect(validated.projects.planner.sessionPrefix).toBe("pla");
    expect(validated.projects.implementer.sessionPrefix).toBe("imp");
  });

  it("accepts role-based logical projects sharing the same repo path", () => {
    const config = {
      providers: {
        openai: { kind: "openai" },
      },
      authProfiles: {
        api: { type: "api-key", provider: "openai" },
      },
      modelProfiles: {
        plannerModel: { model: "o4-mini", authProfile: "api" },
        implementerModel: { model: "o4-mini", authProfile: "api" },
      },
      roles: {
        planner: { modelProfile: "plannerModel" },
        implementer: { modelProfile: "implementerModel" },
      },
      workflow: {
        sharedRepoFlow: {
          parentIssueRole: "planner",
          childIssueRole: "implementer",
          reviewRole: "implementer",
          ciFixRole: "implementer",
        },
      },
      projects: {
        planner: {
          path: "/repos/shared-app",
          repo: "org/shared-app",
          defaultBranch: "main",
          workflow: "sharedRepoFlow",
        },
        implementer: {
          path: "/repos/shared-app",
          repo: "org/shared-app",
          defaultBranch: "main",
          workflow: "sharedRepoFlow",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.planner.workflow).toBe("sharedRepoFlow");
    expect(validated.projects.implementer.workflow).toBe("sharedRepoFlow");
  });

  it("accepts unique basenames", () => {
    const config = {
      projects: {
        alpha: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
        },
        beta: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });
});

describe("Config Validation - Session Prefix Uniqueness", () => {
  it("rejects duplicate explicit prefixes", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          sessionPrefix: "app",
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          sessionPrefix: "app", // Same prefix!
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/Duplicate session prefix/);
    expect(() => validateConfig(config)).toThrow(/"app"/);
  });

  it("rejects duplicate auto-generated prefixes", () => {
    const config = {
      projects: {
        integrator: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          // Auto-generates: "int"
        },
        international: {
          path: "/repos/international",
          repo: "org/international",
          defaultBranch: "main",
          // Auto-generates: "int" (collision!)
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/Duplicate session prefix/);
    expect(() => validateConfig(config)).toThrow(/"int"/);
  });

  it("error shows both conflicting projects", () => {
    const config = {
      projects: {
        integrator: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
        },
        international: {
          path: "/repos/international",
          repo: "org/international",
          defaultBranch: "main",
        },
      },
    };

    try {
      validateConfig(config);
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("integrator");
      expect(message).toContain("international");
    }
  });

  it("error suggests explicit sessionPrefix override", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          sessionPrefix: "app",
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      },
    };

    try {
      validateConfig(config);
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("sessionPrefix");
    }
  });

  it("accepts unique prefixes", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          sessionPrefix: "int",
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          sessionPrefix: "be",
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  it("validates mix of explicit and auto-generated prefixes", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          sessionPrefix: "int", // Explicit
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          // Auto-generates: "bac"
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  it("detects collision when explicit matches auto-generated", () => {
    const config = {
      projects: {
        integrator: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          // Auto-generates: "int"
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          sessionPrefix: "int", // Explicit collision with auto-generated
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/Duplicate session prefix/);
  });
});

describe("Config Validation - Session Prefix Regex", () => {
  it("accepts valid session prefixes", () => {
    const validPrefixes = ["int", "app", "my-app", "app_v2", "app123"];

    for (const prefix of validPrefixes) {
      const config = {
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            sessionPrefix: prefix,
          },
        },
      };

      expect(() => validateConfig(config)).not.toThrow();
    }
  });

  it("rejects invalid session prefixes", () => {
    const invalidPrefixes = ["app!", "app@test", "app space", "app/test"];

    for (const prefix of invalidPrefixes) {
      const config = {
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            sessionPrefix: prefix,
          },
        },
      };

      expect(() => validateConfig(config)).toThrow();
    }
  });
});

describe("Config Validation - SCM webhook contract", () => {
  it("accepts a project scm webhook block and defaults enabled=true", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          scm: {
            plugin: "github",
            webhook: {
              path: "/api/webhooks/github",
              secretEnvVar: "GITHUB_WEBHOOK_SECRET",
              eventHeader: "x-github-event",
              deliveryHeader: "x-github-delivery",
              signatureHeader: "x-hub-signature-256",
              maxBodyBytes: 1048576,
            },
          },
        },
      },
    });

    expect(config.projects["proj1"]?.scm).toEqual({
      plugin: "github",
      webhook: {
        enabled: true,
        path: "/api/webhooks/github",
        secretEnvVar: "GITHUB_WEBHOOK_SECRET",
        eventHeader: "x-github-event",
        deliveryHeader: "x-github-delivery",
        signatureHeader: "x-hub-signature-256",
        maxBodyBytes: 1048576,
      },
    });
  });

  it("rejects non-positive scm webhook maxBodyBytes", () => {
    expect(() =>
      validateConfig({
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            scm: {
              plugin: "github",
              webhook: {
                maxBodyBytes: 0,
              },
            },
          },
        },
      }),
    ).toThrow();
  });

  it("accepts a shared reviewer handoff store for multi-instance web deployments", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          scm: {
            plugin: "github",
            webhook: {
              reviewerHandoffStore: {
                provider: "shared-filesystem",
                pathEnvVar: "AO_SHARED_REVIEW_HANDOFF_DIR",
                keyPrefix: "prod-web",
              },
            },
          },
        },
      },
    });

    expect(config.projects["proj1"]?.scm?.webhook?.reviewerHandoffStore).toEqual({
      provider: "shared-filesystem",
      pathEnvVar: "AO_SHARED_REVIEW_HANDOFF_DIR",
      keyPrefix: "prod-web",
    });
  });

  it("rejects shared reviewer handoff stores without a path source", () => {
    expect(() =>
      validateConfig({
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            scm: {
              plugin: "github",
              webhook: {
                reviewerHandoffStore: {
                  provider: "shared-filesystem",
                },
              },
            },
          },
        },
      }),
    ).toThrow(/reviewerHandoffStore shared-filesystem provider requires path or pathEnvVar/);
  });
});

describe("Config Schema Validation", () => {
  it("requires projects field", () => {
    const config = {
      // No projects
    };

    expect(() => validateConfig(config)).toThrow();
  });

  it("requires path, repo, and defaultBranch for each project", () => {
    const missingPath = {
      projects: {
        proj1: {
          repo: "org/test",
          defaultBranch: "main",
          // Missing path
        },
      },
    };

    const missingRepo = {
      projects: {
        proj1: {
          path: "/repos/test",
          defaultBranch: "main",
          // Missing repo
        },
      },
    };

    const missingBranch = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          // Missing defaultBranch (should use default)
        },
      },
    };

    expect(() => validateConfig(missingPath)).toThrow();
    expect(() => validateConfig(missingRepo)).toThrow();
    // missingBranch should work (defaults to "main")
    expect(() => validateConfig(missingBranch)).not.toThrow();
  });

  it("sessionPrefix is optional", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          // No sessionPrefix - will be auto-generated
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.sessionPrefix).toBeDefined();
    expect(validated.projects.proj1.sessionPrefix).toBe("pro"); // derived from config key "proj1"
  });

  it("legacy single-project config shape still validates", () => {
    const config = {
      projects: {
        app: {
          path: "/repos/app",
          repo: "org/app",
          defaultBranch: "main",
          // legacy shape: no new providers/auth/model/roles/workflow blocks
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.app.name).toBe("app");
    expect(validated.projects.app.sessionPrefix).toBe("app");
  });

  it("legacy single-project YAML still loads through the config loader", () => {
    const configDir = mkdtempSync(join(tmpdir(), "ao-legacy-config-"));
    const configPath = join(configDir, "agent-orchestrator.yaml");

    try {
      writeFileSync(
        configPath,
        [
          "projects:",
          "  app:",
          "    path: /repos/app",
          "    repo: org/app",
          "    defaultBranch: main",
        ].join("\n"),
        "utf-8",
      );

      const loaded = loadConfig(configPath);
      expect(loaded.projects.app.name).toBe("app");
      expect(loaded.projects.app.sessionPrefix).toBe("app");
      expect(loaded.projects.app.path).toBe("/repos/app");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("accepts orchestratorModel in agentConfig", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          agentConfig: {
            model: "worker-model",
            orchestratorModel: "orchestrator-model",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.agentConfig?.model).toBe("worker-model");
    expect(validated.projects.proj1.agentConfig?.orchestratorModel).toBe("orchestrator-model");
  });
});

describe("Config Defaults", () => {
  it("applies default session prefix from project ID", () => {
    const config = {
      projects: {
        integrator: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.integrator.sessionPrefix).toBe("int");
  });

  it("applies default project name from config key", () => {
    const config = {
      projects: {
        "my-project": {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects["my-project"].name).toBe("my-project");
  });

  it("applies default SCM from repo", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test", // Contains "/" → GitHub
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.scm).toEqual({ plugin: "github" });
  });

  it("applies default tracker (GitHub issues)", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "github" });
  });

  it("accepts project autoSpawn configuration", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          autoSpawn: true,
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.autoSpawn).toBe(true);
  });

  it("infers GitLab tracker default from scm plugin", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          scm: {
            plugin: "gitlab",
            host: "gitlab.company.com",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.scm).toEqual({ plugin: "gitlab", host: "gitlab.company.com" });
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "gitlab" });
  });

  it("infers GitLab scm default from tracker plugin", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            plugin: "gitlab",
            host: "gitlab.com",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "gitlab", host: "gitlab.com" });
    expect(validated.projects.proj1.scm).toEqual({ plugin: "gitlab" });
  });
});

describe("Config Schema - profiles, roles, workflow", () => {
  it("accepts providers/authProfiles/modelProfiles/roles/workflow blocks", () => {
    const validated = validateConfig({
      providers: {
        openai: {
          kind: "openai",
          defaultAgentPlugin: "codex",
          capabilities: { browserAuth: true, apiAuth: true },
        },
      },
      authProfiles: {
        "team-api": {
          type: "api-key",
          provider: "openai",
          credentialEnvVar: "OPENAI_API_KEY",
        },
      },
      modelProfiles: {
        "impl-default": {
          agent: "codex",
          authProfile: "team-api",
          model: "o4-mini",
          rulesFile: ".ao/model-rules.md",
          promptPrefix: "Implement safely and incrementally.",
          guardrails: ["Never commit secrets", "Run tests before push"],
          runtime: { reasoning: "medium" },
        },
      },
      roles: {
        planner: {
          modelProfile: "impl-default",
          rulesFile: ".ao/planner-rules.md",
          promptPrefix: "Start with a short plan.",
          guardrails: "Do not make schema changes without migration notes",
        },
        implementer: {
          modelProfile: "impl-default",
          permissions: "auto-edit",
        },
        reviewer: {
          modelProfile: "impl-default",
        },
        fixer: {
          modelProfile: "impl-default",
        },
      },
      workflow: {
        "default-pr": {
          parentIssueRole: "planner",
          childIssueRole: "implementer",
          reviewRole: "reviewer",
          ciFixRole: "fixer",
        },
      },
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          workflow: "default-pr",
        },
      },
    });

    expect(validated.providers?.openai?.kind).toBe("openai");
    expect(validated.authProfiles?.["team-api"]?.type).toBe("api-key");
    expect(validated.modelProfiles?.["impl-default"]?.model).toBe("o4-mini");
    expect(validated.modelProfiles?.["impl-default"]?.rulesFile).toBe(".ao/model-rules.md");
    expect(validated.modelProfiles?.["impl-default"]?.promptPrefix).toBe(
      "Implement safely and incrementally.",
    );
    expect(validated.roles?.implementer?.modelProfile).toBe("impl-default");
    expect(validated.roles?.planner?.rulesFile).toBe(".ao/planner-rules.md");
    expect(validated.roles?.planner?.promptPrefix).toBe("Start with a short plan.");
    expect(validated.workflow?.["default-pr"]?.reviewRole).toBe("reviewer");
    expect(validated.projects.proj1.workflow).toBe("default-pr");
  });

  it("defaults new top-level config maps for backward compatibility", () => {
    const validated = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
    });

    expect(validated.providers ?? {}).toEqual({});
    expect(validated.authProfiles ?? {}).toEqual({});
    expect(validated.modelProfiles ?? {}).toEqual({});
    expect(validated.roles ?? {}).toEqual({});
    expect(validated.workflow ?? {}).toEqual({});
  });

  it("normalizes legacy role permission alias skip -> permissionless", () => {
    const validated = validateConfig({
      roles: {
        reviewer: {
          modelProfile: "review-model",
          permissions: "skip",
        },
      },
      modelProfiles: {
        "review-model": {
          model: "claude-sonnet-4-20250514",
        },
      },
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
    });

    expect(validated.roles?.reviewer?.permissions).toBe("permissionless");
  });

  it("rejects role without modelProfile", () => {
    expect(() =>
      validateConfig({
        roles: {
          planner: {
            permissions: "suggest",
          },
        },
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
          },
        },
      }),
    ).toThrow();
  });

  it("rejects workflow missing required role fields", () => {
    expect(() =>
      validateConfig({
        workflow: {
          bad: {
            parentIssueRole: "planner",
            childIssueRole: "implementer",
            reviewRole: "reviewer",
            // Missing ciFixRole
          },
        },
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
          },
        },
      }),
    ).toThrow();
  });

  it("rejects authProfile with unknown provider", () => {
    expect(() =>
      validateConfig(
        {
          providers: {
            openai: { kind: "openai" },
          },
          authProfiles: {
            bad: {
              type: "api-key",
              provider: "anthropic",
            },
          },
          projects: {
            proj1: {
              path: "/repos/test",
              repo: "org/test",
              defaultBranch: "main",
            },
          },
        },
        "/tmp/agent-orchestrator.yaml",
      ),
    ).toThrow(/authProfiles\.bad\.provider references unknown provider "anthropic"/);
  });

  it("rejects authProfile inline secret values", () => {
    expect(() =>
      validateConfig(
        {
          providers: {
            openai: { kind: "openai" },
          },
          authProfiles: {
            bad: {
              type: "api-key",
              provider: "openai",
              token: "sk-live-secret",
            },
          },
          projects: {
            proj1: {
              path: "/repos/test",
              repo: "org/test",
              defaultBranch: "main",
            },
          },
        },
        "/tmp/agent-orchestrator.yaml",
      ),
    ).toThrow(/includes inline secret values/);
  });

  it("rejects unsupported auth profile type", () => {
    expect(() =>
      validateConfig(
        {
          authProfiles: {
            bad: {
              type: "oauth-token",
            },
          },
          projects: {
            proj1: {
              path: "/repos/test",
              repo: "org/test",
              defaultBranch: "main",
            },
          },
        },
        "/tmp/agent-orchestrator.yaml",
      ),
    ).toThrow(/authProfiles\.bad\.type/);
  });

  it("rejects modelProfile with unknown authProfile", () => {
    expect(() =>
      validateConfig(
        {
          modelProfiles: {
            impl: {
              model: "o4-mini",
              authProfile: "missing-auth",
            },
          },
          projects: {
            proj1: {
              path: "/repos/test",
              repo: "org/test",
              defaultBranch: "main",
            },
          },
        },
        "/tmp/agent-orchestrator.yaml",
      ),
    ).toThrow(/modelProfiles\.impl\.authProfile references unknown authProfile "missing-auth"/);
  });

  it("rejects modelProfile with unknown provider", () => {
    expect(() =>
      validateConfig(
        {
          modelProfiles: {
            impl: {
              provider: "missing-provider",
              model: "o4-mini",
            },
          },
          projects: {
            proj1: {
              path: "/repos/test",
              repo: "org/test",
              defaultBranch: "main",
            },
          },
        },
        "/tmp/agent-orchestrator.yaml",
      ),
    ).toThrow(/modelProfiles\.impl\.provider references unknown provider "missing-provider"/);
  });

  it("rejects role with unknown authProfile", () => {
    expect(() =>
      validateConfig(
        {
          modelProfiles: {
            impl: {
              model: "o4-mini",
            },
          },
          roles: {
            implementer: {
              modelProfile: "impl",
              authProfile: "missing-auth",
            },
          },
          projects: {
            proj1: {
              path: "/repos/test",
              repo: "org/test",
              defaultBranch: "main",
            },
          },
        },
        "/tmp/agent-orchestrator.yaml",
      ),
    ).toThrow(/roles\.implementer\.authProfile references unknown authProfile "missing-auth"/);
  });

  it("rejects role with unknown provider", () => {
    expect(() =>
      validateConfig(
        {
          modelProfiles: {
            impl: {
              model: "o4-mini",
            },
          },
          roles: {
            implementer: {
              modelProfile: "impl",
              provider: "missing-provider",
            },
          },
          projects: {
            proj1: {
              path: "/repos/test",
              repo: "org/test",
              defaultBranch: "main",
            },
          },
        },
        "/tmp/agent-orchestrator.yaml",
      ),
    ).toThrow(/roles\.implementer\.provider references unknown provider "missing-provider"/);
  });

  it("rejects role with unknown modelProfile", () => {
    expect(() =>
      validateConfig(
        {
          roles: {
            implementer: {
              modelProfile: "missing-model-profile",
            },
          },
          projects: {
            proj1: {
              path: "/repos/test",
              repo: "org/test",
              defaultBranch: "main",
            },
          },
        },
        "/tmp/agent-orchestrator.yaml",
      ),
    ).toThrow(
      /roles\.implementer\.modelProfile references unknown modelProfile "missing-model-profile"/,
    );
  });

  it("rejects project workflow key that does not exist", () => {
    expect(() =>
      validateConfig(
        {
          projects: {
            proj1: {
              path: "/repos/test",
              repo: "org/test",
              defaultBranch: "main",
              workflow: "missing-workflow",
            },
          },
        },
        "/tmp/agent-orchestrator.yaml",
      ),
    ).toThrow(/projects\.proj1\.workflow references unknown workflow "missing-workflow"/);
  });

  it("rejects provider kind outside supported registry (except custom)", () => {
    expect(() =>
      validateConfig(
        {
          providers: {
            foo: {
              kind: "fooai",
            },
          },
          projects: {
            proj1: {
              path: "/repos/test",
              repo: "org/test",
              defaultBranch: "main",
            },
          },
        },
        "/tmp/agent-orchestrator.yaml",
      ),
    ).toThrow(/providers\.foo\.kind "fooai" is not in supported provider registry/);
  });

  it("rejects model profile with model incompatible to provider", () => {
    expect(() =>
      validateConfig(
        {
          providers: {
            openai: { kind: "openai" },
          },
          authProfiles: {
            api: {
              type: "api-key",
              provider: "openai",
            },
          },
          modelProfiles: {
            bad: {
              provider: "openai",
              agent: "codex",
              authProfile: "api",
              model: "claude-sonnet-4-20250514",
            },
          },
          projects: {
            proj1: {
              path: "/repos/test",
              repo: "org/test",
              defaultBranch: "main",
            },
          },
        },
        "/tmp/agent-orchestrator.yaml",
      ),
    ).toThrow(/modelProfiles\.bad\.model .* not compatible with provider "openai"/);
  });

  it("includes config path in loadConfig validation errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-config-validation-"));
    const configPath = join(dir, "agent-orchestrator.yaml");

    writeFileSync(
      configPath,
      [
        "providers:",
        "  openai:",
        "    kind: openai",
        "authProfiles:",
        "  bad:",
        "    type: api-key",
        "    provider: missing-provider",
        "projects:",
        "  proj1:",
        "    repo: org/test",
        "    path: /repos/test",
      ].join("\n"),
      "utf-8",
    );

    try {
      expect(() => loadConfig(configPath)).toThrow(`Config validation failed at ${configPath}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
