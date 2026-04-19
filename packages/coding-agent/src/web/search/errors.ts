import { SearchProviderError } from "./types";

export interface WebSearchError {
	field?: string;
	constraint?: string;
	userMessage: string;
	status?: number;
	raw: unknown;
}

const FIELD_PATTERN = /tools\.\d+\.web_search_\d+\.([A-Za-z_][A-Za-z_0-9.]*?):\s*(.+?)(?:\n|$)/;

const LITELLM_NOISE_PATTERNS: RegExp[] = [
	/No fallback model group found for original model_group=[^\n]*/gi,
	/Fallbacks=\[[^\]]*\][^\n]*/gi,
	/Available Model Group Fallbacks=[^\n]*/gi,
	/claude-haiku-[0-9a-z.-]+/gi,
	/claude-[a-z0-9-]+-\d+/gi,
	/model_group=[^\s,]+/gi,
];

function scrubLitellmNoise(text: string): string {
	let cleaned = text;
	for (const pattern of LITELLM_NOISE_PATTERNS) {
		cleaned = cleaned.replace(pattern, "");
	}
	return cleaned
		.replace(/\n{2,}/g, "\n")
		.replace(/\s{2,}/g, " ")
		.trim();
}

function fieldHint(field: string): string | undefined {
	if (field === "user_location.country") {
		return "user_location.country must be an ISO 3166-1 alpha-2 code (e.g. US, JP, GB)";
	}
	return undefined;
}

function extractRawMessage(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof SearchProviderError) return input.message;
	if (input instanceof Error) return input.message;
	if (input && typeof input === "object") {
		const body = (input as { error?: { message?: unknown } }).error;
		if (body && typeof body.message === "string") return body.message;
	}
	return "";
}

function tryParseJsonString(raw: string): unknown | undefined {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function matchFieldPattern(text: string): RegExpMatchArray | null {
	return text.match(FIELD_PATTERN);
}

export function parseWebSearchError(input: unknown): WebSearchError {
	if (input instanceof SearchProviderError) {
		if (input.status === 401 || input.status === 403) {
			return {
				status: input.status,
				userMessage: `Web search authorization failed (${input.status}). Check API key or base URL.`,
				raw: input,
			};
		}
		if (input.status === 404) {
			return {
				status: input.status,
				userMessage: "Web search returned 404 (model or endpoint not found).",
				raw: input,
			};
		}
	}

	let bodyForFieldScan: unknown = input;
	if (typeof input === "string") {
		const parsed = tryParseJsonString(input);
		if (parsed !== undefined) bodyForFieldScan = parsed;
	}

	const rawMessage = extractRawMessage(bodyForFieldScan);

	if (rawMessage.length === 0) {
		return {
			userMessage: "web_search failed — no error detail available.",
			raw: input,
		};
	}

	const match = matchFieldPattern(rawMessage);
	if (match) {
		const field = match[1];
		const constraint = match[2].trim();
		const hint = fieldHint(field);
		const userMessage = hint ? `web_search error: ${hint}.` : `web_search error: ${field} — ${constraint}.`;
		return { field, constraint, userMessage, raw: input };
	}

	if (input instanceof Error && !(input instanceof SearchProviderError)) {
		return {
			userMessage: `web_search transport error: ${input.message}`,
			raw: input,
		};
	}

	const scrubbed = scrubLitellmNoise(rawMessage);
	const userMessage =
		scrubbed.length > 0
			? `web_search failed — ${scrubbed}`
			: "web_search failed — upstream error (details suppressed).";
	return { userMessage, raw: input };
}
