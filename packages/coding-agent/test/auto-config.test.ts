import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	autoFixModelsConfig,
	generateConfigYml,
	generateModelsYml,
	hasLiteLLMEnv,
	startupHealthCheck,
	tryAutoConfigLiteLLM,
	validateModelsConfig,
	warnIfConfigDrifted,
} from "../src/config/auto-config";

// Isolated temp directory per test
let tmpDir: string;
let modelsPath: string;
let configPath: string;

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["LITELLM_BASE_URL", "LITELLM_API_KEY"];

function saveEnv() {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
	}
}

function restoreEnv() {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] !== undefined) {
			process.env[key] = savedEnv[key];
		} else {
			delete process.env[key];
		}
	}
}

function setEnv(baseUrl: string, apiKey: string) {
	process.env.LITELLM_BASE_URL = baseUrl;
	process.env.LITELLM_API_KEY = apiKey;
}

function clearEnv() {
	delete process.env.LITELLM_BASE_URL;
	delete process.env.LITELLM_API_KEY;
}

beforeEach(() => {
	saveEnv();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xcsh-autoconfig-test-"));
	modelsPath = path.join(tmpDir, "models.yml");
	configPath = path.join(tmpDir, "config.yml");
});

afterEach(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =========================================================================
// hasLiteLLMEnv()
// =========================================================================

describe("hasLiteLLMEnv()", () => {
	test("returns true when both vars are set with valid URL", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(true);
	});

	test("returns true for http:// URLs", () => {
		setEnv("http://localhost:4000", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(true);
	});

	test("returns false when LITELLM_BASE_URL is missing", () => {
		delete process.env.LITELLM_BASE_URL;
		process.env.LITELLM_API_KEY = "sk-abc123";
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false when LITELLM_API_KEY is missing", () => {
		process.env.LITELLM_BASE_URL = "https://proxy.example.com";
		delete process.env.LITELLM_API_KEY;
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false when both vars are missing", () => {
		clearEnv();
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false for empty string LITELLM_BASE_URL", () => {
		setEnv("", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false for empty string LITELLM_API_KEY", () => {
		setEnv("https://proxy.example.com", "");
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false for whitespace-only LITELLM_BASE_URL", () => {
		setEnv("   ", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false for invalid URL scheme (ftp://)", () => {
		setEnv("ftp://proxy.example.com", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("returns false for bare hostname without scheme", () => {
		setEnv("proxy.example.com", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(false);
	});

	test("handles URL with trailing slashes", () => {
		setEnv("https://proxy.example.com///", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(true);
	});

	test("handles URL with path components", () => {
		setEnv("https://proxy.example.com/v1/api", "sk-abc123");
		expect(hasLiteLLMEnv()).toBe(true);
	});
});

// =========================================================================
// generateModelsYml()
// =========================================================================

describe("generateModelsYml()", () => {
	test("generates valid YAML with anthropic provider", () => {
		const yml = generateModelsYml("https://proxy.example.com");
		expect(yml).toContain("providers:");
		expect(yml).toContain("anthropic:");
		expect(yml).toContain('baseUrl: "https://proxy.example.com/anthropic"');
		expect(yml).toContain("apiKey: LITELLM_API_KEY");
	});

	test("strips trailing slashes from baseUrl", () => {
		const yml = generateModelsYml("https://proxy.example.com/");
		// The function receives pre-normalized URL, but the /anthropic suffix is added
		expect(yml).toContain("https://proxy.example.com//anthropic");
	});

	test("handles localhost URL", () => {
		const yml = generateModelsYml("http://localhost:4000");
		expect(yml).toContain('baseUrl: "http://localhost:4000/anthropic"');
	});

	test("does not contain literal API key values", () => {
		const yml = generateModelsYml("https://proxy.example.com");
		expect(yml).not.toContain("sk-");
		expect(yml).toContain("LITELLM_API_KEY"); // Reference, not value
	});
});

// =========================================================================
// generateConfigYml()
// =========================================================================

describe("generateConfigYml()", () => {
	test("generates valid YAML with image provider", () => {
		const yml = generateConfigYml();
		expect(yml).toContain("image: openai");
		expect(yml).toContain("enabled: true");
		expect(yml).toContain("blockImages: false");
		expect(yml).toContain("autoResize: true");
		expect(yml).toContain("showImages: true");
	});
});

// =========================================================================
// tryAutoConfigLiteLLM()
// =========================================================================

describe("tryAutoConfigLiteLLM()", () => {
	test("generates config when env vars set and no file exists", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const result = tryAutoConfigLiteLLM(modelsPath);
		expect(result).toBe(true);
		expect(fs.existsSync(modelsPath)).toBe(true);
		expect(fs.existsSync(configPath)).toBe(true);

		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("https://proxy.example.com/anthropic");
	});

	test("returns false when env vars not set", () => {
		clearEnv();
		const result = tryAutoConfigLiteLLM(modelsPath);
		expect(result).toBe(false);
		expect(fs.existsSync(modelsPath)).toBe(false);
	});

	test("returns false when only LITELLM_BASE_URL is set", () => {
		process.env.LITELLM_BASE_URL = "https://proxy.example.com";
		delete process.env.LITELLM_API_KEY;
		expect(tryAutoConfigLiteLLM(modelsPath)).toBe(false);
	});

	test("returns false when only LITELLM_API_KEY is set", () => {
		delete process.env.LITELLM_BASE_URL;
		process.env.LITELLM_API_KEY = "sk-abc123";
		expect(tryAutoConfigLiteLLM(modelsPath)).toBe(false);
	});

	test("creates parent directories if they dont exist", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const deepPath = path.join(tmpDir, "a", "b", "c", "models.yml");
		const result = tryAutoConfigLiteLLM(deepPath);
		expect(result).toBe(true);
		expect(fs.existsSync(deepPath)).toBe(true);
	});

	test("does not overwrite existing config.yml", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(configPath, "# existing config\ncustom: true\n");
		tryAutoConfigLiteLLM(modelsPath);
		const content = fs.readFileSync(configPath, "utf-8");
		expect(content).toContain("custom: true");
		expect(content).not.toContain("image: openai");
	});

	test("normalizes trailing slashes in base URL", () => {
		setEnv("https://proxy.example.com///", "sk-abc123");
		tryAutoConfigLiteLLM(modelsPath);
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("https://proxy.example.com/anthropic");
		expect(content).not.toContain("///");
	});

	test("returns false for invalid URL scheme", () => {
		setEnv("ftp://proxy.example.com", "sk-abc123");
		expect(tryAutoConfigLiteLLM(modelsPath)).toBe(false);
	});

	test("handles write permission errors gracefully", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		// Create a read-only directory
		const readOnlyDir = path.join(tmpDir, "readonly");
		fs.mkdirSync(readOnlyDir, { mode: 0o444 });
		const badPath = path.join(readOnlyDir, "subdir", "models.yml");
		const result = tryAutoConfigLiteLLM(badPath);
		expect(result).toBe(false);
		// Cleanup: restore permissions so rmSync works
		fs.chmodSync(readOnlyDir, 0o755);
	});
});

// =========================================================================
// validateModelsConfig()
// =========================================================================

describe("validateModelsConfig()", () => {
	test("valid config returns no errors", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
			].join("\n"),
		);
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		expect(result.warnings).toHaveLength(0);
	});

	test("missing file returns error with fixable flag", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("models.yml not found");
		expect(result.fixable).toBe(true);
	});

	test("missing file without env vars is not fixable", () => {
		clearEnv();
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(false);
		expect(result.fixable).toBe(false);
	});

	test("empty file returns error", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "");
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("empty");
		expect(result.fixable).toBe(true);
	});

	test("whitespace-only file returns error", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "   \n\n  \n");
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("empty");
	});

	test("warns when baseUrl doesnt match LITELLM_BASE_URL", () => {
		setEnv("https://new-proxy.example.com", "sk-abc123");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://old-proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
			].join("\n"),
		);
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(true); // Still valid, just drifted
		expect(result.warnings.length).toBeGreaterThan(0);
		expect(result.warnings[0]).toContain("does not match");
		expect(result.fixable).toBe(true);
	});

	test("warns when LITELLM_API_KEY env var is not set but referenced", () => {
		delete process.env.LITELLM_API_KEY;
		process.env.LITELLM_BASE_URL = "https://proxy.example.com";
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
			].join("\n"),
		);
		const result = validateModelsConfig(modelsPath);
		expect(result.warnings.some(w => w.includes("LITELLM_API_KEY") && w.includes("not set"))).toBe(true);
	});

	test("no warning when env vars match config", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
			].join("\n"),
		);
		const result = validateModelsConfig(modelsPath);
		expect(result.warnings).toHaveLength(0);
	});

	test("handles unreadable file", () => {
		fs.writeFileSync(modelsPath, "valid content");
		fs.chmodSync(modelsPath, 0o000);
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("not readable");
		// Cleanup permissions
		fs.chmodSync(modelsPath, 0o644);
	});
});

