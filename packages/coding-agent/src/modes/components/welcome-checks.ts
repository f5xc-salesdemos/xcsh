import type { Model } from "@f5xc-salesdemos/pi-ai";
import { validateApiKeyAgainstModelsEndpoint } from "@f5xc-salesdemos/pi-ai/utils/oauth/api-key-validation";
import { logger } from "@f5xc-salesdemos/pi-utils";
import { ProfileService } from "../../services/f5xc-profile";
import type { AuthStorage } from "../../session/auth-storage";

export type ModelCheckState = "no_provider" | "connected" | "auth_error";

export interface ModelStatus {
	state: ModelCheckState;
	provider?: string;
	latencyMs?: number;
}

export type ProfileCheckState = "no_profile" | "connected" | "auth_error" | "offline";

export interface WelcomeProfileStatus {
	state: ProfileCheckState;
	name?: string;
	latencyMs?: number;
}

export interface WelcomeCheckResult {
	model: ModelStatus;
	profile?: WelcomeProfileStatus;
}

/** Providers that don't store API keys (local inference servers) */
const KEYLESS_PROVIDERS = new Set(["ollama", "llama.cpp", "lm-studio", "llamafile", "local"]);

/**
 * Run blocking startup checks for the welcome screen.
 * Model check always runs. Profile check only runs if model is connected.
 */
export async function runWelcomeChecks(
	model: Model | undefined,
	authStorage: AuthStorage,
): Promise<WelcomeCheckResult> {
	const provider = model?.provider ?? "unknown";

	// Step 1: Check model provider credentials exist
	// Keyless local providers (ollama, llama.cpp, lm-studio, etc.) don't store credentials
	if (!authStorage.hasAuth(provider) && !KEYLESS_PROVIDERS.has(provider)) {
		return { model: { state: "no_provider", provider } };
	}

	// Step 2: Live model validation — try to reach the models endpoint
	const modelStatus = await validateModelConnection(model, authStorage);
	if (modelStatus.state !== "connected") {
		return { model: modelStatus };
	}

	// Step 3: Profile check (only if model is connected)
	const profileStatus = await checkProfileStatus();
	return { model: modelStatus, profile: profileStatus };
}

async function validateModelConnection(model: Model | undefined, authStorage: AuthStorage): Promise<ModelStatus> {
	const provider = model?.provider ?? "unknown";
	try {
		const rawApiKey = await authStorage.peekApiKey(provider);
		if (!rawApiKey) {
			// Keyless providers skip validation
			if (KEYLESS_PROVIDERS.has(provider)) {
				return { state: "connected", provider, latencyMs: 0 };
			}
			return { state: "auth_error", provider };
		}

		// Detect unresolved env var names (e.g. "LITELLM_API_KEY" sent as literal)
		if (/^[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)+$/.test(rawApiKey)) {
			return { state: "auth_error", provider };
		}

		const baseUrl = model?.baseUrl;
		if (!baseUrl) {
			return { state: "auth_error", provider };
		}

		// GitHub Copilot returns a structured JSON token {token, enterpriseUrl};
		// extract the actual token for API validation
		let apiKey = rawApiKey;
		if (provider === "github-copilot" && rawApiKey.startsWith("{")) {
			try {
				const parsed = JSON.parse(rawApiKey);
				apiKey = parsed.token ?? rawApiKey;
			} catch {
				// Not JSON — use as-is
			}
		}

		const modelsUrl = `${baseUrl}/models`;
		const start = performance.now();
		await validateApiKeyAgainstModelsEndpoint({
			provider,
			apiKey,
			modelsUrl,
		});
		const latencyMs = Math.round(performance.now() - start);
		return { state: "connected", provider, latencyMs };
	} catch {
		logger.warn("Welcome model validation failed");
		return { state: "auth_error", provider };
	}
}

async function checkProfileStatus(): Promise<WelcomeProfileStatus> {
	try {
		const profileService = ProfileService.instance;
		if (!profileService) {
			return { state: "no_profile" };
		}

		const status = profileService.getStatus();
		if (!status.isConfigured) {
			return { state: "no_profile" };
		}

		const name = status.activeProfileName ?? "default";
		const result = await profileService.validateToken();

		switch (result.status) {
			case "connected":
				return { state: "connected", name, latencyMs: result.latencyMs };
			case "auth_error":
				return { state: "auth_error", name };
			case "offline":
				return { state: "offline", name };
			default:
				return { state: "no_profile" };
		}
	} catch {
		logger.warn("Welcome profile validation failed");
		return { state: "no_profile" };
	}
}
