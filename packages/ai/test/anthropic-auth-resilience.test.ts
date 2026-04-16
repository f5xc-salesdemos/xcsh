import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthCredentialStore } from "../src/auth-storage";
import { findAnthropicAuth } from "../src/utils/anthropic-auth";

async function withEnv(overrides: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
	const previous = new Map<string, string | undefined>();
	for (const key of Object.keys(overrides)) {
		previous.set(key, Bun.env[key]);
	}
	try {
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
		await fn();
	} finally {
		for (const [key, value] of previous.entries()) {
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("findAnthropicAuth resilience", () => {
	it("falls back to ANTHROPIC_API_KEY when AuthCredentialStore.open throws", async () => {
		vi.spyOn(AuthCredentialStore, "open").mockRejectedValue(new Error("DB corrupted"));

		await withEnv(
			{
				ANTHROPIC_API_KEY: "sk-ant-fallback-key",
				ANTHROPIC_BASE_URL: "https://api.anthropic.com",
				ANTHROPIC_SEARCH_API_KEY: undefined,
				ANTHROPIC_SEARCH_BASE_URL: undefined,
				ANTHROPIC_OAUTH_TOKEN: undefined,
				ANTHROPIC_FOUNDRY_API_KEY: undefined,
				CLAUDE_CODE_USE_FOUNDRY: undefined,
			},
			async () => {
				const auth = await findAnthropicAuth();
				expect(auth).not.toBeNull();
				expect(auth?.apiKey).toBe("sk-ant-fallback-key");
				expect(auth?.baseUrl).toBe("https://api.anthropic.com");
			},
		);
	});

	it("falls back to litellm credentials when AuthCredentialStore.open throws and no ANTHROPIC_API_KEY", async () => {
		vi.spyOn(AuthCredentialStore, "open").mockRejectedValue(new Error("DB corrupted"));

		await withEnv(
			{
				ANTHROPIC_API_KEY: undefined,
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_SEARCH_API_KEY: undefined,
				ANTHROPIC_SEARCH_BASE_URL: undefined,
				ANTHROPIC_OAUTH_TOKEN: undefined,
				ANTHROPIC_FOUNDRY_API_KEY: undefined,
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				LITELLM_BASE_URL: "https://f5ai.pd.f5net.com",
				LITELLM_API_KEY: "sk-litellm-test-key",
			},
			async () => {
				const auth = await findAnthropicAuth();
				expect(auth).not.toBeNull();
				expect(auth?.apiKey).toBe("sk-litellm-test-key");
				expect(auth?.baseUrl).toBe("https://f5ai.pd.f5net.com/anthropic");
			},
		);
	});

	it("re-throws store error when no later auth tier can succeed", async () => {
		// If the DB is the only possible auth source and it fails, the error
		// should be surfaced so the user knows why auth isn't working.
		vi.spyOn(AuthCredentialStore, "open").mockRejectedValue(new Error("DB corrupted"));

		await withEnv(
			{
				ANTHROPIC_API_KEY: undefined,
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_SEARCH_API_KEY: undefined,
				ANTHROPIC_SEARCH_BASE_URL: undefined,
				ANTHROPIC_OAUTH_TOKEN: undefined,
				ANTHROPIC_FOUNDRY_API_KEY: undefined,
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				LITELLM_BASE_URL: undefined,
				LITELLM_API_KEY: undefined,
			},
			async () => {
				await expect(findAnthropicAuth()).rejects.toThrow("DB corrupted");
			},
		);
	});
});
