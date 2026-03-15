import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  AuthAdapterContext,
  AuthHealthCheckResult,
  AuthProviderAdapter,
  AuthStatusResult,
} from "../types.js";

function normalize(value: string | undefined): string {
  return (value ?? "").trim();
}

function isOpenAI(context: AuthAdapterContext): boolean {
  const providerKey = context.providerKey?.toLowerCase();
  const providerKind = context.provider?.kind?.toLowerCase();
  return providerKey === "openai" || providerKind === "openai";
}

function isAnthropic(context: AuthAdapterContext): boolean {
  const providerKey = context.providerKey?.toLowerCase();
  const providerKind = context.provider?.kind?.toLowerCase();
  return providerKey === "anthropic" || providerKind === "anthropic";
}

function isBedrock(context: AuthAdapterContext): boolean {
  const providerKey = context.providerKey?.toLowerCase();
  const providerKind = context.provider?.kind?.toLowerCase();
  return providerKey === "bedrock" || providerKind === "bedrock" || providerKind === "aws";
}

function unsupportedLogin(type: string): AuthStatusResult {
  return {
    status: "unsupported_environment",
    message: `Auth login is not interactive for ${type}; configure references instead`,
  };
}

function unsupportedLogout(type: string): AuthStatusResult {
  return {
    status: "unsupported_environment",
    message: `Auth logout is not interactive for ${type}; clear local credentials outside this tool`,
  };
}

function healthFromStatus(
  key: string,
  status: AuthStatusResult,
  okKey: string,
): AuthHealthCheckResult {
  if (status.status === "authenticated") {
    return {
      state: "healthy",
      authStatus: status.status,
      message: status.message,
      checks: [{ key: okKey, status: "pass", detail: status.message }],
    };
  }
  return {
    state: "degraded",
    authStatus: status.status,
    message: `Auth profile ${key} is not ready`,
    checks: [{ key: okKey, status: "warn", detail: status.message }],
  };
}

type LiveValidationResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

type LiveValidationFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
  },
) => Promise<LiveValidationResponse>;

function externalRefLiveValidationWarning(
  profileKey: string,
  providerLabel: string,
): AuthHealthCheckResult {
  return {
    state: "degraded",
    authStatus: "authenticated",
    message: `Live validation is unavailable for external ${providerLabel} credential references`,
    checks: [
      {
        key: `${providerLabel}-live-validation`,
        status: "warn",
        detail: `AO cannot resolve opaque external ${providerLabel} credential references for live validation`,
      },
    ],
  };
}

function missingEnvLiveValidationFailure(
  envKey: string,
  providerLabel: string,
): AuthHealthCheckResult {
  return {
    state: "invalid",
    authStatus: "not_authenticated",
    message: `${providerLabel} API key reference ${envKey} is not set`,
    checks: [
      {
        key: `${providerLabel}-live-validation`,
        status: "fail",
        detail: `${providerLabel} API key reference ${envKey} is not set`,
      },
    ],
  };
}

async function validateApiKeyAgainstProvider(
  providerLabel: string,
  envKey: string,
  apiKey: string,
  fetcher: LiveValidationFetch,
  request: {
    url: string;
    headers: Record<string, string>;
  },
): Promise<AuthHealthCheckResult> {
  try {
    const response = await fetcher(request.url, {
      method: "GET",
      headers: request.headers,
    });

    if (response.ok) {
      return {
        state: "healthy",
        authStatus: "authenticated",
        message: `${providerLabel} API key reference ${envKey} was accepted by the provider`,
        checks: [
          {
            key: `${providerLabel}-live-validation`,
            status: "pass",
            detail: `${providerLabel} accepted the configured API key reference`,
          },
        ],
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        state: "invalid",
        authStatus: "not_authenticated",
        message: `${providerLabel} rejected the configured API key reference`,
        checks: [
          {
            key: `${providerLabel}-live-validation`,
            status: "fail",
            detail: `${providerLabel} returned HTTP ${response.status} during live validation`,
          },
        ],
      };
    }

    return {
      state: "degraded",
      authStatus: "unavailable",
      message: `${providerLabel} live validation is currently unavailable`,
      checks: [
        {
          key: `${providerLabel}-live-validation`,
          status: "warn",
          detail: `${providerLabel} returned HTTP ${response.status} during live validation`,
        },
      ],
    };
  } catch {
    return {
      state: "degraded",
      authStatus: "unavailable",
      message: `${providerLabel} live validation is currently unavailable`,
      checks: [
        {
          key: `${providerLabel}-live-validation`,
          status: "warn",
          detail: `Unable to reach ${providerLabel} for live validation`,
        },
      ],
    };
  }
}

