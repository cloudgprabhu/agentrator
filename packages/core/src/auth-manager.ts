import type {
  AuthAdapterContext,
  AuthHealthCheckOptions,
  AuthHealthCheckResult,
  AuthManager,
  AuthProfileInspectionResult,
  AuthProfileConfig,
  AuthProviderAdapter,
  AuthStatusResult,
  OrchestratorConfig,
} from "./types.js";
import { resolveAuthProfile } from "./auth-profile-resolver.js";
import { createAnthropicClaudeBrowserAuthAdapter } from "./auth-adapters/anthropic-claude-browser.js";
import { createOpenAICodexBrowserAuthAdapter } from "./auth-adapters/openai-codex-browser.js";
import {
  createAnthropicApiKeyAuthAdapter,
  createAWSBedrockProfileAuthAdapter,
  createConsoleAuthHookAdapter,
  createOpenAIApiKeyAuthAdapter,
} from "./auth-adapters/non-browser-auth.js";

export interface AuthManagerDeps {
  config: OrchestratorConfig;
  adapters?: AuthProviderAdapter[];
  defaultAdapters?: AuthProviderAdapter[];
}

function defaultAuthStatusForProfile(profile: AuthProfileConfig): AuthStatusResult {
  if (profile.type === "browser-account") {
    return {
      status: "not_authenticated",
      message: "Browser account auth requires provider adapter support",
    };
  }
  if (profile.type === "api-key") {
    return hasReference(profile)
      ? { status: "authenticated", message: "API key reference configured" }
      : { status: "not_authenticated", message: "API key reference is not configured" };
  }
  if (profile.type === "aws-profile") {
    return hasReference(profile)
      ? { status: "authenticated", message: "AWS profile reference configured" }
      : { status: "not_authenticated", message: "AWS profile reference is not configured" };
  }
  return { status: "authenticated", message: "Console auth uses interactive runtime context" };
}

function buildProfileContext(config: OrchestratorConfig, profileKey: string): AuthAdapterContext {
  const resolved = resolveAuthProfile(config, profileKey);
  return {
    profileKey,
    profile: resolved.profile,
    providerKey: resolved.providerKey,
    provider: resolved.provider,
  };
}

function hasReference(profile: AuthProfileConfig): boolean {
  return Boolean(profile.credentialEnvVar || profile.credentialRef);
}

function baseCheck(
  key: string,
  status: "pass" | "warn" | "fail",
  detail: string,
): AuthHealthCheckResult["checks"][number] {
  return { key, status, detail };
}

function defaultHealth(context: AuthAdapterContext): AuthHealthCheckResult {
  const profile = context.profile;
  const checks: AuthHealthCheckResult["checks"] = [];

  if (context.providerKey && !context.provider) {
    checks.push(
      baseCheck(
        "provider-reference",
        "fail",
        `Unknown provider ${context.providerKey} referenced by auth profile`,
      ),
    );
  } else if (context.providerKey) {
    checks.push(
      baseCheck("provider-reference", "pass", `Provider ${context.providerKey} resolved`),
    );
  } else {
    checks.push(baseCheck("provider-reference", "warn", "No provider bound to auth profile"));
  }

  if (profile.type === "api-key") {
    checks.push(
      hasReference(profile)
        ? baseCheck("credential-reference", "pass", "Credential reference configured")
        : baseCheck(
            "credential-reference",
            "fail",
            "api-key profiles require credentialRef or credentialEnvVar",
          ),
    );
  }

  if (profile.type === "aws-profile") {
    const options = profile.options;
    const hasAwsProfileRef =
      !!options && typeof options === "object" && typeof options["profileRef"] === "string";
    checks.push(
      hasReference(profile) || hasAwsProfileRef
        ? baseCheck("aws-profile-reference", "pass", "AWS profile reference configured")
        : baseCheck(
            "aws-profile-reference",
            "warn",
            "aws-profile should provide credentialRef, credentialEnvVar, or options.profileRef",
          ),
    );
  }

  if (profile.type === "browser-account") {
    const browserAuth = context.provider?.capabilities?.browserAuth;
    if (browserAuth === false) {
      checks.push(
        baseCheck(
          "provider-capability",
          "warn",
          `Provider ${context.providerKey ?? "<unknown>"} does not declare browserAuth capability`,
        ),
      );
    } else {
      checks.push(baseCheck("provider-capability", "pass", "Browser account mode supported"));
    }
  }

  if (profile.type === "console") {
    checks.push(
      baseCheck("console-mode", "pass", "Console auth requires runtime user interaction"),
    );
  }

  const hasFail = checks.some((check) => check.status === "fail");
  const hasWarn = checks.some((check) => check.status === "warn");

  if (hasFail) {
    return {
      state: "invalid",
      message: `Auth profile ${context.profileKey} has invalid configuration`,
      checks,
    };
  }
  if (hasWarn) {
    return {
      state: "degraded",
      message: `Auth profile ${context.profileKey} has warnings`,
      checks,
    };
  }
  return {
    state: "healthy",
    message: `Auth profile ${context.profileKey} is healthy`,
    checks,
  };
}

function pickAdapter(
  adapters: AuthProviderAdapter[],
  context: AuthAdapterContext,
): AuthProviderAdapter | undefined {
  return adapters.find((adapter) => adapter.supports(context));
}

