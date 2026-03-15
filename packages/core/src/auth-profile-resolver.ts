import type { OrchestratorConfig, ResolvedAuthProfile } from "./types.js";

const RESTRICTED_INLINE_SECRET_KEYS = new Set([
  "token",
  "apiKey",
  "api_key",
  "secret",
  "secretKey",
  "secret_key",
  "password",
  "accessKeyId",
  "access_key_id",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function hasInlineSecretValues(profile: Record<string, unknown>): string[] {
  const hits: string[] = [];

  const walk = (value: unknown, path: string): void => {
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (
        RESTRICTED_INLINE_SECRET_KEYS.has(key) &&
        typeof child === "string" &&
        child.trim().length > 0
      ) {
        hits.push(nextPath);
      }
      walk(child, nextPath);
    }
  };

  walk(profile, "");
  return hits;
}

export function resolveAuthProfile(
  config: OrchestratorConfig,
  profileKey: string,
): ResolvedAuthProfile {
  const profile = config.authProfiles?.[profileKey];
  if (!profile) {
    throw new Error(`Unknown auth profile: ${profileKey}`);
  }

  const providerKey = profile.provider;
  const provider = providerKey ? config.providers?.[providerKey] : undefined;

  if (providerKey && !provider) {
    throw new Error(
      `authProfiles.${profileKey}.provider references unknown provider "${providerKey}"`,
    );
  }

  const inlineSecretPaths = hasInlineSecretValues(profile as unknown as Record<string, unknown>);
  if (inlineSecretPaths.length > 0) {
    throw new Error(
      `authProfiles.${profileKey} contains inline secret values at ${inlineSecretPaths.join(", ")}; use credentialRef/credentialEnvVar references instead`,
    );
  }

  return {
    key: profileKey,
    profile,
    providerKey,
    provider,
  };
}
