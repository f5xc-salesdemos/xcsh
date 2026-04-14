/**
 * LiteLLM login flow.
 *
 * Collects base URL and API key via sequential prompts.
 * Returns both values for the caller to persist and verify.
 */

import type { OAuthController } from "./types";

export interface LiteLLMLoginDefaults {
	baseUrl?: string;
	apiKey?: string;
}

export interface LiteLLMLoginResult {
	baseUrl: string;
	apiKey: string;
}

export interface LiteLLMLoginOptions extends OAuthController {
	defaults?: LiteLLMLoginDefaults;
}

/**
 * Mask an API key for display: show first 3 chars + **** + last 4 chars.
 * Returns empty string for undefined/short keys.
 */
export function maskApiKey(key: string | undefined): string {
	if (!key || key.length < 8) return key ?? "";
	return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

/**
 * Login to LiteLLM proxy.
 *
 * Prompts for base URL and API key in sequence. If defaults are provided,
 * they are shown in the prompt and accepted on empty input (Enter).
 */
export async function loginLiteLLM(options: LiteLLMLoginOptions): Promise<LiteLLMLoginResult> {
	if (!options.onPrompt) {
		throw new Error("LiteLLM login requires onPrompt callback");
	}

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const defaults = options.defaults ?? {};

	// Step 1: Base URL
	const defaultUrlHint = defaults.baseUrl ? ` [${defaults.baseUrl}]` : "";
	const rawUrl = await options.onPrompt({
		message: `LiteLLM Base URL${defaultUrlHint}`,
		placeholder: "https://your-litellm-proxy.example.com",
	});

	if (options.signal?.aborted) throw new Error("Login cancelled");

	const baseUrl = rawUrl.trim().replace(/\/+$/, "") || defaults.baseUrl?.trim().replace(/\/+$/, "");
	if (!baseUrl) {
		throw new Error("Base URL is required");
	}

	// Step 2: API Key
	const maskedDefault = maskApiKey(defaults.apiKey);
	const defaultKeyHint = maskedDefault ? ` [${maskedDefault}]` : "";
	const rawKey = await options.onPrompt({
		message: `LiteLLM API Key${defaultKeyHint}`,
		placeholder: "sk-...",
	});

	if (options.signal?.aborted) throw new Error("Login cancelled");

	const apiKey = rawKey.trim() || defaults.apiKey?.trim();
	if (!apiKey) {
		throw new Error("API key is required");
	}

	return { baseUrl, apiKey };
}