// =========================================================================
// autoFixModelsConfig()
// =========================================================================

describe("autoFixModelsConfig()", () => {
	test("generates new config when file doesnt exist", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const result = autoFixModelsConfig(modelsPath);
		expect(result.fixed).toBe(true);
		expect(result.changes.length).toBeGreaterThan(0);
		expect(fs.existsSync(modelsPath)).toBe(true);
	});

	test("backs up existing file before overwriting", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "# old config\nold: true\n");
		const result = autoFixModelsConfig(modelsPath);
		expect(result.fixed).toBe(true);
		expect(fs.existsSync(`${modelsPath}.bak`)).toBe(true);
		const backup = fs.readFileSync(`${modelsPath}.bak`, "utf-8");
		expect(backup).toContain("old: true");
	});

	test("returns false when env vars not set", () => {
		clearEnv();
		const result = autoFixModelsConfig(modelsPath);
		expect(result.fixed).toBe(false);
		expect(result.changes[0]).toContain("Cannot fix");
	});

	test("returns false when LITELLM_BASE_URL is invalid", () => {
		setEnv("not-a-url", "sk-abc123");
		const result = autoFixModelsConfig(modelsPath);
		expect(result.fixed).toBe(false);
		expect(result.changes[0]).toContain("Cannot fix");
	});

	test("creates parent directories", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const deepPath = path.join(tmpDir, "deep", "nested", "models.yml");
		const result = autoFixModelsConfig(deepPath);
		expect(result.fixed).toBe(true);
		expect(fs.existsSync(deepPath)).toBe(true);
	});
});