export function createOpenAIApiKeyAuthAdapter(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: LiveValidationFetch = (input, init) =>
    fetch(input, init as RequestInit) as Promise<LiveValidationResponse>,
): AuthProviderAdapter {
  return {
    name: "openai-api-key",
    supports(context) {
      return context.profile.type === "api-key" && isOpenAI(context);
    },
    async getStatus(context): Promise<AuthStatusResult> {
      const envKey = normalize(context.profile.credentialEnvVar) || "OPENAI_API_KEY";
      if (normalize(env[envKey]).length > 0) {
        return {
          status: "authenticated",
          message: `OpenAI API key reference ${envKey} is available`,
        };
      }

      if (normalize(context.profile.credentialRef).length > 0) {
        return {
          status: "authenticated",
          message: "OpenAI credential reference is configured (external secret store)",
        };
      }

      return {
        status: "not_authenticated",
        message: `OpenAI API key reference ${envKey} is not set`,
      };
    },
    async checkHealth(context): Promise<AuthHealthCheckResult> {
      return healthFromStatus(context.profileKey, await this.getStatus!(context), "openai-api-key");
    },
    async validateLive(context): Promise<AuthHealthCheckResult> {
      const envKey = normalize(context.profile.credentialEnvVar) || "OPENAI_API_KEY";
      const apiKey = normalize(env[envKey]);
      if (apiKey.length > 0) {
        return validateApiKeyAgainstProvider("openai", envKey, apiKey, fetcher, {
          url: "https://api.openai.com/v1/models",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });
      }
      if (normalize(context.profile.credentialRef).length > 0) {
        return externalRefLiveValidationWarning(context.profileKey, "openai");
      }
      return missingEnvLiveValidationFailure(envKey, "OpenAI");
    },
    async login(): Promise<AuthStatusResult> {
      return unsupportedLogin("api-key");
    },
    async logout(): Promise<AuthStatusResult> {
      return unsupportedLogout("api-key");
    },
  };
}

export function createAnthropicApiKeyAuthAdapter(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: LiveValidationFetch = (input, init) =>
    fetch(input, init as RequestInit) as Promise<LiveValidationResponse>,
): AuthProviderAdapter {
  return {
    name: "anthropic-api-key",
    supports(context) {
      return context.profile.type === "api-key" && isAnthropic(context);
    },
    async getStatus(context): Promise<AuthStatusResult> {
      const envKey = normalize(context.profile.credentialEnvVar) || "ANTHROPIC_API_KEY";
      if (normalize(env[envKey]).length > 0) {
        return {
          status: "authenticated",
          message: `Anthropic API key reference ${envKey} is available`,
        };
      }

      if (normalize(context.profile.credentialRef).length > 0) {
        return {
          status: "authenticated",
          message: "Anthropic credential reference is configured (external secret store)",
        };
      }

      return {
        status: "not_authenticated",
        message: `Anthropic API key reference ${envKey} is not set`,
      };
    },
    async checkHealth(context): Promise<AuthHealthCheckResult> {
      return healthFromStatus(
        context.profileKey,
        await this.getStatus!(context),
        "anthropic-api-key",
      );
    },
    async validateLive(context): Promise<AuthHealthCheckResult> {
      const envKey = normalize(context.profile.credentialEnvVar) || "ANTHROPIC_API_KEY";
      const apiKey = normalize(env[envKey]);
      if (apiKey.length > 0) {
        return validateApiKeyAgainstProvider("anthropic", envKey, apiKey, fetcher, {
          url: "https://api.anthropic.com/v1/models",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
        });
      }
      if (normalize(context.profile.credentialRef).length > 0) {
        return externalRefLiveValidationWarning(context.profileKey, "anthropic");
      }
      return missingEnvLiveValidationFailure(envKey, "Anthropic");
    },
    async login(): Promise<AuthStatusResult> {
      return unsupportedLogin("api-key");
    },
    async logout(): Promise<AuthStatusResult> {
      return unsupportedLogout("api-key");
    },
  };
}

