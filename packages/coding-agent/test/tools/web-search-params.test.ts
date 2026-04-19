import { describe, expect, it } from "bun:test";
import { normalizeUserLocation, validateWebSearchParams, type WebSearchParams } from "../../src/web/search/params";

function expectValid(params: WebSearchParams): void {
	const result = validateWebSearchParams(params);
	if (!result.valid) {
		throw new Error(`Expected valid params, got error: ${result.error}`);
	}
	expect(result.valid).toBe(true);
}

function expectInvalid(params: WebSearchParams, errorSubstring: string): void {
	const result = validateWebSearchParams(params);
	expect(result.valid).toBe(false);
	if (result.valid) return;
	expect(result.error.toLowerCase()).toContain(errorSubstring.toLowerCase());
}

describe("validateWebSearchParams — query", () => {
	it("accepts a non-empty query", () => {
		expectValid({ query: "hello" });
	});

	it("accepts a single-character query", () => {
		expectValid({ query: "h" });
	});

	it("rejects an empty query", () => {
		expectInvalid({ query: "" }, "query");
	});

	it("rejects a whitespace-only query", () => {
		expectInvalid({ query: "   \t\n" }, "query");
	});
});

describe("validateWebSearchParams — recency", () => {
	it.each(["day", "week", "month", "year"] as const)("accepts recency=%s", recency => {
		expectValid({ query: "test", recency });
	});

	it("rejects an unknown recency value", () => {
		expectInvalid({ query: "test", recency: "hour" as unknown as WebSearchParams["recency"] }, "recency");
	});

	it("rejects an empty recency string", () => {
		expectInvalid({ query: "test", recency: "" as unknown as WebSearchParams["recency"] }, "recency");
	});
});

describe("validateWebSearchParams — num_search_results", () => {
	it("accepts positive integers", () => {
		expectValid({ query: "test", num_search_results: 5 });
	});

	it("accepts large positive integers (no artificial cap)", () => {
		expectValid({ query: "test", num_search_results: 1000 });
	});

	it("rejects zero", () => {
		expectInvalid({ query: "test", num_search_results: 0 }, "num_search_results");
	});

	it("rejects negative values", () => {
		expectInvalid({ query: "test", num_search_results: -1 }, "num_search_results");
	});

	it("rejects non-integer values", () => {
		expectInvalid({ query: "test", num_search_results: 3.5 }, "num_search_results");
	});
});

describe("validateWebSearchParams — limit", () => {
	it("accepts positive integers", () => {
		expectValid({ query: "test", limit: 3 });
	});

	it("rejects zero", () => {
		expectInvalid({ query: "test", limit: 0 }, "limit");
	});

	it("rejects negative values", () => {
		expectInvalid({ query: "test", limit: -5 }, "limit");
	});

	it("rejects non-integer values", () => {
		expectInvalid({ query: "test", limit: 2.5 }, "limit");
	});
});

describe("validateWebSearchParams — max_tokens", () => {
	it("accepts positive integers", () => {
		expectValid({ query: "test", max_tokens: 200 });
	});

	it("rejects zero", () => {
		expectInvalid({ query: "test", max_tokens: 0 }, "max_tokens");
	});

	it("rejects negative values", () => {
		expectInvalid({ query: "test", max_tokens: -10 }, "max_tokens");
	});
});

describe("validateWebSearchParams — temperature", () => {
	it.each([0, 0.5, 1, 1.5, 2])("accepts temperature=%s", temperature => {
		expectValid({ query: "test", temperature });
	});

	it("rejects negative temperature", () => {
		expectInvalid({ query: "test", temperature: -0.1 }, "temperature");
	});

	it("rejects temperature above 2", () => {
		expectInvalid({ query: "test", temperature: 2.1 }, "temperature");
	});
});

describe("validateWebSearchParams — max_uses", () => {
	it("accepts positive integers", () => {
		expectValid({ query: "test", max_uses: 3 });
	});

	it("rejects zero", () => {
		expectInvalid({ query: "test", max_uses: 0 }, "max_uses");
	});

	it("rejects negative values", () => {
		expectInvalid({ query: "test", max_uses: -2 }, "max_uses");
	});
});

