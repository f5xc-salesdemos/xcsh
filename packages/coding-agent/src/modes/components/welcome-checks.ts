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
	if (!authStorage.hasAuth(provider)) {
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
		const apiKey = await authStorage.peekApiKey(provider);
		if (!apiKey) {
			return { state: "auth_error", provider };
		}

		const baseUrl = model?.baseUrl;
		if (!baseUrl) {
			return { state: "auth_error", provider };
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
	} catch (err) {
		logger.warn("Welcome model validation failed:", err);
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
	} catch (err) {
		logger.warn("Welcome profile validation failed:", err);
		return { state: "no_profile" };
	}
}
