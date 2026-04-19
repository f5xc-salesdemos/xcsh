import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { AuthCredentialStore } from "../src/auth-storage";
import { buildAnthropicUrl, findAnthropicAuth } from "../src/utils/anthropic-auth";

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

beforeEach(() => {
	// Stub the credential store so tiers 3-4 never fire during these tests.
	// Without this, a developer with real Anthropic credentials in agent.db
	// would have tiers 3/4 win before the litellm tier (tier 7) is reached.
	vi.spyOn(AuthCredentialStore, "open").mockResolvedValue({
		getApiKey: () => undefined,
		listAuthCredentials: () => [],
		replaceAuthCredentialsForProvider: () => {},
		close: () => {},
	} as unknown as AuthCredentialStore);

	// Stub fs.readFileSync so tier 6 (models.yml) never fires during these tests.
	// Without this, a developer with real models.yml on disk would have tier 6
	// win before the litellm tier (tier 7) is reached.
	const originalReadFileSync = fs.readFileSync.bind(fs);
	// Cast is required because `mockImplementation` expects the overload union of
	// `fs.readFileSync`, which no single function signature can express.
	vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
		if (typeof args[0] === "string" && args[0].endsWith("models.yml")) {
			throw new Error("ENOENT: mocked for test isolation");
		}
		return originalReadFileSync(...args);
	}) as typeof fs.readFileSync);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("findAnthropicAuth litellm passthrough", () => {
	it("derives Anthropic auth from LITELLM_BASE_URL + LITELLM_API_KEY when no Anthropic credentials exist", async () => {
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
				expect(auth?.isOAuth).toBe(false);
				expect(buildAnthropicUrl(auth!)).toBe("https://f5ai.pd.f5net.com/anthropic/v1/messages?beta=true");
			},
		);
	});

	it("ANTHROPIC_API_KEY takes precedence over LITELLM_API_KEY", async () => {
		await withEnv(
			{
				ANTHROPIC_API_KEY: "sk-ant-direct-key",
				ANTHROPIC_BASE_URL: "https://api.anthropic.com",
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
				expect(auth?.apiKey).toBe("sk-ant-direct-key");
				expect(auth?.baseUrl).toBe("https://api.anthropic.com");
			},
		);
	});

	it("returns null when neither Anthropic nor litellm credentials exist", async () => {
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
				const auth = await findAnthropicAuth();
				expect(auth).toBeNull();
			},
		);
	});

	it("strips trailing slashes from LITELLM_BASE_URL before appending /anthropic", async () => {
		await withEnv(
			{
				ANTHROPIC_API_KEY: undefined,
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_SEARCH_API_KEY: undefined,
				ANTHROPIC_SEARCH_BASE_URL: undefined,
				ANTHROPIC_OAUTH_TOKEN: undefined,
				ANTHROPIC_FOUNDRY_API_KEY: undefined,
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				LITELLM_BASE_URL: "https://f5ai.pd.f5net.com/",
				LITELLM_API_KEY: "sk-litellm-test-key",
			},
			async () => {
				const auth = await findAnthropicAuth();
				expect(auth).not.toBeNull();
				expect(auth?.baseUrl).toBe("https://f5ai.pd.f5net.com/anthropic");
			},
		);
	});

	it("does not double-append /anthropic if LITELLM_BASE_URL already ends with /anthropic", async () => {
		await withEnv(
			{
				ANTHROPIC_API_KEY: undefined,
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_SEARCH_API_KEY: undefined,
				ANTHROPIC_SEARCH_BASE_URL: undefined,
				ANTHROPIC_OAUTH_TOKEN: undefined,
				ANTHROPIC_FOUNDRY_API_KEY: undefined,
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				LITELLM_BASE_URL: "https://f5ai.pd.f5net.com/anthropic",
				LITELLM_API_KEY: "sk-litellm-test-key",
			},
			async () => {
				const auth = await findAnthropicAuth();
				expect(auth).not.toBeNull();
				expect(auth?.baseUrl).toBe("https://f5ai.pd.f5net.com/anthropic");
			},
		);
	});

	it("strips an /api/v1 suffix before appending /anthropic", async () => {
		await withEnv(
			{
				ANTHROPIC_API_KEY: undefined,
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_SEARCH_API_KEY: undefined,
				ANTHROPIC_SEARCH_BASE_URL: undefined,
				ANTHROPIC_OAUTH_TOKEN: undefined,
				ANTHROPIC_FOUNDRY_API_KEY: undefined,
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				LITELLM_BASE_URL: "https://proxy.example.com/api/v1",
				LITELLM_API_KEY: "sk-litellm-test-key",
			},
			async () => {
				const auth = await findAnthropicAuth();
				expect(auth?.baseUrl).toBe("https://proxy.example.com/anthropic");
			},
		);
	});

	it("strips both /anthropic and /v1 suffixes regardless of order", async () => {
		await withEnv(
			{
				ANTHROPIC_API_KEY: undefined,
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_SEARCH_API_KEY: undefined,
				ANTHROPIC_SEARCH_BASE_URL: undefined,
				ANTHROPIC_OAUTH_TOKEN: undefined,
				ANTHROPIC_FOUNDRY_API_KEY: undefined,
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				LITELLM_BASE_URL: "https://proxy.example.com/anthropic/v1",
				LITELLM_API_KEY: "sk-litellm-test-key",
			},
			async () => {
				const auth = await findAnthropicAuth();
				expect(auth?.baseUrl).toBe("https://proxy.example.com/anthropic");
			},
		);
	});

	it("iteratively strips mixed /v1/anthropic/v1 suffixes until stable", async () => {
		await withEnv(
			{
				ANTHROPIC_API_KEY: undefined,
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_SEARCH_API_KEY: undefined,
				ANTHROPIC_SEARCH_BASE_URL: undefined,
				ANTHROPIC_OAUTH_TOKEN: undefined,
				ANTHROPIC_FOUNDRY_API_KEY: undefined,
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				LITELLM_BASE_URL: "https://proxy.example.com/v1/anthropic/v1",
				LITELLM_API_KEY: "sk-litellm-test-key",
			},
			async () => {
				const auth = await findAnthropicAuth();
				expect(auth?.baseUrl).toBe("https://proxy.example.com/anthropic");
			},
		);
	});

	it("requires both LITELLM_BASE_URL and LITELLM_API_KEY for litellm tier", async () => {
		// Only base URL, no key
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
				LITELLM_API_KEY: undefined,
			},
			async () => {
				const auth = await findAnthropicAuth();
				expect(auth).toBeNull();
			},
		);

		// Only key, no base URL
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
				LITELLM_API_KEY: "sk-litellm-test-key",
			},
			async () => {
				const auth = await findAnthropicAuth();
				expect(auth).toBeNull();
			},
		);
	});
});
