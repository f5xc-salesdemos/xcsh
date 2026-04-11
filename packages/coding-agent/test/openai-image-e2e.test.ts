import { describe, expect, test } from "bun:test";
import { getDefault } from "../src/config/settings";
import type { CustomToolContext } from "../src/extensibility/custom-tools/types";
import { type GeminiImageParams, geminiImageTool } from "../src/tools/gemini-image";

/**
 * End-to-end test: actually calls the LiteLLM proxy to generate an image
 * via the OpenAI provider path. Only runs if LITELLM_API_KEY is set.
 *
 * This validates:
 * - The OpenAI branch in execute() is reached
 * - The HTTP request format is correct
 * - The response is parsed correctly
 * - Images are decoded and saved to temp
 * - The tool result structure matches expectations
 */

const hasApiKey = !!process.env.LITELLM_API_KEY || !!process.env.OPENAI_API_KEY;

describe("OpenAI Image Generation E2E", () => {
	// Skip all tests if no API key
	(hasApiKey ? describe : describe.skip)("with live API", () => {
		test("generate_image produces valid PNG via OpenAI provider", async () => {
			// Force openai provider by temporarily setting env
			const originalProvider = process.env.OPENROUTER_API_KEY;
			const originalGemini = process.env.GEMINI_API_KEY;
			const originalGoogle = process.env.GOOGLE_API_KEY;
			delete process.env.OPENROUTER_API_KEY;
			delete process.env.GEMINI_API_KEY;
			delete process.env.GOOGLE_API_KEY;

			try {
				const params: GeminiImageParams = {
					subject: "A simple blue circle on a white background",
					style: "minimalist, flat design",
					image_size: "1024x1024",
				};

				// Minimal mock context - only what the OpenAI branch needs
				const mockCtx = {
					sessionManager: { getCwd: () => process.cwd() },
					modelRegistry: {
						getApiKeyForProvider: async () => null,
					},
					model: undefined,
					isIdle: () => true,
					hasQueuedMessages: () => false,
					abort: () => {},
					settings: {
						get: (path: string) => {
							if (path === "providers.imageSize") return getDefault("providers.imageSize" as any);
							if (path === "providers.imageQuality") return "low"; // Use low quality for speed
							return undefined;
						},
					},
				} as unknown as CustomToolContext;

				const result = await geminiImageTool.execute("test-call-1", params, undefined, mockCtx);

				// Verify result structure
				expect(result).toBeDefined();
				expect(result.content).toBeArray();
				expect(result.content.length).toBeGreaterThan(0);
				expect(result.content[0]).toHaveProperty("type", "text");

				const textContent = result.content[0] as { type: "text"; text: string };
				expect(textContent.text).toContain("openai");
				expect(textContent.text).toContain("gpt-image-1");
				expect(textContent.text).toContain("Generated 1 image");

				// Verify details
				expect(result.details).toBeDefined();
				expect(result.details!.provider).toBe("openai");
				expect(result.details!.model).toBe("gpt-image-1");
				expect(result.details!.imageCount).toBe(1);
				expect(result.details!.imagePaths).toBeArray();
				expect(result.details!.imagePaths.length).toBe(1);
				expect(result.details!.images).toBeArray();
				expect(result.details!.images.length).toBe(1);

				// Verify the image is valid base64 PNG
				const image = result.details!.images[0];
				expect(image.mimeType).toBe("image/png");
				expect(image.data.length).toBeGreaterThan(1000); // At least 1KB of base64

				// Verify the decoded image starts with PNG magic bytes
				const buffer = Buffer.from(image.data, "base64");
				const pngMagic = buffer.subarray(0, 4).toString("hex");
				expect(pngMagic).toBe("89504e47"); // PNG header

				// Verify the temp file was created
				const savedPath = result.details!.imagePaths[0];
				const file = Bun.file(savedPath);
				expect(await file.exists()).toBe(true);
				expect(file.size).toBeGreaterThan(0);

				// Verify usage tracking
				if (result.details!.usage) {
					expect(result.details!.usage.promptTokenCount).toBeGreaterThan(0);
					expect(result.details!.usage.totalTokenCount).toBeGreaterThan(0);
				}

				console.log(`  Image saved: ${savedPath} (${buffer.length} bytes)`);
				console.log(
					`  Tokens: in=${result.details!.usage?.promptTokenCount}, out=${result.details!.usage?.candidatesTokenCount}`,
				);
			} finally {
				// Restore env
				if (originalProvider) process.env.OPENROUTER_API_KEY = originalProvider;
				if (originalGemini) process.env.GEMINI_API_KEY = originalGemini;
				if (originalGoogle) process.env.GOOGLE_API_KEY = originalGoogle;
			}
		}, 120_000); // 2 minute timeout for API call

		test("generate_image error message is clear when API fails", async () => {
			// Use a bad API key to test error handling
			const originalKey = process.env.LITELLM_API_KEY;
			const originalOpenAI = process.env.OPENAI_API_KEY;
			process.env.LITELLM_API_KEY = "sk-invalid-key-for-testing";
			delete process.env.OPENAI_API_KEY;
			delete process.env.OPENROUTER_API_KEY;
			delete process.env.GEMINI_API_KEY;
			delete process.env.GOOGLE_API_KEY;

			try {
				const params: GeminiImageParams = {
					subject: "test",
				};

				const mockCtx = {
					sessionManager: { getCwd: () => process.cwd() },
					modelRegistry: { getApiKeyForProvider: async () => null },
					model: undefined,
					isIdle: () => true,
					hasQueuedMessages: () => false,
					abort: () => {},
					settings: { get: () => undefined },
				} as unknown as CustomToolContext;

				await expect(geminiImageTool.execute("test-call-2", params, undefined, mockCtx)).rejects.toThrow(
					/OpenAI image request failed/,
				);
			} finally {
				if (originalKey) process.env.LITELLM_API_KEY = originalKey;
				if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI;
			}
		}, 30_000);
	});

	test("tool has correct metadata", () => {
		expect(geminiImageTool.name).toBe("generate_image");
		expect(geminiImageTool.label).toBe("GenerateImage");
		expect(geminiImageTool.description).toBeTruthy();
		expect(geminiImageTool.parameters).toBeDefined();
	});

	(hasApiKey ? describe : describe.skip)("generate→analyze chain", () => {
		test("generate_image result contains inspectable file path", async () => {
			const originalOR = process.env.OPENROUTER_API_KEY;
			const originalGem = process.env.GEMINI_API_KEY;
			const originalGoo = process.env.GOOGLE_API_KEY;
			delete process.env.OPENROUTER_API_KEY;
			delete process.env.GEMINI_API_KEY;
			delete process.env.GOOGLE_API_KEY;

			try {
				const params: GeminiImageParams = {
					subject: "A red triangle on white background",
					image_size: "1024x1024",
				};

				const mockCtx = {
					sessionManager: { getCwd: () => process.cwd() },
					modelRegistry: { getApiKeyForProvider: async () => null },
					model: undefined,
					isIdle: () => true,
					hasQueuedMessages: () => false,
					abort: () => {},
					settings: {
						get: (path: string) => {
							if (path === "providers.imageQuality") return "low";
							return undefined;
						},
					},
				} as unknown as CustomToolContext;

				const result = await geminiImageTool.execute("chain-test", params, undefined, mockCtx);

				// Verify the result text contains a file path that inspect_image can use
				const text = (result.content[0] as { type: "text"; text: string }).text;
				const pathMatch = text.match(/\/tmp\/xcsh-image-[^\s]+\.png/);
				expect(pathMatch).toBeTruthy();

				// Verify the file actually exists and is a valid PNG
				const imagePath = pathMatch![0];
				const file = Bun.file(imagePath);
				expect(await file.exists()).toBe(true);

				const bytes = await file.bytes();
				expect(bytes.length).toBeGreaterThan(100);
				// PNG magic bytes
				expect(bytes[0]).toBe(0x89);
				expect(bytes[1]).toBe(0x50);
				expect(bytes[2]).toBe(0x4e);
				expect(bytes[3]).toBe(0x47);

				console.log(`  Chain test: generated ${imagePath} (${bytes.length} bytes) — ready for inspect_image`);
			} finally {
				if (originalOR) process.env.OPENROUTER_API_KEY = originalOR;
				if (originalGem) process.env.GEMINI_API_KEY = originalGem;
				if (originalGoo) process.env.GOOGLE_API_KEY = originalGoo;
			}
		}, 120_000);
	});
});
