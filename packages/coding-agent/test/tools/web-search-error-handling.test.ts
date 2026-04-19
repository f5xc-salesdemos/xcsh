import { describe, expect, it } from "bun:test";
import { parseWebSearchError } from "../../src/web/search/errors";
import { SearchProviderError } from "../../src/web/search/types";

describe("parseWebSearchError — Anthropic 400 field extraction", () => {
	it("extracts user_location.country from invalid_request_error", () => {
		const raw = {
			error: {
				type: "invalid_request_error",
				message: "tools.0.web_search_20250305.user_location.country: String should have at most 2 characters",
			},
		};
		const parsed = parseWebSearchError(raw);
		expect(parsed.field).toBe("user_location.country");
		expect(parsed.constraint).toContain("2 characters");
		expect(parsed.userMessage).toContain("ISO 3166-1 alpha-2");
		expect(parsed.userMessage.toLowerCase()).toContain("country");
	});

	it("extracts query field from a 400 on tools.0.web_search_20250305.query", () => {
		const raw = {
			error: {
				type: "invalid_request_error",
				message: "tools.0.web_search_20250305.query: String should not be empty",
			},
		};
		const parsed = parseWebSearchError(raw);
		expect(parsed.field).toBe("query");
		expect(parsed.userMessage.toLowerCase()).toContain("query");
	});

	it("extracts a nested field without forcing the ISO alpha-2 hint", () => {
		const raw = {
			error: {
				type: "invalid_request_error",
				message: "tools.0.web_search_20250305.user_location.timezone: invalid timezone",
			},
		};
		const parsed = parseWebSearchError(raw);
		expect(parsed.field).toBe("user_location.timezone");
		expect(parsed.userMessage).not.toContain("ISO 3166-1");
	});
});

describe("parseWebSearchError — LiteLLM fallback chain scrubbing", () => {
	it("strips `No fallback model group found for original model_group=...`", () => {
		const raw = {
			error: {
				message:
					"invalid_request_error\nNo fallback model group found for original model_group=claude-haiku-4-5-20251001. Fallbacks=[{'claude-haiku-4-5': ['claude-3-5-haiku-20241022']}]. Available Model Group Fallbacks=None",
			},
		};
		const parsed = parseWebSearchError(raw);
		expect(parsed.userMessage).not.toContain("fallback model group");
		expect(parsed.userMessage.toLowerCase()).not.toContain("claude-haiku");
		expect(parsed.userMessage).not.toContain("model_group");
		expect(parsed.userMessage).not.toContain("Fallbacks=");
	});

	it("strips LiteLLM chain noise while keeping the underlying field error", () => {
		const raw = {
			error: {
				message:
					"tools.0.web_search_20250305.user_location.country: String should have at most 2 characters\nNo fallback model group found for original model_group=claude-haiku-4-5",
			},
		};
		const parsed = parseWebSearchError(raw);
		expect(parsed.field).toBe("user_location.country");
		expect(parsed.userMessage).toContain("ISO 3166-1 alpha-2");
		expect(parsed.userMessage).not.toContain("fallback");
	});
});

describe("parseWebSearchError — generic + edge cases", () => {
	it("returns a non-empty generic message for an unparseable body", () => {
		const parsed = parseWebSearchError({ error: { message: "something broke" } });
		expect(parsed.userMessage.length).toBeGreaterThan(0);
		expect(parsed.field).toBeUndefined();
	});

	it("surfaces a transport-layer Error without a parsed field", () => {
		const err = new Error("ECONNREFUSED 127.0.0.1:443");
		const parsed = parseWebSearchError(err);
		expect(parsed.userMessage).toContain("ECONNREFUSED");
		expect(parsed.field).toBeUndefined();
	});

	it("accepts a JSON string body", () => {
		const rawText = JSON.stringify({
			error: {
				type: "invalid_request_error",
				message: "tools.0.web_search_20250305.query: must be non-empty",
			},
		});
		const parsed = parseWebSearchError(rawText);
		expect(parsed.field).toBe("query");
	});

	it("handles an empty body without throwing", () => {
		const parsed = parseWebSearchError("");
		expect(parsed.userMessage.length).toBeGreaterThan(0);
		expect(parsed.field).toBeUndefined();
	});
});

describe("parseWebSearchError — preserves existing auth branches", () => {
	it("surfaces 401 with authorization context", () => {
		const err = new SearchProviderError("anthropic", "Anthropic API error (401): unauthorized", 401);
		const parsed = parseWebSearchError(err);
		expect(parsed.status).toBe(401);
		expect(parsed.userMessage.toLowerCase()).toContain("auth");
	});

	it("surfaces 403 with authorization context", () => {
		const err = new SearchProviderError("anthropic", "Anthropic API error (403): forbidden", 403);
		const parsed = parseWebSearchError(err);
		expect(parsed.status).toBe(403);
		expect(parsed.userMessage.toLowerCase()).toContain("auth");
	});

	it("keeps 404 language intact for model-not-found", () => {
		const err = new SearchProviderError("anthropic", "Anthropic API error (404): model not found", 404);
		const parsed = parseWebSearchError(err);
		expect(parsed.status).toBe(404);
		expect(parsed.userMessage.toLowerCase()).toContain("404");
	});
});
