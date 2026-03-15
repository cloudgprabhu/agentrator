import { describe, expect, it } from "vitest";
import {
  createAnthropicApiKeyAuthAdapter,
  createAWSBedrockProfileAuthAdapter,
  createConsoleAuthHookAdapter,
  createOpenAIApiKeyAuthAdapter,
} from "../auth-adapters/non-browser-auth.js";
import type { AuthAdapterContext } from "../types.js";

function openAiApiContext(overrides: Partial<AuthAdapterContext> = {}): AuthAdapterContext {
  return {
    profileKey: "openai-api",
    profile: {
      type: "api-key",
      provider: "openai",
      credentialEnvVar: "OPENAI_API_KEY",
    },
    providerKey: "openai",
    provider: { kind: "openai" },
    ...overrides,
  };
}

function anthropicApiContext(overrides: Partial<AuthAdapterContext> = {}): AuthAdapterContext {
  return {
    profileKey: "anthropic-api",
    profile: {
      type: "api-key",
      provider: "anthropic",
      credentialEnvVar: "ANTHROPIC_API_KEY",
    },
    providerKey: "anthropic",
    provider: { kind: "anthropic" },
    ...overrides,
  };
}

function bedrockContext(overrides: Partial<AuthAdapterContext> = {}): AuthAdapterContext {
  return {
    profileKey: "bedrock",
    profile: {
      type: "aws-profile",
      provider: "bedrock",
      options: {
        profileRef: "dev-profile",
      },
    },
    providerKey: "bedrock",
    provider: { kind: "bedrock" },
    ...overrides,
  };
}

