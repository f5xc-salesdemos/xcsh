import { afterEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@f5xc-salesdemos/pi-utils";
import { runSearchQuery } from "../../src/web/search/index";
import { getSearchProvider, resolveProviderChain, SEARCH_PROVIDER_ORDER } from "../../src/web/search/provider";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("resolveProviderChain resilience", () => {
	it("continues checking providers when one isAvailable() rejects", async () => {
		// Make the anthropic provider throw
		const anthropicProvider = getSearchProvider("anthropic");
		vi.spyOn(anthropicProvider, "isAvailable").mockImplementation(() => Promise.reject(new Error("DB crash")));

		// The chain should still resolve (other providers may or may not be available,
		// but the function should not reject)
		const providers = await resolveProviderChain();
		// Should be an array, not a rejection
		expect(Array.isArray(providers)).toBe(true);
	});

	it("returns empty array (not rejection) when all providers throw from isAvailable()", async () => {
		// Mock every provider to throw
		for (const id of SEARCH_PROVIDER_ORDER) {
			const provider = getSearchProvider(id);
			vi.spyOn(provider, "isAvailable").mockImplementation(() => Promise.reject(new Error(`${id} crashed`)));
		}

		const providers = await resolveProviderChain();
		expect(providers).toEqual([]);
	});

	it("includes providers after a throwing provider", async () => {
		// Make all providers unavailable except synthetic (which we'll make available)
		for (const id of SEARCH_PROVIDER_ORDER) {
			const provider = getSearchProvider(id);
			if (id === "synthetic") {
				vi.spyOn(provider, "isAvailable").mockImplementation(() => true);
			} else if (id === "anthropic") {
				vi.spyOn(provider, "isAvailable").mockImplementation(() => Promise.reject(new Error("anthropic crashed")));
			} else {
				vi.spyOn(provider, "isAvailable").mockImplementation(() => false);
			}
		}

		const providers = await resolveProviderChain();
		expect(providers.length).toBe(1);
		expect(providers[0]!.id).toBe("synthetic");
	});

	it("handles preferred provider throwing gracefully", async () => {
		const anthropicProvider = getSearchProvider("anthropic");
		vi.spyOn(anthropicProvider, "isAvailable").mockImplementation(() =>
			Promise.reject(new Error("anthropic crashed")),
		);

		// Should not reject even when the preferred provider throws
		const providers = await resolveProviderChain("anthropic");
		expect(Array.isArray(providers)).toBe(true);
	});
});

describe("domain filter provider routing", () => {
	const originalSearchApiKey = process.env.ANTHROPIC_SEARCH_API_KEY;
	const originalSearchBaseUrl = process.env.ANTHROPIC_SEARCH_BASE_URL;
	const originalApiKey = process.env.ANTHROPIC_API_KEY;
	const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

	afterEach(() => {
		if (originalSearchApiKey === undefined) delete process.env.ANTHROPIC_SEARCH_API_KEY;
		else process.env.ANTHROPIC_SEARCH_API_KEY = originalSearchApiKey;
		if (originalSearchBaseUrl === undefined) delete process.env.ANTHROPIC_SEARCH_BASE_URL;
		else process.env.ANTHROPIC_SEARCH_BASE_URL = originalSearchBaseUrl;
		if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = originalApiKey;
		if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
		else process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
	});

	it("routes to anthropic when allowed_domains is set and provider is auto", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		process.env.ANTHROPIC_SEARCH_BASE_URL = "https://api.anthropic.com";
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_BASE_URL;

		let capturedUrl = "";
		using _hook = hookFetch((url, init) => {
			capturedUrl = typeof url === "string" ? url : url.toString();
			return new Response(
				JSON.stringify({
					id: "msg_test",
					model: "claude-haiku-4-5",
					content: [{ type: "text", text: "Test" }],
					usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const result = await runSearchQuery({
			query: "test",
			allowed_domains: ["example.com"],
		});

		expect(capturedUrl).toContain("api.anthropic.com");
		expect(result.details.response.provider).toBe("anthropic");
	});

	it("routes to anthropic when blocked_domains is set and provider is auto", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		process.env.ANTHROPIC_SEARCH_BASE_URL = "https://api.anthropic.com";
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_BASE_URL;

		let capturedUrl = "";
		using _hook = hookFetch((url, init) => {
			capturedUrl = typeof url === "string" ? url : url.toString();
			return new Response(
				JSON.stringify({
					id: "msg_test",
					model: "claude-haiku-4-5",
					content: [{ type: "text", text: "Test" }],
					usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const result = await runSearchQuery({
			query: "test",
			blocked_domains: ["spam.com"],
		});

		expect(capturedUrl).toContain("api.anthropic.com");
		expect(result.details.response.provider).toBe("anthropic");
	});
});