function withLiveValidationFallback(
  context: AuthAdapterContext,
  health: AuthHealthCheckResult,
): AuthHealthCheckResult {
  const checks = [
    ...health.checks,
    {
      key: "live-validation",
      status: "warn" as const,
      detail: `Live validation is not available for auth profile type ${context.profile.type}`,
    },
  ];

  return {
    ...health,
    state: health.state === "healthy" ? "degraded" : health.state,
    message:
      health.state === "healthy"
        ? `Live validation is not available for auth profile ${context.profileKey}`
        : health.message,
    checks,
  };
}

export function createAuthManager(deps: AuthManagerDeps): AuthManager {
  const { config, adapters = [], defaultAdapters } = deps;
  const adapterList: AuthProviderAdapter[] = [
    ...(defaultAdapters ?? [
      createAnthropicClaudeBrowserAuthAdapter(),
      createOpenAICodexBrowserAuthAdapter(),
      createOpenAIApiKeyAuthAdapter(),
      createAnthropicApiKeyAuthAdapter(),
      createAWSBedrockProfileAuthAdapter(),
      createConsoleAuthHookAdapter(),
    ]),
    ...adapters,
  ];

  async function getStatusForContext(
    context: AuthAdapterContext,
    adapter?: AuthProviderAdapter,
  ): Promise<AuthStatusResult> {
    if (adapter?.getStatus) {
      return adapter.getStatus(context);
    }
    return defaultAuthStatusForProfile(context.profile);
  }

  async function getHealthForContext(
    context: AuthAdapterContext,
    adapter: AuthProviderAdapter | undefined,
    options?: AuthHealthCheckOptions,
    statusResult?: Promise<AuthStatusResult> | AuthStatusResult,
  ): Promise<AuthHealthCheckResult> {
    if (options?.live) {
      if (adapter?.validateLive) {
        return adapter.validateLive(context);
      }
      const baseline = adapter ? await adapter.checkHealth(context) : defaultHealth(context);
      return withLiveValidationFallback(context, baseline);
    }

    if (adapter) {
      return adapter.checkHealth(context);
    }

    const health = defaultHealth(context);
    const status =
      statusResult === undefined ? await getStatusForContext(context, adapter) : await statusResult;
    return { ...health, authStatus: status.status };
  }

  async function inspectProfile(
    profileKey: string,
    options?: AuthHealthCheckOptions,
  ): Promise<AuthProfileInspectionResult> {
    const context = buildProfileContext(config, profileKey);
    const adapter = pickAdapter(adapterList, context);
    const status = getStatusForContext(context, adapter);
    const health = getHealthForContext(context, adapter, options, status);
    const [resolvedStatus, resolvedHealth] = await Promise.all([status, health]);

    return {
      status: resolvedStatus,
      health: resolvedHealth,
    };
  }

  return {
    resolveProfile(profileKey: string) {
      return resolveAuthProfile(config, profileKey);
    },

    async inspectProfile(
      profileKey: string,
      options?: AuthHealthCheckOptions,
    ): Promise<AuthProfileInspectionResult> {
      return inspectProfile(profileKey, options);
    },

    async inspectAllProfiles(
      options?: AuthHealthCheckOptions,
    ): Promise<Record<string, AuthProfileInspectionResult>> {
      const entries = await Promise.all(
        Object.keys(config.authProfiles ?? {}).map(
          async (key) => [key, await inspectProfile(key, options)] as const,
        ),
      );
      return Object.fromEntries(entries);
    },

    async getProfileStatus(profileKey: string): Promise<AuthStatusResult> {
      const context = buildProfileContext(config, profileKey);
      const adapter = pickAdapter(adapterList, context);
      return getStatusForContext(context, adapter);
    },

    async loginProfile(profileKey: string): Promise<AuthStatusResult> {
      const context = buildProfileContext(config, profileKey);
      const adapter = pickAdapter(adapterList, context);
      if (adapter?.login) {
        return adapter.login(context);
      }
      return {
        status: "unsupported_environment",
        message: `Auth login is not supported for profile type ${context.profile.type}`,
      };
    },

    async logoutProfile(profileKey: string): Promise<AuthStatusResult> {
      const context = buildProfileContext(config, profileKey);
      const adapter = pickAdapter(adapterList, context);
      if (adapter?.logout) {
        return adapter.logout(context);
      }
      return {
        status: "unsupported_environment",
        message: `Auth logout is not supported for profile type ${context.profile.type}`,
      };
    },

    async checkProfileHealth(
      profileKey: string,
      options?: AuthHealthCheckOptions,
    ): Promise<AuthHealthCheckResult> {
      const context = buildProfileContext(config, profileKey);
      const adapter = pickAdapter(adapterList, context);
      return getHealthForContext(context, adapter, options);
    },

    async checkAllProfilesHealth(
      options?: AuthHealthCheckOptions,
    ): Promise<Record<string, AuthHealthCheckResult>> {
      const entries = await Promise.all(
        Object.keys(config.authProfiles ?? {}).map(
          async (key) => [key, await this.checkProfileHealth(key, options)] as const,
        ),
      );
      return Object.fromEntries(entries);
    },
  };
}