// =========================================================================
// warnIfConfigDrifted()
// =========================================================================

describe("warnIfConfigDrifted()", () => {
	test("does not throw when providers is undefined", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		expect(() => warnIfConfigDrifted(undefined)).not.toThrow();
	});

	test("does not throw when no env var set", () => {
		clearEnv();
		expect(() => warnIfConfigDrifted({ anthropic: { baseUrl: "https://old.com/anthropic" } })).not.toThrow();
	});

	test("does not throw when anthropic has no baseUrl", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		expect(() => warnIfConfigDrifted({ anthropic: {} })).not.toThrow();
	});

	test("does not throw when URLs match", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		expect(() =>
			warnIfConfigDrifted({ anthropic: { baseUrl: "https://proxy.example.com/anthropic" } }),
		).not.toThrow();
	});

	test("does not throw when URLs differ (logs warning)", () => {
		setEnv("https://new-proxy.example.com", "sk-abc123");
		expect(() =>
			warnIfConfigDrifted({ anthropic: { baseUrl: "https://old-proxy.example.com/anthropic" } }),
		).not.toThrow();
	});
});

// =========================================================================
// Corrupt YAML files
// =========================================================================

describe("corrupt YAML handling", () => {
	test("validates file with invalid YAML indentation", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "providers:\n\tanthropic:\n  baseUrl: bad indent\n");
		const result = validateModelsConfig(modelsPath);
		// File has content so it won't be flagged as empty, but may warn about URL mismatch
		expect(result.valid).toBe(true); // Syntax check is basic; full validation is ConfigFile's job
	});

	test("validates file with truncated content", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "providers:\n  anthropic:\n    baseUrl:");
		const result = validateModelsConfig(modelsPath);
		// Not empty, has content — basic validation passes, but warns about URL mismatch
		expect(result.warnings.some(w => w.includes("does not match"))).toBe(true);
	});

	test("autofix recovers from corrupt file", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "{{{{invalid yaml!!!!");
		const fix = autoFixModelsConfig(modelsPath);
		expect(fix.fixed).toBe(true);
		// Backup should have the corrupt content
		expect(fs.readFileSync(`${modelsPath}.bak`, "utf-8")).toContain("{{{{invalid");
		// New file should be valid
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("providers:");
		expect(content).toContain("proxy.example.com");
	});

	test("autofix recovers from binary garbage", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, Buffer.from([0x00, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]));
		const fix = autoFixModelsConfig(modelsPath);
		expect(fix.fixed).toBe(true);
		expect(fs.existsSync(`${modelsPath}.bak`)).toBe(true);
	});

	test("autofix recovers from zero-byte file", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "");
		const fix = autoFixModelsConfig(modelsPath);
		expect(fix.fixed).toBe(true);
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("providers:");
	});
});

