import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { hookFetch } from "@f5xc-salesdemos/pi-utils";
import { getSearchProvider, resolveProviderChain, SEARCH_PROVIDER_ORDER } from "../../src/web/search/provider";
import { searchFirecrawl } from "../../src/web/search/providers/firecrawl";
import type { SearchProviderError } from "../../src/web/search/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFirecrawlResponse(overrides: Record<string, unknown> = {}) {
	return {
		data: [
			{
				title: "Result Alpha",
				url: "https://alpha.example.com",
				markdown: "Alpha snippet content here.",
				metadata: { publishedTime: "2026-03-01T00:00:00Z" },
			},
			{
				title: "Result Beta",
				url: "https://beta.example.com",
				markdown: "Beta snippet content here.",
				metadata: {},
			},
			{
				url: "https://no-title.example.com",
				markdown: "No title content.",
				metadata: {},
			},
		],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("Firecrawl search provider registration", () => {
	it("is in the provider registry and fallback order", async () => {
		expect(SEARCH_PROVIDER_ORDER).toContain("firecrawl");
		expect(getSearchProvider("firecrawl").label).toBe("Firecrawl");
	});

	it("resolveProviderChain returns firecrawl when env var is set", async () => {
		const prev = process.env.FIRECRAWL_SEARCH_URL;
		process.env.FIRECRAWL_SEARCH_URL = "http://localhost:3002";
		try {
			const providers = await resolveProviderChain("firecrawl");
			expect(providers[0]?.id).toBe("firecrawl");
		} finally {
			if (prev === undefined) delete process.env.FIRECRAWL_SEARCH_URL;
			else process.env.FIRECRAWL_SEARCH_URL = prev;
		}
	});
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

describe("FirecrawlProvider.isAvailable()", () => {
	afterEach(() => {
		delete process.env.FIRECRAWL_SEARCH_URL;
	});

	it("returns true when FIRECRAWL_SEARCH_URL is set", async () => {
		process.env.FIRECRAWL_SEARCH_URL = "http://localhost:3002";
		expect(await getSearchProvider("firecrawl").isAvailable()).toBe(true);
	});

	it("returns false when FIRECRAWL_SEARCH_URL is not set", async () => {
		delete process.env.FIRECRAWL_SEARCH_URL;
		expect(await getSearchProvider("firecrawl").isAvailable()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// searchFirecrawl — happy path
// ---------------------------------------------------------------------------

describe("searchFirecrawl — response mapping", () => {
	beforeEach(() => {
		process.env.FIRECRAWL_SEARCH_URL = "http://localhost:3002";
	});

	afterEach(() => {
		delete process.env.FIRECRAWL_SEARCH_URL;
	});

	it("maps Firecrawl response into SearchResponse with correct provider id", async () => {
		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify(makeFirecrawlResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const result = await searchFirecrawl({ query: "test query" });
		expect(result.provider).toBe("firecrawl");
	});

	it("maps title, url, and snippet from markdown field", async () => {
		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify(makeFirecrawlResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const result = await searchFirecrawl({ query: "test query" });
		expect(result.sources[0]).toMatchObject({
			title: "Result Alpha",
			url: "https://alpha.example.com",
			snippet: "Alpha snippet content here.",
		});
	});

	it("uses url as fallback title when title is missing", async () => {
		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify(makeFirecrawlResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const result = await searchFirecrawl({ query: "test query" });
		const noTitleSource = result.sources.find(s => s.url === "https://no-title.example.com");
		expect(noTitleSource?.title).toBe("https://no-title.example.com");
	});

	it("maps publishedTime from metadata as publishedDate", async () => {
		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify(makeFirecrawlResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const result = await searchFirecrawl({ query: "test query" });
		expect(result.sources[0]?.publishedDate).toBe("2026-03-01T00:00:00Z");
	});

	it("sends the correct request body to Firecrawl API", async () => {
		let capturedBody: Record<string, unknown> | null = null;

		using _hook = hookFetch((_input, init) => {
			capturedBody = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
			return new Response(JSON.stringify(makeFirecrawlResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchFirecrawl({ query: "f5 big-ip latest version", num_results: 5 });

		expect(capturedBody).toMatchObject({
			query: "f5 big-ip latest version",
			limit: 5,
		});
	});

	it("posts to the /v1/search endpoint of FIRECRAWL_SEARCH_URL", async () => {
		let capturedUrl = "";

		using _hook = hookFetch((input, _init) => {
			capturedUrl = String(input);
			return new Response(JSON.stringify(makeFirecrawlResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		process.env.FIRECRAWL_SEARCH_URL = "http://localhost:3002";
		await searchFirecrawl({ query: "url test" });

		expect(capturedUrl).toBe("http://localhost:3002/v1/search");
	});
});

// ---------------------------------------------------------------------------
// searchFirecrawl — edge cases
// ---------------------------------------------------------------------------

describe("searchFirecrawl — edge cases", () => {
	beforeEach(() => {
		process.env.FIRECRAWL_SEARCH_URL = "http://localhost:3002";
	});

	afterEach(() => {
		delete process.env.FIRECRAWL_SEARCH_URL;
	});

	it("returns empty sources array when data is empty", async () => {
		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const result = await searchFirecrawl({ query: "empty" });
		expect(result.sources).toHaveLength(0);
	});

	it("skips results that have no url", async () => {
		const bodyWithNoUrl = {
			data: [
				{ title: "No URL", markdown: "some content", metadata: {} },
				{ title: "Has URL", url: "https://valid.com", markdown: "valid", metadata: {} },
			],
		};

		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify(bodyWithNoUrl), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const result = await searchFirecrawl({ query: "url filter" });
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]?.url).toBe("https://valid.com");
	});

	it("respects num_results limit", async () => {
		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify(makeFirecrawlResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const result = await searchFirecrawl({ query: "limit test", num_results: 2 });
		expect(result.sources.length).toBeLessThanOrEqual(2);
	});
});

// ---------------------------------------------------------------------------
// searchFirecrawl — error handling
// ---------------------------------------------------------------------------

describe("searchFirecrawl — error handling", () => {
	beforeEach(() => {
		process.env.FIRECRAWL_SEARCH_URL = "http://localhost:3002";
	});

	afterEach(() => {
		delete process.env.FIRECRAWL_SEARCH_URL;
	});

	it("throws SearchProviderError on non-ok HTTP response", async () => {
		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify({ error: "rate limited" }), {
					status: 429,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await expect(searchFirecrawl({ query: "bad request" })).rejects.toEqual(
			expect.objectContaining({
				provider: "firecrawl",
				status: 429,
			}) satisfies Partial<SearchProviderError>,
		);
	});

	it("throws a clear error when FIRECRAWL_SEARCH_URL is not configured", async () => {
		delete process.env.FIRECRAWL_SEARCH_URL;
		await expect(searchFirecrawl({ query: "no config" })).rejects.toThrow(
			"FIRECRAWL_SEARCH_URL is not configured",
		);
	});
});