describe("non-browser auth adapters", () => {
  it("validates OpenAI API key environment reference", async () => {
    const adapter = createOpenAIApiKeyAuthAdapter({ OPENAI_API_KEY: "sk-ref" });
    const status = await adapter.getStatus!(openAiApiContext());

    expect(status.status).toBe("authenticated");
    expect(status.message).toContain("OPENAI_API_KEY");
  });

  it("returns not_authenticated when OpenAI key reference is missing", async () => {
    const adapter = createOpenAIApiKeyAuthAdapter({});
    const status = await adapter.getStatus!(openAiApiContext());

    expect(status.status).toBe("not_authenticated");
  });

  it("validates Anthropic API key environment reference", async () => {
    const adapter = createAnthropicApiKeyAuthAdapter({ ANTHROPIC_API_KEY: "ak-ref" });
    const status = await adapter.getStatus!(anthropicApiContext());

    expect(status.status).toBe("authenticated");
    expect(status.message).toContain("ANTHROPIC_API_KEY");
  });

  it("uses credentialRef without reading secrets", async () => {
    const adapter = createOpenAIApiKeyAuthAdapter({});
    const status = await adapter.getStatus!(
      openAiApiContext({
        profile: {
          type: "api-key",
          provider: "openai",
          credentialRef: "vault://team/openai",
        },
      }),
    );

    expect(status.status).toBe("authenticated");
    expect(status.message).toContain("external secret store");
  });

  it("performs live validation for env-backed OpenAI API keys", async () => {
    const adapter = createOpenAIApiKeyAuthAdapter(
      { OPENAI_API_KEY: "sk-ref" },
      async () => ({
        ok: true,
        status: 200,
        text: async () => "{}",
      }),
    );

    const health = await adapter.validateLive!(openAiApiContext());
    expect(health.state).toBe("healthy");
    expect(health.checks).toContainEqual(
      expect.objectContaining({
        key: "openai-live-validation",
        status: "pass",
      }),
    );
  });

  it("fails live validation when OpenAI rejects the configured env-backed key", async () => {
    const adapter = createOpenAIApiKeyAuthAdapter(
      { OPENAI_API_KEY: "sk-ref" },
      async () => ({
        ok: false,
        status: 401,
        text: async () => "{}",
      }),
    );

    const health = await adapter.validateLive!(openAiApiContext());
    expect(health.state).toBe("invalid");
    expect(health.authStatus).toBe("not_authenticated");
  });

  it("warns that live validation is unavailable for opaque external OpenAI credential refs", async () => {
    const adapter = createOpenAIApiKeyAuthAdapter({});
    const health = await adapter.validateLive!(
      openAiApiContext({
        profile: {
          type: "api-key",
          provider: "openai",
          credentialRef: "vault://team/openai",
        },
      }),
    );

    expect(health.state).toBe("degraded");
    expect(health.checks).toContainEqual(
      expect.objectContaining({
        key: "openai-live-validation",
        status: "warn",
      }),
    );
  });

  it("validates AWS profile from local files", async () => {
    const adapter = createAWSBedrockProfileAuthAdapter({
      exists: (path) => path.endsWith(".aws/credentials"),
      readFile: () => "[dev-profile]\naws_access_key_id = REDACTED\n",
      homeDir: "/tmp/fake-home",
    });

    const status = await adapter.getStatus!(bedrockContext());
    expect(status.status).toBe("authenticated");
    expect(status.message).toContain("dev-profile");
  });

  it("returns not_authenticated when AWS profile is missing", async () => {
    const adapter = createAWSBedrockProfileAuthAdapter({
      exists: () => true,
      readFile: () => "[other]\n",
      homeDir: "/tmp/fake-home",
    });

    const status = await adapter.getStatus!(bedrockContext());
    expect(status.status).toBe("not_authenticated");
  });

  it("accepts AWS static credential environment references without reading files", async () => {
    const adapter = createAWSBedrockProfileAuthAdapter({
      env: {
        AWS_ACCESS_KEY_ID: "AKIAREDACTED",
        AWS_SECRET_ACCESS_KEY: "secret-redacted",
      },
      exists: () => false,
      homeDir: "/tmp/fake-home",
    });

    const status = await adapter.getStatus!(bedrockContext());
    expect(status).toEqual({
      status: "authenticated",
      message: "AWS static credential env references are available",
    });
  });

  it("returns unavailable when AWS credential files cannot be read", async () => {
    const adapter = createAWSBedrockProfileAuthAdapter({
      exists: () => true,
      readFile: () => {
        throw new Error("permission denied");
      },
      homeDir: "/tmp/fake-home",
    });

    const status = await adapter.getStatus!(bedrockContext());
    expect(status).toEqual({
      status: "unavailable",
      message: "Unable to read AWS credential configuration",
    });
  });

  it("keeps api-key login and logout non-interactive", async () => {
    const adapter = createOpenAIApiKeyAuthAdapter({});

    await expect(adapter.login!(openAiApiContext())).resolves.toEqual({
      status: "unsupported_environment",
      message: "Auth login is not interactive for api-key; configure references instead",
    });
    await expect(adapter.logout!(openAiApiContext())).resolves.toEqual({
      status: "unsupported_environment",
      message: "Auth logout is not interactive for api-key; clear local credentials outside this tool",
    });
  });

  it("supports optional console auth hook", async () => {
    const adapter = createConsoleAuthHookAdapter({
      getStatus: async () => ({ status: "authenticated", message: "console hook ok" }),
    });

    const status = await adapter.getStatus!({
      profileKey: "console",
      profile: { type: "console" },
    });
    expect(status.status).toBe("authenticated");
    expect(status.message).toBe("console hook ok");
  });

  it("supports console hook login/logout overrides", async () => {
    const adapter = createConsoleAuthHookAdapter({
      login: async () => ({ status: "authenticated", message: "console login ok" }),
      logout: async () => ({ status: "not_authenticated", message: "console logout ok" }),
    });

    const context: AuthAdapterContext = {
      profileKey: "console",
      profile: { type: "console" },
    };

    await expect(adapter.login!(context)).resolves.toEqual({
      status: "authenticated",
      message: "console login ok",
    });
    await expect(adapter.logout!(context)).resolves.toEqual({
      status: "not_authenticated",
      message: "console logout ok",
    });
  });
});