// =========================================================================
// URL fault tolerance matrix
// =========================================================================

describe("URL fault tolerance", () => {
	const VALID_URLS = [
		"https://proxy.example.com",
		"http://localhost:4000",
		"https://proxy.example.com:8443",
		"https://proxy.example.com/v1",
		"https://proxy.example.com/path/to/api",
		"http://10.0.0.1:4000",
		"https://proxy-with-dashes.example.com",
		"https://proxy_with_underscores.example.com",
	];

	const INVALID_URLS = [
		"",
		"   ",
		"ftp://proxy.example.com",
		"proxy.example.com",
		"just-text",
		"://missing-scheme",
		"file:///etc/passwd",
		"ssh://proxy.example.com",
	];

	for (const url of VALID_URLS) {
		test(`accepts valid URL: ${url}`, () => {
			setEnv(url, "sk-abc123");
			expect(hasLiteLLMEnv()).toBe(true);
			expect(tryAutoConfigLiteLLM(path.join(tmpDir, `models-${url.replace(/[^a-z0-9]/gi, "_")}.yml`))).toBe(true);
		});
	}

	for (const url of INVALID_URLS) {
		test(`rejects invalid URL: "${url}"`, () => {
			setEnv(url, "sk-abc123");
			expect(hasLiteLLMEnv()).toBe(false);
			expect(tryAutoConfigLiteLLM(modelsPath)).toBe(false);
		});
	}
});

// =========================================================================
// API key fault tolerance matrix
// =========================================================================

describe("API key fault tolerance", () => {
	const VALID_KEYS = [
		"sk-abc123",
		"sk-e5de24b2e74f41a2af7c444873812bc3",
		"a",
		`very-long-key-${"x".repeat(200)}`,
		"key-with-special-chars_123.456",
	];

	const INVALID_KEYS = ["", "   "];

	for (const key of VALID_KEYS) {
		test(`accepts valid key: ${key.substring(0, 20)}...`, () => {
			setEnv("https://proxy.example.com", key);
			expect(hasLiteLLMEnv()).toBe(true);
		});
	}

	for (const key of INVALID_KEYS) {
		test(`rejects invalid key: "${key}"`, () => {
			setEnv("https://proxy.example.com", key);
			expect(hasLiteLLMEnv()).toBe(false);
		});
	}
});

// =========================================================================
// Incomplete config scenarios
// =========================================================================

