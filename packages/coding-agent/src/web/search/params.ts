export type WebSearchRecency = "day" | "week" | "month" | "year";

export interface WebSearchUserLocation {
	type: "approximate";
	city?: string;
	region?: string;
	country?: string;
	timezone?: string;
}

export interface WebSearchParams {
	query: string;
	recency?: WebSearchRecency;
	limit?: number;
	max_tokens?: number;
	temperature?: number;
	num_search_results?: number;
	max_uses?: number;
	allowed_domains?: string[];
	blocked_domains?: string[];
	user_location?: WebSearchUserLocation;
}

export type ValidationResult = { valid: true } | { valid: false; error: string };

const RECENCY_VALUES: readonly WebSearchRecency[] = ["day", "week", "month", "year"] as const;
const ISO_ALPHA2 = /^[A-Za-z]{2}$/;

function fail(error: string): ValidationResult {
	return { valid: false, error };
}

function isPositiveInteger(value: number): boolean {
	return Number.isInteger(value) && value > 0;
}

function validatePositiveInteger(name: string, value: number | undefined): ValidationResult | null {
	if (value === undefined) return null;
	if (!isPositiveInteger(value)) {
		return fail(`${name} must be a positive integer (received ${value})`);
	}
	return null;
}

function validateDomainList(name: string, list: string[] | undefined): ValidationResult | null {
	if (list === undefined) return null;
	for (const entry of list) {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			return fail(`${name} must not contain empty or whitespace-only entries`);
		}
	}
	return null;
}

function validateUserLocation(loc: WebSearchUserLocation | undefined): ValidationResult | null {
	if (loc === undefined) return null;
	if (loc.type !== "approximate") {
		return fail(`user_location.type must be "approximate" (received "${String(loc.type)}")`);
	}
	if (loc.country !== undefined) {
		if (typeof loc.country !== "string" || !ISO_ALPHA2.test(loc.country)) {
			return fail(
				`user_location.country must be an ISO 3166-1 alpha-2 code (e.g. "US", "JP", "GB") (received "${String(loc.country)}")`,
			);
		}
	}
	if (loc.city !== undefined && (typeof loc.city !== "string" || loc.city.trim().length === 0)) {
		return fail(`user_location.city must be a non-empty string`);
	}
	if (loc.region !== undefined && (typeof loc.region !== "string" || loc.region.trim().length === 0)) {
		return fail(`user_location.region must be a non-empty string`);
	}
	if (loc.timezone !== undefined && (typeof loc.timezone !== "string" || loc.timezone.trim().length === 0)) {
		return fail(`user_location.timezone must be a non-empty string`);
	}
	return null;
}

export function validateWebSearchParams(params: WebSearchParams): ValidationResult {
	if (typeof params.query !== "string" || params.query.trim().length === 0) {
		return fail("query must be a non-empty string");
	}

	if (params.recency !== undefined && !RECENCY_VALUES.includes(params.recency)) {
		return fail(
			`recency must be one of ${RECENCY_VALUES.map(v => `"${v}"`).join(", ")} (received "${String(params.recency)}")`,
		);
	}

	const positiveIntegerFields: [string, number | undefined][] = [
		["num_search_results", params.num_search_results],
		["limit", params.limit],
		["max_tokens", params.max_tokens],
		["max_uses", params.max_uses],
	];
	for (const [name, value] of positiveIntegerFields) {
		const result = validatePositiveInteger(name, value);
		if (result) return result;
	}

	if (params.temperature !== undefined) {
		if (typeof params.temperature !== "number" || params.temperature < 0 || params.temperature > 2) {
			return fail(`temperature must be a number between 0 and 2 (received ${params.temperature})`);
		}
	}

	for (const [name, list] of [
		["allowed_domains", params.allowed_domains],
		["blocked_domains", params.blocked_domains],
	] as const) {
		const result = validateDomainList(name, list);
		if (result) return result;
	}

	const locResult = validateUserLocation(params.user_location);
	if (locResult) return locResult;

	return { valid: true };
}

export function normalizeUserLocation(loc: WebSearchUserLocation | undefined): WebSearchUserLocation | undefined {
	if (loc === undefined) return undefined;
	const next: WebSearchUserLocation = { type: loc.type };
	if (loc.city !== undefined) next.city = loc.city;
	if (loc.region !== undefined) next.region = loc.region;
	if (loc.timezone !== undefined) next.timezone = loc.timezone;
	if (loc.country !== undefined) next.country = loc.country.toUpperCase();
	return next;
}
