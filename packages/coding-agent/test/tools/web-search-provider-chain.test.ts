import { afterEach, describe, expect, it, vi } from "bun:test";
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