function profileExistsInFile(content: string, profileName: string, isConfigFile: boolean): boolean {
  const normalizedProfile = profileName.trim();
  if (!normalizedProfile) return false;
  const section =
    isConfigFile && normalizedProfile !== "default"
      ? `[profile ${normalizedProfile}]`
      : `[${normalizedProfile}]`;
  return content.includes(section);
}

export function createAWSBedrockProfileAuthAdapter(
  deps: {
    env?: NodeJS.ProcessEnv;
    readFile?: (path: string) => string;
    exists?: (path: string) => boolean;
    homeDir?: string;
  } = {},
): AuthProviderAdapter {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const exists = deps.exists ?? ((path: string) => existsSync(path));
  const homeDir = deps.homeDir ?? homedir();

  return {
    name: "aws-bedrock-profile",
    supports(context) {
      return context.profile.type === "aws-profile" && isBedrock(context);
    },
    async getStatus(context): Promise<AuthStatusResult> {
      const profileName =
        normalize(context.profile.options?.["profileRef"] as string | undefined) ||
        normalize(context.profile.credentialRef) ||
        normalize(
          context.profile.credentialEnvVar ? env[context.profile.credentialEnvVar] : undefined,
        ) ||
        normalize(env["AWS_PROFILE"]) ||
        normalize(env["AWS_DEFAULT_PROFILE"]) ||
        "default";

      const hasStaticEnvCreds =
        normalize(env["AWS_ACCESS_KEY_ID"]).length > 0 &&
        normalize(env["AWS_SECRET_ACCESS_KEY"]).length > 0;
      if (hasStaticEnvCreds) {
        return {
          status: "authenticated",
          message: "AWS static credential env references are available",
        };
      }

      const credentialsPath = join(homeDir, ".aws", "credentials");
      const configPath = join(homeDir, ".aws", "config");
      const hasCredentialsFile = exists(credentialsPath);
      const hasConfigFile = exists(configPath);

      if (!hasCredentialsFile && !hasConfigFile) {
        return {
          status: "not_authenticated",
          message: "AWS credentials/config files not found",
        };
      }

      try {
        const credentialsContent = hasCredentialsFile ? readFile(credentialsPath) : "";
        const configContent = hasConfigFile ? readFile(configPath) : "";

        const hasProfile =
          profileExistsInFile(credentialsContent, profileName, false) ||
          profileExistsInFile(configContent, profileName, true);

        if (hasProfile) {
          return {
            status: "authenticated",
            message: `AWS profile reference ${profileName} is available`,
          };
        }

        return {
          status: "not_authenticated",
          message: `AWS profile reference ${profileName} was not found`,
        };
      } catch {
        return {
          status: "unavailable",
          message: "Unable to read AWS credential configuration",
        };
      }
    },
    async checkHealth(context): Promise<AuthHealthCheckResult> {
      return healthFromStatus(
        context.profileKey,
        await this.getStatus!(context),
        "aws-bedrock-profile",
      );
    },
    async login(): Promise<AuthStatusResult> {
      return unsupportedLogin("aws-profile");
    },
    async logout(): Promise<AuthStatusResult> {
      return unsupportedLogout("aws-profile");
    },
  };
}

export function createConsoleAuthHookAdapter(
  hooks: {
    getStatus?: (context: AuthAdapterContext) => Promise<AuthStatusResult>;
    login?: (context: AuthAdapterContext) => Promise<AuthStatusResult>;
    logout?: (context: AuthAdapterContext) => Promise<AuthStatusResult>;
  } = {},
): AuthProviderAdapter {
  return {
    name: "console-auth-hook",
    supports(context) {
      return context.profile.type === "console";
    },
    async getStatus(context): Promise<AuthStatusResult> {
      if (hooks.getStatus) return hooks.getStatus(context);
      return {
        status: "authenticated",
        message: "Console auth hook is using interactive runtime authentication",
      };
    },
    async checkHealth(context): Promise<AuthHealthCheckResult> {
      return healthFromStatus(context.profileKey, await this.getStatus!(context), "console-auth");
    },
    async login(context): Promise<AuthStatusResult> {
      if (hooks.login) return hooks.login(context);
      return unsupportedLogin("console");
    },
    async logout(context): Promise<AuthStatusResult> {
      if (hooks.logout) return hooks.logout(context);
      return unsupportedLogout("console");
    },
  };
}