describe("validateWebSearchParams — allowed_domains / blocked_domains", () => {
	it("accepts an empty allowed_domains array", () => {
		expectValid({ query: "test", allowed_domains: [] });
	});

	it("accepts an array of non-empty domain strings", () => {
		expectValid({ query: "test", allowed_domains: ["anthropic.com", "docs.anthropic.com"] });
	});

	it("rejects allowed_domains containing an empty string", () => {
		expectInvalid({ query: "test", allowed_domains: ["anthropic.com", ""] }, "allowed_domains");
	});

	it("accepts an empty blocked_domains array", () => {
		expectValid({ query: "test", blocked_domains: [] });
	});

	it("rejects blocked_domains containing whitespace-only string", () => {
		expectInvalid({ query: "test", blocked_domains: ["  "] }, "blocked_domains");
	});
});

describe("validateWebSearchParams — user_location.country", () => {
	it("accepts an ISO 3166-1 alpha-2 uppercase code", () => {
		expectValid({
			query: "test",
			user_location: { type: "approximate", country: "JP" },
		});
	});

	it("accepts an ISO 3166-1 alpha-2 lowercase code (will be normalized)", () => {
		expectValid({
			query: "test",
			user_location: { type: "approximate", country: "jp" },
		});
	});

	it("rejects a full country name", () => {
		expectInvalid({ query: "test", user_location: { type: "approximate", country: "Japan" } }, "ISO 3166-1 alpha-2");
	});

	it("rejects a single-character country code", () => {
		expectInvalid({ query: "test", user_location: { type: "approximate", country: "J" } }, "ISO 3166-1 alpha-2");
	});

	it("rejects an empty country string", () => {
		expectInvalid({ query: "test", user_location: { type: "approximate", country: "" } }, "ISO 3166-1 alpha-2");
	});

	it("accepts user_location without country (optional)", () => {
		expectValid({
			query: "test",
			user_location: { type: "approximate", city: "Tokyo" },
		});
	});
});

describe("validateWebSearchParams — user_location fields", () => {
	it("accepts a non-empty city", () => {
		expectValid({
			query: "test",
			user_location: { type: "approximate", city: "Tokyo" },
		});
	});

	it("rejects an empty city", () => {
		expectInvalid({ query: "test", user_location: { type: "approximate", city: "" } }, "city");
	});

	it("accepts a non-empty region", () => {
		expectValid({
			query: "test",
			user_location: { type: "approximate", region: "Tokyo" },
		});
	});

	it("rejects an empty region", () => {
		expectInvalid({ query: "test", user_location: { type: "approximate", region: "" } }, "region");
	});

	it("accepts an IANA-style timezone", () => {
		expectValid({
			query: "test",
			user_location: { type: "approximate", timezone: "Asia/Tokyo" },
		});
	});

	it("rejects an empty timezone", () => {
		expectInvalid({ query: "test", user_location: { type: "approximate", timezone: "" } }, "timezone");
	});

	it("accepts user_location omitted entirely", () => {
		expectValid({ query: "test" });
	});

	it("rejects user_location.type other than 'approximate'", () => {
		expectInvalid(
			{
				query: "test",
				user_location: {
					type: "precise" as unknown as "approximate",
					country: "JP",
				},
			},
			"approximate",
		);
	});
});

describe("normalizeUserLocation", () => {
	it("passes valid uppercase ISO codes unchanged", () => {
		const loc = normalizeUserLocation({ type: "approximate", country: "US" });
		expect(loc.country).toBe("US");
	});

	it("uppercases a lowercase ISO code", () => {
		const loc = normalizeUserLocation({ type: "approximate", country: "jp" });
		expect(loc.country).toBe("JP");
	});

	it("uppercases a mixed-case ISO code", () => {
		const loc = normalizeUserLocation({ type: "approximate", country: "gB" });
		expect(loc.country).toBe("GB");
	});

	it("preserves city / region / timezone verbatim during normalization", () => {
		const loc = normalizeUserLocation({
			type: "approximate",
			city: "Tokyo",
			region: "Kantō",
			country: "jp",
			timezone: "Asia/Tokyo",
		});
		expect(loc.city).toBe("Tokyo");
		expect(loc.region).toBe("Kantō");
		expect(loc.timezone).toBe("Asia/Tokyo");
		expect(loc.country).toBe("JP");
	});

	it("returns undefined when input is undefined", () => {
		expect(normalizeUserLocation(undefined)).toBeUndefined();
	});

	it("does not mutate its input", () => {
		const input = { type: "approximate" as const, country: "jp" };
		normalizeUserLocation(input);
		expect(input.country).toBe("jp");
	});
});
