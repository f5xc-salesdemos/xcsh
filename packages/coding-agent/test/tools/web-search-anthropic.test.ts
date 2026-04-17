import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { hookFetch } from "@f5xc-salesdemos/pi-utils";
import { extractSiteOperators, searchAnthropic } from "../../src/web/search/providers/anthropic";

type CapturedRequest = {
	url: string;
	headers: RequestInit["headers"];
	body: Record<string, unknown> | null;
};

const WEB_SEARCH_BETA = "web-search-2025-03-05";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

function makeAnthropicResponse() {
	return {
		id: "msg_test_123",
		model: "claude-haiku-4-5",
		content: [{ type: "text", text: "Test answer" }],
		usage: {
			input_tokens: 12,
			output_tokens: 7,
			server_tool_use: { web_search_requests: 1 },
		},
	};
}

function getHeaderCaseInsensitive(headers: RequestInit["headers"], name: string): string | undefined {
	if (!headers) return undefined;

	if (headers instanceof Headers) {
		return headers.get(name) ?? undefined;
	}

	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
		return match?.[1];
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name.toLowerCase()) {
			return value as string;
		}
	}

	return undefined;
}

describe("searchAnthropic headers", () => {
	const originalSearchApiKey = process.env.ANTHROPIC_SEARCH_API_KEY;
	const originalSearchBaseUrl = process.env.ANTHROPIC_SEARCH_BASE_URL;
	const originalApiKey = process.env.ANTHROPIC_API_KEY;
	const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

	let capturedRequest: CapturedRequest | null = null;

	beforeEach(() => {
		capturedRequest = null;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_BASE_URL;
		process.env.ANTHROPIC_SEARCH_BASE_URL = ANTHROPIC_BASE_URL;
	});

	afterEach(() => {
		capturedRequest = null;

		if (originalSearchApiKey === undefined) {
			delete process.env.ANTHROPIC_SEARCH_API_KEY;
		} else {
			process.env.ANTHROPIC_SEARCH_API_KEY = originalSearchApiKey;
		}

		if (originalSearchBaseUrl === undefined) {
			delete process.env.ANTHROPIC_SEARCH_BASE_URL;
		} else {
			process.env.ANTHROPIC_SEARCH_BASE_URL = originalSearchBaseUrl;
		}

		if (originalApiKey === undefined) {
			delete process.env.ANTHROPIC_API_KEY;
		} else {
			process.env.ANTHROPIC_API_KEY = originalApiKey;
		}

		if (originalBaseUrl === undefined) {
			delete process.env.ANTHROPIC_BASE_URL;
		} else {
			process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
		}
	});

	function mockFetch(responseBody: unknown): Disposable {
		return hookFetch((url, init) => {
			capturedRequest = {
				url: typeof url === "string" ? url : url.toString(),
				headers: init?.headers,
				body: init?.body ? JSON.parse(init.body as string) : null,
			};

			return new Response(JSON.stringify(responseBody), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
	}

	it("includes web-search beta header and sends API key in X-Api-Key mode", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		using _hook = mockFetch(makeAnthropicResponse());

		await searchAnthropic({ query: "test api key mode" });

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.url).toBe(`${ANTHROPIC_BASE_URL}/v1/messages?beta=true`);
		expect(getHeaderCaseInsensitive(capturedRequest?.headers, "anthropic-beta")).toContain(WEB_SEARCH_BETA);
		expect(getHeaderCaseInsensitive(capturedRequest?.headers, "x-api-key")).toBe("sk-ant-api-test");
		expect(getHeaderCaseInsensitive(capturedRequest?.headers, "authorization")).toBeUndefined();
		expect(capturedRequest?.body?.tools).toEqual([{ type: "web_search_20250305", name: "web_search" }]);
	});

	it("includes web-search beta header and sends OAuth token in Authorization mode", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-oat-test";
		using _hook = mockFetch(makeAnthropicResponse());

		await searchAnthropic({ query: "test oauth mode" });

		expect(capturedRequest).not.toBeNull();
		expect(getHeaderCaseInsensitive(capturedRequest?.headers, "anthropic-beta")).toContain(WEB_SEARCH_BETA);
		expect(getHeaderCaseInsensitive(capturedRequest?.headers, "authorization")).toBe("Bearer sk-ant-oat-test");
		expect(getHeaderCaseInsensitive(capturedRequest?.headers, "x-api-key")).toBeUndefined();
	});

	it("sends allowed_domains in tool definition when provided", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		using _hook = mockFetch(makeAnthropicResponse());

		await searchAnthropic({ query: "test query", allowed_domains: ["example.com", "docs.example.com"] });

		expect(capturedRequest?.body?.tools).toEqual([
			{
				type: "web_search_20250305",
				name: "web_search",
				allowed_domains: ["example.com", "docs.example.com"],
			},
		]);
	});

	it("sends blocked_domains in tool definition when provided", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		using _hook = mockFetch(makeAnthropicResponse());

		await searchAnthropic({ query: "test query", blocked_domains: ["spam.com"] });

		expect(capturedRequest?.body?.tools).toEqual([
			{
				type: "web_search_20250305",
				name: "web_search",
				blocked_domains: ["spam.com"],
			},
		]);
	});

	it("extracts site: operator from query and converts to allowed_domains", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		using _hook = mockFetch(makeAnthropicResponse());

		await searchAnthropic({ query: "site:example.com search terms" });

		const body = capturedRequest?.body;
		expect(body?.messages).toEqual([{ role: "user", content: "search terms" }]);
		expect((body?.tools as any[])?.[0]?.allowed_domains).toEqual(["example.com"]);
	});

	it("uses domain name as query when site: operator is the entire query", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		using _hook = mockFetch(makeAnthropicResponse());

		await searchAnthropic({ query: "site:example.com" });

		const body = capturedRequest?.body;
		expect(body?.messages).toEqual([{ role: "user", content: "example.com" }]);
		expect((body?.tools as any[])?.[0]?.allowed_domains).toEqual(["example.com"]);
	});

	it("merges site: operator domains with explicit allowed_domains", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		using _hook = mockFetch(makeAnthropicResponse());

		await searchAnthropic({
			query: "site:docs.example.com search terms",
			allowed_domains: ["example.com"],
		});

		const tools = capturedRequest?.body?.tools as any[];
		expect(tools?.[0]?.allowed_domains).toEqual(["example.com", "docs.example.com"]);
	});

	it("sends max_uses in tool definition when provided", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		using _hook = mockFetch(makeAnthropicResponse());

		await searchAnthropic({ query: "test query", max_uses: 3 });

		expect((capturedRequest?.body?.tools as any[])?.[0]?.max_uses).toBe(3);
	});

	it("sends user_location in tool definition when provided", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		using _hook = mockFetch(makeAnthropicResponse());

		const location = {
			type: "approximate" as const,
			city: "Seattle",
			region: "Washington",
			country: "US",
			timezone: "America/Los_Angeles",
		};
		await searchAnthropic({ query: "test query", user_location: location });

		expect((capturedRequest?.body?.tools as any[])?.[0]?.user_location).toEqual(location);
	});

	it("omits optional tool fields when no extra params provided", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		using _hook = mockFetch(makeAnthropicResponse());

		await searchAnthropic({ query: "plain query" });

		expect(capturedRequest?.body?.tools).toEqual([{ type: "web_search_20250305", name: "web_search" }]);
	});

	it("sends both allowed_domains and blocked_domains together", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		using _hook = mockFetch(makeAnthropicResponse());

		await searchAnthropic({
			query: "test query",
			allowed_domains: ["docs.example.com"],
			blocked_domains: ["spam.com"],
		});

		const tool = (capturedRequest?.body?.tools as any[])?.[0];
		expect(tool?.allowed_domains).toEqual(["docs.example.com"]);
		expect(tool?.blocked_domains).toEqual(["spam.com"]);
	});

	it("does not send allowed_domains when array is empty", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		using _hook = mockFetch(makeAnthropicResponse());

		await searchAnthropic({ query: "test query", allowed_domains: [] });

		expect(capturedRequest?.body?.tools).toEqual([{ type: "web_search_20250305", name: "web_search" }]);
	});

	it("does not send blocked_domains when array is empty", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api-test";
		using _hook = mockFetch(makeAnthropicResponse());

		await searchAnthropic({ query: "test query", blocked_domains: [] });

		expect(capturedRequest?.body?.tools).toEqual([{ type: "web_search_20250305", name: "web_search" }]);
	});
});

