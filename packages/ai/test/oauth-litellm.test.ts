import { describe, expect, it } from "bun:test";
import { loginLiteLLM, maskApiKey } from "../src/utils/oauth/litellm";

describe("loginLiteLLM", () => {
	it("returns baseUrl and apiKey from sequential prompts", async () => {
		const prompts: Array<{ message: string; placeholder?: string }> = [];

		const result = await loginLiteLLM({
			onPrompt: async prompt => {
				prompts.push(prompt);
				if (prompts.length === 1) return "https://my-litellm.example.com";
				return "sk-my-api-key";
			},
		});

		expect(prompts).toHaveLength(2);
		expect(prompts[0].message).toContain("Base URL");
		expect(prompts[1].message).toContain("API Key");
		expect(result.baseUrl).toBe("https://my-litellm.example.com");
		expect(result.apiKey).toBe("sk-my-api-key");
	});

	it("uses default values when user submits empty input", async () => {
		const result = await loginLiteLLM({
			onPrompt: async () => "",
			defaults: {
				baseUrl: "https://default.example.com",
				apiKey: "sk-default-key",
			},
		});

		expect(result.baseUrl).toBe("https://default.example.com");
		expect(result.apiKey).toBe("sk-default-key");
	});

	it("trims whitespace from inputs", async () => {
		let callCount = 0;
		const result = await loginLiteLLM({
			onPrompt: async () => {
				callCount++;
				if (callCount === 1) return "  https://trimmed.example.com  ";
				return "  sk-trimmed-key  ";
			},
		});

		expect(result.baseUrl).toBe("https://trimmed.example.com");
		expect(result.apiKey).toBe("sk-trimmed-key");
	});

	it("strips trailing slash from base URL", async () => {
		let callCount = 0;
		const result = await loginLiteLLM({
			onPrompt: async () => {
				callCount++;
				if (callCount === 1) return "https://my-proxy.example.com///";
				return "sk-key";
			},
		});

		expect(result.baseUrl).toBe("https://my-proxy.example.com");
	});

	it("throws 'Base URL is required' when empty and no default", async () => {
		await expect(
			loginLiteLLM({
				onPrompt: async () => "",
			}),
		).rejects.toThrow("Base URL is required");
	});

	it("throws 'API key is required' when empty and no default", async () => {
		let callCount = 0;
		await expect(
			loginLiteLLM({
				onPrompt: async () => {
					callCount++;
					if (callCount === 1) return "https://my-litellm.example.com";
					return "";
				},
			}),
		).rejects.toThrow("API key is required");
	});

	it("throws 'Login cancelled' on abort signal", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			loginLiteLLM({
				signal: controller.signal,
				onPrompt: async () => "anything",
			}),
		).rejects.toThrow("Login cancelled");
	});
});

describe("maskApiKey", () => {
	it("masks keys longer than 8 chars", () => {
		expect(maskApiKey("sk-abcdefghij")).toBe("sk-****ghij");
	});

	it("returns **** when shorter than 8 chars", () => {
		expect(maskApiKey("short")).toBe("****");
	});

	it("returns empty string for undefined", () => {
		expect(maskApiKey(undefined)).toBe("");
	});
});