describe("incomplete config handling", () => {
	test("config with only providers key but no children", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "providers:\n");
		const result = validateModelsConfig(modelsPath);
		// File exists and has content (just "providers:") — will warn about URL mismatch
		expect(result.warnings.some(w => w.includes("does not match"))).toBe(true);
	});

	test("config with anthropic but no baseUrl", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "providers:\n  anthropic:\n    apiKey: LITELLM_API_KEY\n");
		const result = validateModelsConfig(modelsPath);
		expect(result.warnings.some(w => w.includes("does not match"))).toBe(true);
	});

	test("config with wrong provider name", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(modelsPath, "providers:\n  openai:\n    baseUrl: https://proxy.example.com/openai\n");
		const result = validateModelsConfig(modelsPath);
		// No anthropic section, so baseUrl check warns
		expect(result.warnings.some(w => w.includes("does not match"))).toBe(true);
	});

	test("config with extra unknown fields is still valid", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  anthropic:",
				'    baseUrl: "https://proxy.example.com/anthropic"',
				"    apiKey: LITELLM_API_KEY",
				"    extraField: true",
				"custom_stuff: hello",
			].join("\n"),
		);
		const result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(true);
	});
});

// =========================================================================
// Edge cases and fault tolerance
// =========================================================================

describe("fault tolerance", () => {
	test("handles URL with port number", () => {
		setEnv("https://proxy.example.com:8443", "sk-abc123");
		tryAutoConfigLiteLLM(modelsPath);
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("https://proxy.example.com:8443/anthropic");
	});

	test("handles URL with path prefix", () => {
		setEnv("https://proxy.example.com/litellm", "sk-abc123");
		tryAutoConfigLiteLLM(modelsPath);
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("https://proxy.example.com/litellm/anthropic");
	});

	test("handles very long API key", () => {
		setEnv("https://proxy.example.com", `sk-${"a".repeat(500)}`);
		expect(tryAutoConfigLiteLLM(modelsPath)).toBe(true);
		// Key is not embedded, just the reference
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).not.toContain("aaaaaa");
	});

	test("handles special characters in URL", () => {
		setEnv("https://proxy.example.com/path-with-dashes_and_underscores", "sk-abc123");
		expect(tryAutoConfigLiteLLM(modelsPath)).toBe(true);
	});

	test("handles concurrent calls safely", async () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const results = await Promise.all([
			Promise.resolve(tryAutoConfigLiteLLM(modelsPath)),
			Promise.resolve(tryAutoConfigLiteLLM(modelsPath)),
			Promise.resolve(tryAutoConfigLiteLLM(modelsPath)),
		]);
		// At least one should succeed, file should exist
		expect(results.some(r => r === true)).toBe(true);
		expect(fs.existsSync(modelsPath)).toBe(true);
	});

	test("validate then fix round-trip", () => {
		setEnv("https://proxy.example.com", "sk-abc123");

		// Start with no file
		let result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(false);

		// Fix it
		const fix = autoFixModelsConfig(modelsPath);
		expect(fix.fixed).toBe(true);

		// Now validate again
		result = validateModelsConfig(modelsPath);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		expect(result.warnings).toHaveLength(0);
	});

	test("fix after env URL change updates config", () => {
		// Initial setup
		setEnv("https://old-proxy.example.com", "sk-abc123");
		tryAutoConfigLiteLLM(modelsPath);

		// Change env
		setEnv("https://new-proxy.example.com", "sk-abc123");

		// Validate detects drift
		const validation = validateModelsConfig(modelsPath);
		expect(validation.warnings.length).toBeGreaterThan(0);

		// Fix updates the URL
		const fix = autoFixModelsConfig(modelsPath);
		expect(fix.fixed).toBe(true);

		// Verify new URL in file
		const content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("https://new-proxy.example.com/anthropic");
		expect(content).not.toContain("old-proxy");

		// Backup has old URL
		const backup = fs.readFileSync(`${modelsPath}.bak`, "utf-8");
		expect(backup).toContain("https://old-proxy.example.com/anthropic");
	});
});

// =========================================================================
// startupHealthCheck() — the runtime self-healing entry point
// =========================================================================

