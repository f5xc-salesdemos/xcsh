import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readLiteLLMConfig } from "../src/config/auto-config";

let tmpDir: string;
let modelsPath: string;

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["LITELLM_BASE_URL", "LITELLM_API_KEY"];

beforeEach(() => {
	// Save and unset env vars — this container has them set
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xcsh-autoconfig-read-test-"));
	modelsPath = path.join(tmpDir, "models.yml");
});

afterEach(() => {
	// Restore env vars
	for (const key of ENV_KEYS) {
		if (savedEnv[key] !== undefined) {
			process.env[key] = savedEnv[key];
		} else {
			delete process.env[key];
		}
	}
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readLiteLLMConfig", () => {
	test("returns undefined when models.yml does not exist", () => {
		const result = readLiteLLMConfig(modelsPath);
		expect(result).toBeUndefined();
	});

	test("extracts base URL and API key from valid models.yml", () => {
		const yml = [
			"configVersion: 2",
			"providers:",
			"  anthropic:",
			'    baseUrl: "https://proxy.example.com/anthropic"',
			"    apiKey: my-literal-key",
			"  litellm:",
			'    baseUrl: "https://proxy.example.com/v1"',
			"    apiKey: LITELLM_API_KEY",
			"",
		].join("\n");
		fs.writeFileSync(modelsPath, yml);

		const result = readLiteLLMConfig(modelsPath);
		expect(result).not.toBeUndefined();
		expect(result?.baseUrl).toBe("https://proxy.example.com");
		expect(result?.apiKey).toBe("my-literal-key");
	});

	test("strips /anthropic suffix from base URL", () => {
		const yml = [
			"configVersion: 2",
			"providers:",
			"  anthropic:",
			'    baseUrl: "https://myproxy.internal/anthropic"',
			"    apiKey: some-literal-key",
			"",
		].join("\n");
		fs.writeFileSync(modelsPath, yml);

		const result = readLiteLLMConfig(modelsPath);
		expect(result?.baseUrl).toBe("https://myproxy.internal");
	});

	test("resolves env var name (like LITELLM_API_KEY) to its value", () => {
		process.env.LITELLM_API_KEY = "resolved-secret-value";
		const yml = [
			"configVersion: 2",
			"providers:",
			"  anthropic:",
			'    baseUrl: "https://proxy.example.com/anthropic"',
			"    apiKey: LITELLM_API_KEY",
			"",
		].join("\n");
		fs.writeFileSync(modelsPath, yml);

		const result = readLiteLLMConfig(modelsPath);
		expect(result?.apiKey).toBe("resolved-secret-value");
	});

	test("returns literal apiKey when not an env var name", () => {
		const yml = [
			"configVersion: 2",
			"providers:",
			"  anthropic:",
			'    baseUrl: "https://proxy.example.com/anthropic"',
			"    apiKey: not-an-env-var",
			"",
		].join("\n");
		fs.writeFileSync(modelsPath, yml);

		const result = readLiteLLMConfig(modelsPath);
		expect(result?.apiKey).toBe("not-an-env-var");
	});
});
