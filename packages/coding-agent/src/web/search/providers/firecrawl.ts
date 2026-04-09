/**
 * Firecrawl Web Search Provider
 *
 * Calls a local Firecrawl /v1/search API (backed by SearXNG) and maps
 * results into the unified SearchResponse shape used by the web search tool.
 *
 * Set FIRECRAWL_SEARCH_URL to the Firecrawl base URL (e.g. http://localhost:3002).
 */
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 20;

export interface FirecrawlSearchParams {
	query: string;
	num_results?: number;
	signal?: AbortSignal;
}

interface FirecrawlResultItem {
	title?: string | null;
	url?: string | null;
	markdown?: string | null;
	metadata?: {
		publishedTime?: string | null;
		[key: string]: unknown;
	} | null;
}

interface FirecrawlSearchResponse {
	data?: FirecrawlResultItem[];
}

/** Return the configured Firecrawl base URL, or null if unset. */
export function getFirecrawlUrl(): string | null {
	return process.env.FIRECRAWL_SEARCH_URL ?? null;
}

async function callFirecrawlSearch(baseUrl: string, params: FirecrawlSearchParams): Promise<FirecrawlSearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const response = await fetch(`${baseUrl}/v1/search`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			query: params.query,
			limit: numResults,
			scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
		}),
		signal: params.signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new SearchProviderError(
			"firecrawl",
			`Firecrawl API error (${response.status}): ${errorText.trim() || response.statusText}`,
			response.status,
		);
	}

	return (await response.json()) as FirecrawlSearchResponse;
}

/** Execute a web search via the local Firecrawl/SearXNG instance. */
export async function searchFirecrawl(params: FirecrawlSearchParams): Promise<SearchResponse> {
	const baseUrl = getFirecrawlUrl();
	if (!baseUrl) {
		throw new Error(
			"FIRECRAWL_SEARCH_URL is not configured. Set it to the Firecrawl base URL (e.g. http://localhost:3002).",
		);
	}

	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const response = await callFirecrawlSearch(baseUrl, params);
	const sources: SearchSource[] = [];

	for (const item of response.data ?? []) {
		if (!item.url) continue;
		sources.push({
			title: item.title ?? item.url,
			url: item.url,
			snippet: item.markdown?.trim() || undefined,
			publishedDate: item.metadata?.publishedTime ?? undefined,
			ageSeconds: dateToAgeSeconds(item.metadata?.publishedTime ?? undefined),
		});
	}

	return {
		provider: "firecrawl",
		sources: sources.slice(0, numResults),
	};
}

/** Search provider for local Firecrawl/SearXNG. */
export class FirecrawlProvider extends SearchProvider {
	readonly id = "firecrawl" as const;
	readonly label = "Firecrawl";

	isAvailable() {
		return !!getFirecrawlUrl();
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchFirecrawl({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
		});
	}
}
