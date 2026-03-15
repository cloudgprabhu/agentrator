import { describe, expect, it } from "vitest";
import {
  getProviderByKind,
  isAgentCompatibleWithProvider,
  isModelCompatibleWithProvider,
  listSupportedProviders,
} from "../provider-registry.js";

describe("provider registry", () => {
  it("lists all supported providers", () => {
    const providers = listSupportedProviders();
    const kinds = providers.map((p) => p.kind);
    expect(kinds).toContain("anthropic");
    expect(kinds).toContain("openai");
    expect(kinds).toContain("bedrock");
  });

  it("returns capability metadata for provider kind", () => {
    const openai = getProviderByKind("openai");
    expect(openai?.displayName).toBe("OpenAI");
    expect(openai?.capabilities.browserAuth).toBe(true);
    expect(openai?.capabilities.supportedAuthProfileTypes).toContain("browser-account");
    expect(openai?.supportedExactModels).toContain("gpt-5");
    expect(openai?.supportedModelPrefixes).toContain("gpt-");
  });

  it("checks agent compatibility with providers", () => {
    expect(isAgentCompatibleWithProvider("anthropic", "claude-code")).toBe(true);
    expect(isAgentCompatibleWithProvider("anthropic", "codex")).toBe(false);
    expect(isAgentCompatibleWithProvider("custom-provider", "anything")).toBe(true);
  });

  it("checks model compatibility with providers", () => {
    expect(isModelCompatibleWithProvider("anthropic", "claude-sonnet-4-20250514")).toBe(true);
    expect(isModelCompatibleWithProvider("anthropic", "claude-3-7-sonnet")).toBe(true);
    expect(isModelCompatibleWithProvider("anthropic", "gpt-4.1")).toBe(false);

    expect(isModelCompatibleWithProvider("openai", "gpt-5")).toBe(true);
    expect(isModelCompatibleWithProvider("openai", "gpt-5-codex")).toBe(true);
    expect(isModelCompatibleWithProvider("openai", "o4-mini")).toBe(true);
    expect(isModelCompatibleWithProvider("openai", "codex-1")).toBe(true);
    expect(isModelCompatibleWithProvider("openai", "codex-mini-latest")).toBe(true);
    expect(isModelCompatibleWithProvider("openai", "ft:gpt-4o-mini:org:custom")).toBe(true);
    expect(isModelCompatibleWithProvider("openai", "claude-3-5-sonnet")).toBe(false);

    expect(isModelCompatibleWithProvider("bedrock", "amazon.nova-pro-v1:0")).toBe(true);
    expect(isModelCompatibleWithProvider("bedrock", "anthropic.claude-3-sonnet")).toBe(true);
    expect(isModelCompatibleWithProvider("bedrock", "arn:aws:bedrock:us-east-1:123456789012:foundation-model/anthropic.claude-3-7-sonnet")).toBe(true);
    expect(isModelCompatibleWithProvider("bedrock", "gpt-4.1")).toBe(false);

    expect(isModelCompatibleWithProvider("custom-provider", "anything-goes")).toBe(true);
  });

  it("returns copies of registry entries for safe UI consumption", () => {
    const providers = listSupportedProviders();
    providers[0]!.displayName = "Mutated";

    const freshAnthropic = getProviderByKind("anthropic");
    expect(freshAnthropic?.displayName).toBe("Anthropic");
  });
});
