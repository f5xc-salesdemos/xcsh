import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { AuthCredentialStore } from "../src/auth-storage";
import { findAnthropicAuth } from "../src/utils/anthropic-auth";

const NEUTRALIZED_ENV: Record<string, string | undefined> = {
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_BASE_URL: undefined,
	ANTHROPIC_SEARCH_API_KEY: undefined,
	ANTHROPIC_SEARCH_BASE_URL: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
	ANTHROPIC_FOUNDRY_API_KEY: undefined,
	CLAUDE_CODE_USE_FOUNDRY: undefined,
	LITELLM_BASE_URL: undefined,
	LITELLM_API_KEY: undefined,
};

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

function stubModelsYml(content: string | null): void {
	const originalReadFileSync = fs.readFileSync.bind(fs);
	vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
		if (typeof args[0] === "string" && args[0].endsWith("models.yml")) {
			if (content === null) {
				const err = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
				throw err;
			}
			return content;
		}
		return originalReadFileSync(...args);
	}) as typeof fs.readFileSync);
}

beforeEach(() => {
	vi.spyOn(AuthCredentialStore, "open").mockResolvedValue({
		getApiKey: () => undefined,
		listAuthCredentials: () => [],
		replaceAuthCredentialsForProvider: () => {},
		close: () => {},
	} as unknown as AuthCredentialStore);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("findAnthropicAuth tier 6 — models.yml contract", () => {
	it("resolves credentials when models.yml has a literal quoted apiKey", async () => {
		stubModelsYml(
			[
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				'    apiKey: "sk-literal-test-123"',
			].join("\n"),
		);
		await withEnv(NEUTRALIZED_ENV, async () => {
			const auth = await findAnthropicAuth();
			expect(auth).not.toBeNull();
			expect(auth?.apiKey).toBe("sk-literal-test-123");
			expect(auth?.baseUrl).toBe("https://proxy.example.com/anthropic");
			expect(auth?.isOAuth).toBe(false);
		});
	});

	it("resolves credentials via env-var reference when the referenced env var is set", async () => {
		stubModelsYml(
			[
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
			].join("\n"),
		);
		await withEnv({ ...NEUTRALIZED_ENV, LITELLM_API_KEY: "sk-env-resolved-456" }, async () => {
			const auth = await findAnthropicAuth();
			expect(auth).not.toBeNull();
			expect(auth?.apiKey).toBe("sk-env-resolved-456");
			expect(auth?.baseUrl).toBe("https://proxy.example.com/anthropic");
		});
	});

	it("falls through to tier 7 when env-var referenced by apiKey is unset", async () => {
		stubModelsYml(
			[
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: UNDEFINED_ENV_VAR_XYZ",
			].join("\n"),
		);
		await withEnv(
			{
				...NEUTRALIZED_ENV,
				LITELLM_BASE_URL: "https://proxy.example.com",
				LITELLM_API_KEY: "sk-tier7-fallback",
			},
			async () => {
				const auth = await findAnthropicAuth();
				expect(auth?.apiKey).toBe("sk-tier7-fallback");
			},
		);
	});

	it("skips shell-secret apiKey (tier 6 returns null)", async () => {
		stubModelsYml(
			[
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: !shellSecret get-key",
			].join("\n"),
		);
		await withEnv(NEUTRALIZED_ENV, async () => {
			const auth = await findAnthropicAuth();
			expect(auth).toBeNull();
		});
	});

	it("returns null when the anthropic provider block is absent", async () => {
		stubModelsYml(
			["providers:", "  openai:", '    baseUrl: "https://openai.example.com"', '    apiKey: "sk-openai"'].join("\n"),
		);
		await withEnv(NEUTRALIZED_ENV, async () => {
			const auth = await findAnthropicAuth();
			expect(auth).toBeNull();
		});
	});

	it("returns null when models.yml does not exist and does not throw", async () => {
		stubModelsYml(null);
		await withEnv(NEUTRALIZED_ENV, async () => {
			const auth = await findAnthropicAuth();
			expect(auth).toBeNull();
		});
	});

	it("returns null on malformed YAML without throwing", async () => {
		stubModelsYml("::: not valid yaml {[broken");
		await withEnv(NEUTRALIZED_ENV, async () => {
			const auth = await findAnthropicAuth();
			expect(auth).toBeNull();
		});
	});

	it("returns null when anthropic block has baseUrl but no apiKey", async () => {
		stubModelsYml(["providers:", "  anthropic:", '    baseUrl: "https://proxy.example.com/anthropic"'].join("\n"));
		await withEnv(NEUTRALIZED_ENV, async () => {
			const auth = await findAnthropicAuth();
			expect(auth).toBeNull();
		});
	});

	it("returns null when anthropic block has apiKey but no baseUrl", async () => {
		stubModelsYml(["providers:", "  anthropic:", '    apiKey: "sk-test"'].join("\n"));
		await withEnv(NEUTRALIZED_ENV, async () => {
			const auth = await findAnthropicAuth();
			expect(auth).toBeNull();
		});
	});

	it("tier 6 wins over tier 7 when both are available", async () => {
		stubModelsYml(
			[
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://primary.example.com/anthropic"',
				'    apiKey: "sk-models-yml-wins"',
			].join("\n"),
		);
		await withEnv(
			{
				...NEUTRALIZED_ENV,
				LITELLM_BASE_URL: "https://secondary.example.com",
				LITELLM_API_KEY: "sk-tier7-loses",
			},
			async () => {
				const auth = await findAnthropicAuth();
				expect(auth?.apiKey).toBe("sk-models-yml-wins");
				expect(auth?.baseUrl).toBe("https://primary.example.com/anthropic");
			},
		);
	});

	it("full-chain integration: only models.yml has credentials, no env, no DB", async () => {
		stubModelsYml(
			[
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				'    apiKey: "sk-only-models-yml"',
			].join("\n"),
		);
		await withEnv(NEUTRALIZED_ENV, async () => {
			const auth = await findAnthropicAuth();
			expect(auth).not.toBeNull();
			expect(auth?.apiKey).toBe("sk-only-models-yml");
			expect(auth?.baseUrl).toBe("https://proxy.example.com/anthropic");
			expect(auth?.isOAuth).toBe(false);
		});
	});
});