describe("extractSiteOperators", () => {
	it("extracts a single site: operator", () => {
		const result = extractSiteOperators("site:example.com search terms");
		expect(result.cleanQuery).toBe("search terms");
		expect(result.domains).toEqual(["example.com"]);
	});

	it("extracts multiple site: operators", () => {
		const result = extractSiteOperators("site:a.com site:b.org some query");
		expect(result.cleanQuery).toBe("some query");
		expect(result.domains).toEqual(["a.com", "b.org"]);
	});

	it("is case-insensitive", () => {
		const result = extractSiteOperators("Site:Example.COM query");
		expect(result.domains).toEqual(["Example.COM"]);
		expect(result.cleanQuery).toBe("query");
	});

	it("uses domain as query when query is only site: operators", () => {
		const result = extractSiteOperators("site:example.com");
		expect(result.cleanQuery).toBe("example.com");
		expect(result.domains).toEqual(["example.com"]);
	});

	it("uses joined domains as query when multiple site:-only operators", () => {
		const result = extractSiteOperators("site:a.com site:b.org");
		expect(result.cleanQuery).toBe("a.com b.org");
		expect(result.domains).toEqual(["a.com", "b.org"]);
	});

	it("returns original query when no site: operators present", () => {
		const result = extractSiteOperators("regular search query");
		expect(result.cleanQuery).toBe("regular search query");
		expect(result.domains).toEqual([]);
	});

	it("handles site: operator mid-query", () => {
		const result = extractSiteOperators("find docs site:docs.example.com about auth");
		expect(result.cleanQuery).toBe("find docs about auth");
		expect(result.domains).toEqual(["docs.example.com"]);
	});
});
