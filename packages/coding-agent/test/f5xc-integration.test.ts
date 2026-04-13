import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@f5xc-salesdemos/pi-utils";
import { _resetSettingsForTest, Settings } from "@f5xc-salesdemos/xcsh/config/settings";
import { executeBash } from "@f5xc-salesdemos/xcsh/exec/bash-executor";
import { ProfileService } from "@f5xc-salesdemos/xcsh/services/f5xc-profile";
import {
	TEST_F5XC_URL as TEST_URL,
	TEST_F5XC_TOKEN as TEST_TOKEN,
	TEST_F5XC_NAMESPACE as TEST_NAMESPACE,
	TEST_STAGING_URL,
	TEST_STAGING_TOKEN,
	TEST_STAGING_NAMESPACE,
} from "./f5xc-test-fixtures";

describe("F5XC authentication end-to-end integration", () => {
	let testDir: string;
	let f5xcConfigDir: string;
	let f5xcProfilesDir: string;
	let projectDir: string;
	let agentDir: string;

	beforeEach(async () => {
		_resetSettingsForTest();
		ProfileService._resetForTest();
		delete process.env.F5XC_API_URL;
		delete process.env.F5XC_API_TOKEN;
		delete process.env.F5XC_NAMESPACE;

		testDir = path.join(os.tmpdir(), "test-f5xc-e2e", Snowflake.next());
		f5xcConfigDir = path.join(testDir, "f5xc-config");
		f5xcProfilesDir = path.join(f5xcConfigDir, "profiles");
		projectDir = path.join(testDir, "project");
		agentDir = path.join(testDir, "agent");

		fs.mkdirSync(projectDir, { recursive: true });
		fs.mkdirSync(path.join(projectDir, ".xcsh"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		await Settings.init({ cwd: projectDir, agentDir, inMemory: true });
	});

	afterEach(() => {
		_resetSettingsForTest();
		ProfileService._resetForTest();
		delete process.env.F5XC_API_URL;
		delete process.env.F5XC_API_TOKEN;
		delete process.env.F5XC_NAMESPACE;
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	it("profile credentials are available in bash subprocess after loadActive", async () => {
		// Setup: create profile and active_profile
		fs.mkdirSync(f5xcProfilesDir, { recursive: true });
		fs.writeFileSync(
			path.join(f5xcProfilesDir, "production.json"),
			JSON.stringify({
				name: "production",
				apiUrl: TEST_URL,
				apiToken: TEST_TOKEN,
				defaultNamespace: TEST_NAMESPACE,
			}),
			{ mode: 0o600 },
		);
		fs.writeFileSync(path.join(f5xcConfigDir, "active_profile"), "production");

		// Load profile (simulates startup sequence)
		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		// Execute bash command — credentials should be in environment
		const urlResult = await executeBash("echo $F5XC_API_URL", {
			cwd: projectDir,
			timeout: 5000,
		});
		expect(urlResult.output.trim()).toBe(TEST_URL);

		const tokenResult = await executeBash("echo $F5XC_API_TOKEN", {
			cwd: projectDir,
			timeout: 5000,
		});
		expect(tokenResult.output.trim()).toBe(TEST_TOKEN);

		const nsResult = await executeBash("echo $F5XC_NAMESPACE", {
			cwd: projectDir,
			timeout: 5000,
		});
		expect(nsResult.output.trim()).toBe(TEST_NAMESPACE);
	});

	it("profile switch updates bash subprocess environment", async () => {
		// Setup: two profiles
		fs.mkdirSync(f5xcProfilesDir, { recursive: true });
		fs.writeFileSync(
			path.join(f5xcProfilesDir, "production.json"),
			JSON.stringify({
				name: "production",
				apiUrl: TEST_URL,
				apiToken: TEST_TOKEN,
				defaultNamespace: TEST_NAMESPACE,
			}),
			{ mode: 0o600 },
		);
		fs.writeFileSync(
			path.join(f5xcProfilesDir, "staging.json"),
			JSON.stringify({
				name: "staging",
				apiUrl: TEST_STAGING_URL,
				apiToken: TEST_STAGING_TOKEN,
				defaultNamespace: TEST_STAGING_NAMESPACE,
			}),
			{ mode: 0o600 },
		);
		fs.writeFileSync(path.join(f5xcConfigDir, "active_profile"), "production");

		// Load initial profile
		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		// Verify production is active
		const result1 = await executeBash("echo $F5XC_API_URL", {
			cwd: projectDir,
			timeout: 5000,
		});
		expect(result1.output.trim()).toBe(TEST_URL);

		// Switch to staging
		await service.activate("staging");

		// Verify staging is now active in bash env
		const result2 = await executeBash("echo $F5XC_API_URL", {
			cwd: projectDir,
			timeout: 5000,
		});
		expect(result2.output.trim()).toBe(TEST_STAGING_URL);
	});

	it("environment variables take precedence over profile", async () => {
		// Setup: profile exists
		fs.mkdirSync(f5xcProfilesDir, { recursive: true });
		fs.writeFileSync(
			path.join(f5xcProfilesDir, "production.json"),
			JSON.stringify({
				name: "production",
				apiUrl: TEST_URL,
				apiToken: TEST_TOKEN,
				defaultNamespace: TEST_NAMESPACE,
			}),
			{ mode: 0o600 },
		);
		fs.writeFileSync(path.join(f5xcConfigDir, "active_profile"), "production");

		// F5XC_API_URL alone is the signal to skip profile loading (FR-102)
		process.env.F5XC_API_URL = "https://env-override.console.ves.volterra.io";

		const service = ProfileService.init(f5xcConfigDir);
		const result = await service.loadActive();

		// Profile should NOT have been loaded
		expect(result).toBeNull();
		expect(service.getStatus().credentialSource).toBe("environment");

		// bash.environment should NOT contain profile credentials
		const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
		expect(bashEnv.F5XC_API_URL).toBeUndefined();
	});

	it("gracefully handles missing config directory at startup", async () => {
		// No f5xc config directory exists
		const service = ProfileService.init(f5xcConfigDir);
		const result = await service.loadActive();

		expect(result).toBeNull();

		// Bash should still work normally
		const bashResult = await executeBash("echo works", {
			cwd: projectDir,
			timeout: 5000,
		});
		expect(bashResult.output.trim()).toBe("works");
	});

	it("auto-activates single profile when no active_profile file exists", async () => {
		// Setup: one profile, no active_profile
		fs.mkdirSync(f5xcProfilesDir, { recursive: true });
		fs.writeFileSync(
			path.join(f5xcProfilesDir, "production.json"),
			JSON.stringify({
				name: "production",
				apiUrl: TEST_URL,
				apiToken: TEST_TOKEN,
				defaultNamespace: TEST_NAMESPACE,
			}),
			{ mode: 0o600 },
		);
		// No active_profile file

		const service = ProfileService.init(f5xcConfigDir);
		const result = await service.loadActive();

		expect(result).not.toBeNull();
		expect(result?.name).toBe("production");

		// Should have created active_profile file
		const activeProfileContent = fs.readFileSync(
			path.join(f5xcConfigDir, "active_profile"),
			"utf-8",
		);
		expect(activeProfileContent).toBe("production");

		// Credentials should be in bash environment
		const bashResult = await executeBash("echo $F5XC_API_URL", {
			cwd: projectDir,
			timeout: 5000,
		});
		expect(bashResult.output.trim()).toBe(TEST_URL);
	});

	it("T-005: active_profile references missing JSON — no credentials injected", async () => {
		fs.mkdirSync(f5xcConfigDir, { recursive: true });
		// active_profile points to a profile JSON that doesn't exist
		fs.writeFileSync(path.join(f5xcConfigDir, "active_profile"), "vanished");

		const service = ProfileService.init(f5xcConfigDir);
		const result = await service.loadActive();
		expect(result).toBeNull();
		expect(service.getStatus().credentialSource).toBe("none");

		// bash.environment should NOT contain any F5XC vars
		const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
		expect(bashEnv.F5XC_API_URL).toBeUndefined();
		expect(bashEnv.F5XC_API_TOKEN).toBeUndefined();

		// Normal bash commands still work
		const echoResult = await executeBash("echo works", {
			cwd: projectDir,
			timeout: 5000,
		});
		expect(echoResult.output.trim()).toBe("works");
	});

	it("T-014: active_profile file is plain text with no trailing newline", async () => {
		// Setup: single profile triggers auto-activation
		fs.mkdirSync(f5xcProfilesDir, { recursive: true });
		fs.writeFileSync(
			path.join(f5xcProfilesDir, "production.json"),
			JSON.stringify({
				name: "production",
				apiUrl: TEST_URL,
				apiToken: TEST_TOKEN,
				defaultNamespace: TEST_NAMESPACE,
			}),
			{ mode: 0o600 },
		);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive(); // auto-activates

		// Read raw bytes — no newline allowed (VS Code extension compatibility)
		const raw = fs.readFileSync(path.join(f5xcConfigDir, "active_profile"));
		const text = raw.toString("utf-8");
		expect(text).toBe("production");
		expect(text).not.toContain("\n");
		expect(text).not.toContain("\r");
	});

	it("per-field env override: F5XC_API_TOKEN from env, URL from profile in bash.environment", async () => {
		process.env.F5XC_API_TOKEN = "env-override-token";
		// F5XC_API_URL is NOT set — profile loads

		fs.mkdirSync(f5xcProfilesDir, { recursive: true });
		fs.writeFileSync(
			path.join(f5xcProfilesDir, "production.json"),
			JSON.stringify({
				name: "production",
				apiUrl: TEST_URL,
				apiToken: TEST_TOKEN,
				defaultNamespace: TEST_NAMESPACE,
			}),
			{ mode: 0o600 },
		);
		fs.writeFileSync(path.join(f5xcConfigDir, "active_profile"), "production");

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		// URL should be injected into bash.environment from profile
		const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
		expect(bashEnv.F5XC_API_URL).toBe(TEST_URL);
		// Token should NOT be in bash.environment (it's in process.env)
		expect(bashEnv.F5XC_API_TOKEN).toBeUndefined();
		// Namespace should be injected from profile
		expect(bashEnv.F5XC_NAMESPACE).toBe(TEST_NAMESPACE);

		// Verify URL is available in bash subprocess (from bash.environment)
		const urlResult = await executeBash("echo $F5XC_API_URL", {
			cwd: projectDir,
			timeout: 5000,
		});
		expect(urlResult.output.trim()).toBe(TEST_URL);
	});

	it("create then activate then verify credentials in bash subprocess", async () => {
		const service = ProfileService.init(f5xcConfigDir);
		await service.createProfile({
			name: "created-prof",
			apiUrl: TEST_URL,
			apiToken: TEST_TOKEN,
			defaultNamespace: TEST_NAMESPACE,
		});

		await service.activate("created-prof");

		const result = await executeBash("echo $F5XC_API_URL", {
			cwd: projectDir,
			timeout: 5000,
		});
		expect(result.output.trim()).toBe(TEST_URL);
	});

	it("special characters in env values do not break bash", async () => {
		const specialUrl = "https://test.console.ves.volterra.io/api?a=1&b=2";
		fs.mkdirSync(f5xcProfilesDir, { recursive: true });
		fs.writeFileSync(
			path.join(f5xcProfilesDir, "special.json"),
			JSON.stringify({
				name: "special",
				apiUrl: specialUrl,
				apiToken: "tok-with=equals&amps",
				defaultNamespace: "ns with spaces",
			}),
			{ mode: 0o600 },
		);
		fs.writeFileSync(path.join(f5xcConfigDir, "active_profile"), "special");

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const result = await executeBash('echo "$F5XC_API_URL"', {
			cwd: projectDir,
			timeout: 5000,
		});
		expect(result.output.trim()).toBe(specialUrl);
	});

	it("token masking never exposes full token", async () => {
		fs.mkdirSync(f5xcProfilesDir, { recursive: true });
		fs.writeFileSync(
			path.join(f5xcProfilesDir, "production.json"),
			JSON.stringify({
				name: "production",
				apiUrl: TEST_URL,
				apiToken: TEST_TOKEN,
				defaultNamespace: TEST_NAMESPACE,
			}),
			{ mode: 0o600 },
		);
		fs.writeFileSync(path.join(f5xcConfigDir, "active_profile"), "production");

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const masked = service.maskToken(TEST_TOKEN);
		expect(masked).toBe(`...${TEST_TOKEN.slice(-4)}`);
		expect(masked).not.toBe(TEST_TOKEN);
		expect(masked.length).toBeLessThan(TEST_TOKEN.length);
	});
});
