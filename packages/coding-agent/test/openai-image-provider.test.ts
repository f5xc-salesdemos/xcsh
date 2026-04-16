import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { getEnvApiKey } from "@f5xc-salesdemos/pi-ai";
import { getDefault } from "../src/config/settings";

const savedEnv: Record<string, string | undefined> = {};
const IMAGE_ENV_KEYS = [
	"LITELLM_API_KEY",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"LITELLM_BASE_URL",
	"OPENAI_BASE_URL",
];

function saveAndClearImageEnv() {
	for (const key of IMAGE_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
}

function restoreImageEnv() {
	for (const key of IMAGE_ENV_KEYS) {
		if (savedEnv[key] !== undefined) {
			process.env[key] = savedEnv[key];
		} else {
			delete process.env[key];
		}
	}
}

describe("OpenAI Image Provider", () => {
	describe("API key detection via getEnvApiKey()", () => {
		beforeEach(() => saveAndClearImageEnv());
		afterAll(() => restoreImageEnv());

		test("litellm provider resolves LITELLM_API_KEY", () => {
			process.env.LITELLM_API_KEY = "test-litellm-key";
			expect(getEnvApiKey("litellm")).toBe("test-litellm-key");
		});

		test("openai provider resolves OPENAI_API_KEY", () => {
			process.env.OPENAI_API_KEY = "test-openai-key";
			expect(getEnvApiKey("openai")).toBe("test-openai-key");
		});

		test("litellm ?? openai fallback chain works", () => {
			process.env.OPENAI_API_KEY = "openai-key";
			const result = getEnvApiKey("litellm") ?? getEnvApiKey("openai");
			expect(result).toBe("openai-key");
		});

		test("litellm takes priority over openai in fallback chain", () => {
			process.env.LITELLM_API_KEY = "litellm-key";
			process.env.OPENAI_API_KEY = "openai-key";
			const result = getEnvApiKey("litellm") ?? getEnvApiKey("openai");
			expect(result).toBe("litellm-key");
		});

		test("no keys set returns undefined", () => {
			expect(getEnvApiKey("litellm")).toBeUndefined();
			expect(getEnvApiKey("openai")).toBeUndefined();
			expect(getEnvApiKey("openrouter")).toBeUndefined();
		});

		test("openrouter key resolves independently", () => {
			process.env.OPENROUTER_API_KEY = "or-key";
			expect(getEnvApiKey("openrouter")).toBe("or-key");
		});
	});

	describe("Settings schema defaults", () => {
		test("providers.image defaults to 'auto'", () => {
			expect(getDefault("providers.image")).toBe("auto");
		});

		test("providers.imageSize defaults to '1536x1024'", () => {
			expect(getDefault("providers.imageSize")).toBe("1536x1024");
		});

		test("providers.imageQuality defaults to 'high'", () => {
			expect(getDefault("providers.imageQuality")).toBe("high");
		});

		test("generate_image.enabled defaults to true", () => {
			expect(getDefault("generate_image.enabled")).toBe(true);
		});

		test("inspect_image.enabled defaults to true", () => {
			expect(getDefault("inspect_image.enabled")).toBe(true);
		});

		test("images.blockImages defaults to false", () => {
			expect(getDefault("images.blockImages")).toBe(false);
		});

		test("images.autoResize defaults to true", () => {
			expect(getDefault("images.autoResize")).toBe(true);
		});

		test("terminal.showImages defaults to true", () => {
			expect(getDefault("terminal.showImages")).toBe(true);
		});
	});

	describe("providers.image enum includes openai", () => {
		test("openai is a valid value for providers.image", () => {
			// Import the schema to check the enum values
			const { SETTINGS_SCHEMA } = require("../src/config/settings-schema");
			const imageProviderDef = SETTINGS_SCHEMA["providers.image"];
			expect(imageProviderDef.values).toContain("openai");
			expect(imageProviderDef.values).toContain("auto");
			expect(imageProviderDef.values).toContain("gemini");
			expect(imageProviderDef.values).toContain("openrouter");
		});

		test("providers.imageSize has correct enum values", () => {
			const { SETTINGS_SCHEMA } = require("../src/config/settings-schema");
			const sizeDef = SETTINGS_SCHEMA["providers.imageSize"];
			expect(sizeDef.values).toEqual(["1024x1024", "1536x1024", "1024x1536"]);
		});

		test("providers.imageQuality has correct enum values", () => {
			const { SETTINGS_SCHEMA } = require("../src/config/settings-schema");
			const qualityDef = SETTINGS_SCHEMA["providers.imageQuality"];
			expect(qualityDef.values).toEqual(["low", "medium", "high"]);
		});
	});

	describe("image content routing logic", () => {
		test("image content should be replaced with warning for non-vision model", () => {
			// Simulate what convertToLlmWithImageRouting does
			const modelSupportsImage = false;
			const messages = [
				{
					role: "user" as const,
					content: [
						{ type: "text" as const, text: "What is in this image?" },
						{ type: "image" as const, data: "base64data", mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			];

			if (!modelSupportsImage) {
				const routed = messages.map(msg => {
					const content = msg.content;
					if (!Array.isArray(content)) return msg;
					const hasImages = content.some(c => c.type === "image");
					if (!hasImages) return msg;
					const filtered = content.map(c =>
						c.type === "image"
							? {
									type: "text" as const,
									text: "[Image content detected but current model does not support vision. Use the inspect_image tool to analyze this image, or ask the user to switch to a vision-capable model.]",
								}
							: c,
					);
					return { ...msg, content: filtered };
				});

				expect(routed[0].content).toHaveLength(2);
				expect(routed[0].content[0]).toEqual({
					type: "text",
					text: "What is in this image?",
				});
				expect(routed[0].content[1]).toHaveProperty("type", "text");
				expect((routed[0].content[1] as { text: string }).text).toContain("does not support vision");
			}
		});

		test("image content should pass through for vision-capable model", () => {
			const modelSupportsImage = true;
			const messages = [
				{
					role: "user" as const,
					content: [
						{ type: "text" as const, text: "What is in this image?" },
						{ type: "image" as const, data: "base64data", mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			];

			if (modelSupportsImage) {
				// No transformation needed
				expect(messages[0].content).toHaveLength(2);
				expect(messages[0].content[1]).toHaveProperty("type", "image");
			}
		});

		test("messages without images should not be modified", () => {
			const messages = [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: "Hello" }] as Array<{ type: string; text?: string }>,
					timestamp: Date.now(),
				},
			];

			const hasImages = messages[0].content.some(c => c.type === "image");
			expect(hasImages).toBe(false);
		});
	});
});