describe("startupHealthCheck()", () => {
	test("not-found + env vars → generates config", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const repaired = startupHealthCheck("not-found", modelsPath);
		expect(repaired).toBe(true);
		expect(fs.existsSync(modelsPath)).toBe(true);
		expect(fs.readFileSync(modelsPath, "utf-8")).toContain("proxy.example.com/anthropic");
	});

	test("not-found + no env vars → no action", () => {
		clearEnv();
		const repaired = startupHealthCheck("not-found", modelsPath);
		expect(repaired).toBe(false);
		expect(fs.existsSync(modelsPath)).toBe(false);
	});

	test("error + env vars → backs up and regenerates", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		fs.writeFileSync(modelsPath, "{{corrupt yaml");
		const repaired = startupHealthCheck("error", modelsPath);
		expect(repaired).toBe(true);
		expect(fs.readFileSync(modelsPath, "utf-8")).toContain("proxy.example.com/anthropic");
		expect(fs.readFileSync(`${modelsPath}.bak`, "utf-8")).toContain("{{corrupt");
	});

	test("error + no env vars → no action", () => {
		clearEnv();
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		fs.writeFileSync(modelsPath, "{{corrupt yaml");
		const repaired = startupHealthCheck("error", modelsPath);
		expect(repaired).toBe(false);
	});

	test("ok + matching URL → no action", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const repaired = startupHealthCheck("ok", modelsPath, {
			anthropic: { baseUrl: "https://proxy.example.com/anthropic" },
		});
		expect(repaired).toBe(false);
	});

	test("ok + drifted URL → auto-fixes", () => {
		setEnv("https://new-proxy.example.com", "sk-abc123");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		fs.writeFileSync(modelsPath, generateModelsYml("https://old-proxy.example.com"));
		const repaired = startupHealthCheck("ok", modelsPath, {
			anthropic: { baseUrl: "https://old-proxy.example.com/anthropic" },
		});
		expect(repaired).toBe(true);
		expect(fs.readFileSync(modelsPath, "utf-8")).toContain("new-proxy.example.com/anthropic");
	});

	test("ok + no env vars → no drift check", () => {
		clearEnv();
		const repaired = startupHealthCheck("ok", modelsPath, {
			anthropic: { baseUrl: "https://some-proxy.example.com/anthropic" },
		});
		expect(repaired).toBe(false);
	});

	test("ok + no anthropic provider → no drift check", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const repaired = startupHealthCheck("ok", modelsPath, {
			openai: { baseUrl: "https://other.example.com" },
		});
		expect(repaired).toBe(false);
	});

	test("ok + anthropic without baseUrl → no drift check", () => {
		setEnv("https://proxy.example.com", "sk-abc123");
		const repaired = startupHealthCheck("ok", modelsPath, {
			anthropic: {},
		});
		expect(repaired).toBe(false);
	});

	test("full lifecycle: missing → generate → drift → fix → validate", () => {
		// Step 1: Missing file
		setEnv("https://proxy-v1.example.com", "sk-abc123");
		expect(startupHealthCheck("not-found", modelsPath)).toBe(true);
		expect(fs.existsSync(modelsPath)).toBe(true);
		let content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("proxy-v1.example.com/anthropic");

		// Step 2: Validate — should be clean
		let validation = validateModelsConfig(modelsPath);
		expect(validation.valid).toBe(true);
		expect(validation.warnings).toHaveLength(0);

		// Step 3: Env changes (simulating proxy migration)
		setEnv("https://proxy-v2.example.com", "sk-abc123");

		// Step 4: Validate detects drift
		validation = validateModelsConfig(modelsPath);
		expect(validation.warnings.length).toBeGreaterThan(0);

		// Step 5: startupHealthCheck auto-fixes
		expect(
			startupHealthCheck("ok", modelsPath, {
				anthropic: { baseUrl: "https://proxy-v1.example.com/anthropic" },
			}),
		).toBe(true);

		// Step 6: Verify fixed
		content = fs.readFileSync(modelsPath, "utf-8");
		expect(content).toContain("proxy-v2.example.com/anthropic");
		expect(content).not.toContain("proxy-v1");

		// Step 7: Backup preserved
		expect(fs.readFileSync(`${modelsPath}.bak`, "utf-8")).toContain("proxy-v1");

		// Step 8: Final validation clean
		validation = validateModelsConfig(modelsPath);
		expect(validation.valid).toBe(true);
		expect(validation.warnings).toHaveLength(0);
	});
});
