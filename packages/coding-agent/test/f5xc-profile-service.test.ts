import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@f5xc-salesdemos/pi-utils";
import { _resetSettingsForTest, Settings } from "@f5xc-salesdemos/xcsh/config/settings";
import {
	type F5XCProfile,
	ProfileError,
	ProfileService,
} from "@f5xc-salesdemos/xcsh/services/f5xc-profile";
import {
	TEST_PROFILE as _TEST_PROFILE,
	TEST_PROFILE_STAGING as _TEST_PROFILE_STAGING,
	TEST_PROFILE_WITH_ENV as _TEST_PROFILE_WITH_ENV,
} from "./f5xc-test-fixtures";

const TEST_PROFILE: F5XCProfile = { ..._TEST_PROFILE };
const TEST_PROFILE_2: F5XCProfile = { ..._TEST_PROFILE_STAGING };
const TEST_PROFILE_ENV: F5XCProfile = { ..._TEST_PROFILE_WITH_ENV };

function writeProfile(profilesDir: string, profile: F5XCProfile): void {
	fs.mkdirSync(profilesDir, { recursive: true });
	fs.writeFileSync(
		path.join(profilesDir, `${profile.name}.json`),
		JSON.stringify(profile, null, 2),
		{ mode: 0o600 },
	);
}

function writeActiveProfile(configDir: string, name: string): void {
	fs.writeFileSync(path.join(configDir, "active_profile"), name, { mode: 0o644 });
}

describe("ProfileService", () => {
	let testDir: string;
	let f5xcConfigDir: string;
	let f5xcProfilesDir: string;
	let projectDir: string;
	let agentDir: string;

	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		_resetSettingsForTest();
		ProfileService._resetForTest();
		// Save and delete ALL F5XC_* env vars to prevent container env leakage
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("F5XC_")) {
				savedEnv[key] = process.env[key];
				delete process.env[key];
			}
		}

		testDir = path.join(os.tmpdir(), "test-f5xc-profile", Snowflake.next());
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
		// Restore ALL F5XC_* env vars
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("F5XC_")) delete process.env[key];
		}
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value !== undefined) process.env[key] = value;
		}
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	describe("loadActive", () => {
		it("returns null when config dir does not exist", async () => {
			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();
			expect(result).toBeNull();
		});

		it("returns null when active_profile file is missing", async () => {
			fs.mkdirSync(f5xcConfigDir, { recursive: true });
			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();
			expect(result).toBeNull();
		});

		it("returns profile when valid active_profile and JSON exist", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).not.toBeNull();
			expect(result?.name).toBe(TEST_PROFILE.name);
			expect(result?.apiUrl).toBe(TEST_PROFILE.apiUrl);
			expect(result?.apiToken).toBe(TEST_PROFILE.apiToken);
		});

		it("injects credentials into bash.environment settings override", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			await service.loadActive();

			const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
			expect(bashEnv.F5XC_API_URL).toBe(TEST_PROFILE.apiUrl);
			expect(bashEnv.F5XC_API_TOKEN).toBe(TEST_PROFILE.apiToken);
			expect(bashEnv.F5XC_NAMESPACE).toBe(TEST_PROFILE.defaultNamespace);
		});

		it("returns null when F5XC_API_URL is set (env override skips profile)", async () => {
			process.env.F5XC_API_URL = "https://env-override.console.ves.volterra.io";
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).toBeNull();
			expect(service.getStatus().credentialSource).toBe("environment");
		});

		it("loads profile values into bash.environment (env vars inherited separately via process.env)", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			await service.loadActive();

			const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
			expect(bashEnv.F5XC_API_URL).toBe(TEST_PROFILE.apiUrl);
			expect(bashEnv.F5XC_API_TOKEN).toBe(TEST_PROFILE.apiToken);
			expect(bashEnv.F5XC_NAMESPACE).toBe(TEST_PROFILE.defaultNamespace);
		});

		it("auto-activates the single profile when no active_profile exists", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			// No active_profile file

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).not.toBeNull();
			expect(result?.name).toBe(TEST_PROFILE.name);

			// Should have written active_profile
			const written = fs.readFileSync(path.join(f5xcConfigDir, "active_profile"), "utf-8");
			expect(written).toBe(TEST_PROFILE.name);
		});

		it("does not auto-activate when multiple profiles exist", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeProfile(f5xcProfilesDir, TEST_PROFILE_2);
			// No active_profile file

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).toBeNull();
		});

		it("returns null gracefully on invalid JSON", async () => {
			fs.mkdirSync(f5xcProfilesDir, { recursive: true });
			fs.writeFileSync(path.join(f5xcProfilesDir, "broken.json"), "not json{{{");
			writeActiveProfile(f5xcConfigDir, "broken");

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).toBeNull();
		});

		it("rejects profile with non-string field types", async () => {
			fs.mkdirSync(f5xcProfilesDir, { recursive: true });
			fs.writeFileSync(
				path.join(f5xcProfilesDir, "bad-types.json"),
				JSON.stringify({ apiUrl: 123, apiToken: true, defaultNamespace: {} }),
			);
			writeActiveProfile(f5xcConfigDir, "bad-types");

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).toBeNull();
		});

		it("uses filename as profile name, ignoring parsed.name", async () => {
			fs.mkdirSync(f5xcProfilesDir, { recursive: true });
			fs.writeFileSync(
				path.join(f5xcProfilesDir, "my-file.json"),
				JSON.stringify({ name: "different-name", apiUrl: "https://test.console.ves.volterra.io", apiToken: "tok", defaultNamespace: "default" }),
			);
			writeActiveProfile(f5xcConfigDir, "my-file");

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).not.toBeNull();
			expect(result?.name).toBe("my-file");
		});

		it("does not write active_profile when auto-activated profile is invalid", async () => {
			fs.mkdirSync(f5xcProfilesDir, { recursive: true });
			fs.writeFileSync(
				path.join(f5xcProfilesDir, "bad.json"),
				"not valid json{{{",
			);
			// No active_profile file, one broken profile

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).toBeNull();
			// active_profile should NOT have been written
			expect(fs.existsSync(path.join(f5xcConfigDir, "active_profile"))).toBe(false);
		});

		it("T-005: returns null when active_profile references non-existent JSON", async () => {
			fs.mkdirSync(f5xcConfigDir, { recursive: true });
			// active_profile points to a profile that doesn't exist
			writeActiveProfile(f5xcConfigDir, "vanished");

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).toBeNull();
			expect(service.getStatus().credentialSource).toBe("none");
			// No F5XC vars should be in bash.environment
			const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
			expect(bashEnv.F5XC_API_URL).toBeUndefined();
		});

		it("per-field env merge: F5XC_API_TOKEN in env skips token injection", async () => {
			process.env.F5XC_API_TOKEN = "env-token-override";
			// F5XC_API_URL is NOT set — profile should load
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).not.toBeNull();
			const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
			// URL should be injected from profile (not in process.env)
			expect(bashEnv.F5XC_API_URL).toBe(TEST_PROFILE.apiUrl);
			// Token should NOT be injected (already in process.env)
			expect(bashEnv.F5XC_API_TOKEN).toBeUndefined();
			// Namespace should be injected from profile
			expect(bashEnv.F5XC_NAMESPACE).toBe(TEST_PROFILE.defaultNamespace);
		});

		it("rejects active_profile with path traversal content", async () => {
			fs.mkdirSync(f5xcConfigDir, { recursive: true });
			writeActiveProfile(f5xcConfigDir, "../../etc/shadow");

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).toBeNull();
		});

		it("returns null gracefully when profile missing required fields", async () => {
			fs.mkdirSync(f5xcProfilesDir, { recursive: true });
			fs.writeFileSync(
				path.join(f5xcProfilesDir, "incomplete.json"),
				JSON.stringify({ name: "incomplete" }),
			);
			writeActiveProfile(f5xcConfigDir, "incomplete");

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).toBeNull();
		});
	});

	describe("listProfiles", () => {
		it("returns all profiles from profiles directory", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeProfile(f5xcProfilesDir, TEST_PROFILE_2);

			const service = ProfileService.init(f5xcConfigDir);
			const profiles = await service.listProfiles();

			expect(profiles.length).toBe(2);
			const names = profiles.map(p => p.name).sort();
			expect(names).toEqual(["production", "staging"]);
		});

		it("returns empty array when profiles directory does not exist", async () => {
			const service = ProfileService.init(f5xcConfigDir);
			const profiles = await service.listProfiles();
			expect(profiles).toEqual([]);
		});
	});

	describe("activate", () => {
		it("reads profile, writes active_profile, and updates settings", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeProfile(f5xcProfilesDir, TEST_PROFILE_2);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			await service.loadActive();

			const result = await service.activate(TEST_PROFILE_2.name);
			expect(result.name).toBe(TEST_PROFILE_2.name);

			// active_profile file should be updated
			const written = fs.readFileSync(path.join(f5xcConfigDir, "active_profile"), "utf-8");
			expect(written).toBe(TEST_PROFILE_2.name);

			// settings should reflect new profile
			const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
			expect(bashEnv.F5XC_API_URL).toBe(TEST_PROFILE_2.apiUrl);
		});

		it("rejects profile names with path separators", async () => {
			fs.mkdirSync(f5xcProfilesDir, { recursive: true });
			const service = ProfileService.init(f5xcConfigDir);
			await expect(service.activate("../../etc/passwd")).rejects.toThrow(/Invalid profile name/);
			await expect(service.activate("../escape")).rejects.toThrow(/Invalid profile name/);
			await expect(service.activate("sub/dir")).rejects.toThrow(/Invalid profile name/);
			await expect(service.activate("has..dots")).rejects.toThrow(/Invalid profile name/);
		});

		it("throws ProfileError when profile does not exist", async () => {
			fs.mkdirSync(f5xcProfilesDir, { recursive: true });

			const service = ProfileService.init(f5xcConfigDir);
			await expect(service.activate("nonexistent")).rejects.toThrow(ProfileError);
		});

		it("T-017: does not update active_profile when profile JSON is missing", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			await service.loadActive();

			// Try to activate a profile that doesn't exist
			await expect(service.activate("missing")).rejects.toThrow(ProfileError);

			// active_profile should still point to original profile
			const active = fs.readFileSync(path.join(f5xcConfigDir, "active_profile"), "utf-8");
			expect(active).toBe(TEST_PROFILE.name);
		});

		it("rejects activation when F5XC_API_URL is in environment", async () => {
			process.env.F5XC_API_URL = "https://env.console.ves.volterra.io";
			writeProfile(f5xcProfilesDir, TEST_PROFILE);

			const service = ProfileService.init(f5xcConfigDir);
			await expect(service.activate(TEST_PROFILE.name)).rejects.toThrow(/Cannot activate/);
		});

		it("rejects empty profile name", async () => {
			const service = ProfileService.init(f5xcConfigDir);
			await expect(service.activate("")).rejects.toThrow(/Invalid profile name/);
		});
	});

	describe("getStatus", () => {
		it("returns correct state after loadActive", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			await service.loadActive();

			const status = service.getStatus();
			expect(status.activeProfileName).toBe(TEST_PROFILE.name);
			expect(status.activeProfileUrl).toBe(TEST_PROFILE.apiUrl);
			expect(status.credentialSource).toBe("profile");
			expect(status.isConfigured).toBe(true);
		});

		it("returns none state when no profile loaded", async () => {
			const service = ProfileService.init(f5xcConfigDir);
			const status = service.getStatus();
			expect(status.activeProfileName).toBeNull();
			expect(status.credentialSource).toBe("none");
			expect(status.isConfigured).toBe(false);
		});

		it("reports environment source when all env vars are set", async () => {
			process.env.F5XC_API_URL = "https://env.console.ves.volterra.io";
			process.env.F5XC_API_TOKEN = "env-token-value";

			const service = ProfileService.init(f5xcConfigDir);
			await service.loadActive();

			const status = service.getStatus();
			expect(status.credentialSource).toBe("environment");
		});

		it("loads profile normally when only F5XC_API_TOKEN is set (not URL)", async () => {
			process.env.F5XC_API_TOKEN = "env-token-only";
			// F5XC_API_URL not set — profile should load; env token inherited by subprocess via process.env
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).not.toBeNull();
			// Mixed: URL from profile, token from env
			expect(service.getStatus().credentialSource).toBe("mixed");
		});

		it("reports mixed source when F5XC_NAMESPACE is in env but rest from profile", async () => {
			process.env.F5XC_NAMESPACE = "env-namespace";
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			await service.loadActive();

			expect(service.getStatus().credentialSource).toBe("mixed");
		});
	});

	describe("createProfile", () => {
		it("creates profile JSON file with correct content", async () => {
			const service = ProfileService.init(f5xcConfigDir);
			await service.createProfile({
				name: "new-prof",
				apiUrl: "https://new.console.ves.volterra.io",
				apiToken: "tok-create-test",
				defaultNamespace: "ns1",
			});

			const filePath = path.join(f5xcProfilesDir, "new-prof.json");
			expect(fs.existsSync(filePath)).toBe(true);
			const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			expect(data.apiUrl).toBe("https://new.console.ves.volterra.io");
			expect(data.apiToken).toBe("tok-create-test");
			expect(data.defaultNamespace).toBe("ns1");
			expect(data.metadata?.createdAt).toBeDefined();
			// createdAt should be a valid ISO date string
			expect(Number.isNaN(Date.parse(data.metadata.createdAt))).toBe(false);
		});

		it("creates profiles directory if it does not exist", async () => {
			expect(fs.existsSync(f5xcProfilesDir)).toBe(false);

			const service = ProfileService.init(f5xcConfigDir);
			await service.createProfile({
				name: "first",
				apiUrl: "https://t.console.ves.volterra.io",
				apiToken: "tok",
				defaultNamespace: "default",
			});

			expect(fs.existsSync(f5xcProfilesDir)).toBe(true);
		});

		it("writes profile file with 0o600 permissions", async () => {
			const service = ProfileService.init(f5xcConfigDir);
			await service.createProfile({
				name: "perms-test",
				apiUrl: "https://t.console.ves.volterra.io",
				apiToken: "tok",
				defaultNamespace: "default",
			});

			const stat = fs.statSync(path.join(f5xcProfilesDir, "perms-test.json"));
			expect(stat.mode & 0o777).toBe(0o600);
		});

		it("rejects duplicate profile name", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);

			const service = ProfileService.init(f5xcConfigDir);
			await expect(
				service.createProfile({
					name: TEST_PROFILE.name,
					apiUrl: "https://x.console.ves.volterra.io",
					apiToken: "tok",
					defaultNamespace: "default",
				}),
			).rejects.toThrow(/already exists/);
		});

		it("rejects profile name with path traversal", async () => {
			const service = ProfileService.init(f5xcConfigDir);
			await expect(
				service.createProfile({ name: "../../etc/passwd", apiUrl: "https://x.io", apiToken: "t", defaultNamespace: "d" }),
			).rejects.toThrow(/Invalid profile name/);
		});

		it("rejects empty profile name", async () => {
			const service = ProfileService.init(f5xcConfigDir);
			await expect(
				service.createProfile({ name: "", apiUrl: "https://x.io", apiToken: "t", defaultNamespace: "d" }),
			).rejects.toThrow(/Invalid profile name/);
		});

		it("rejects profile name longer than 64 chars", async () => {
			const service = ProfileService.init(f5xcConfigDir);
			await expect(
				service.createProfile({ name: "a".repeat(65), apiUrl: "https://x.io", apiToken: "t", defaultNamespace: "d" }),
			).rejects.toThrow(/Invalid profile name/);
		});

		it("uses atomic write (no .tmp file remains after success)", async () => {
			const service = ProfileService.init(f5xcConfigDir);
			await service.createProfile({
				name: "atomic-test",
				apiUrl: "https://t.console.ves.volterra.io",
				apiToken: "tok",
				defaultNamespace: "default",
			});

			expect(fs.existsSync(path.join(f5xcProfilesDir, "atomic-test.json"))).toBe(true);
			expect(fs.existsSync(path.join(f5xcProfilesDir, "atomic-test.json.tmp"))).toBe(false);
		});
	});

	describe("deleteProfile", () => {
		it("deletes existing profile JSON file", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE_2);
			const filePath = path.join(f5xcProfilesDir, `${TEST_PROFILE_2.name}.json`);
			expect(fs.existsSync(filePath)).toBe(true);

			const service = ProfileService.init(f5xcConfigDir);
			await service.deleteProfile(TEST_PROFILE_2.name);

			expect(fs.existsSync(filePath)).toBe(false);
		});

		it("throws ProfileError for non-existent profile", async () => {
			fs.mkdirSync(f5xcProfilesDir, { recursive: true });
			const service = ProfileService.init(f5xcConfigDir);
			await expect(service.deleteProfile("ghost")).rejects.toThrow(/not found/);
		});

		it("rejects profile name with path traversal", async () => {
			const service = ProfileService.init(f5xcConfigDir);
			await expect(service.deleteProfile("../escape")).rejects.toThrow(/Invalid profile name/);
		});

		it("rejects empty profile name", async () => {
			const service = ProfileService.init(f5xcConfigDir);
			await expect(service.deleteProfile("")).rejects.toThrow(/Invalid profile name/);
		});

		it("does not affect active_profile file", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeProfile(f5xcProfilesDir, TEST_PROFILE_2);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			await service.deleteProfile(TEST_PROFILE_2.name);

			// active_profile still points to production
			const active = fs.readFileSync(path.join(f5xcConfigDir, "active_profile"), "utf-8");
			expect(active).toBe(TEST_PROFILE.name);
		});
	});

	describe("env map and tenant derivation", () => {
		it("loadActive injects env map vars into bash.environment", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE_ENV);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE_ENV.name);

			const service = ProfileService.init(f5xcConfigDir);
			await service.loadActive();

			const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
			expect(bashEnv.F5XC_EMAIL).toBe("test@example.com");
			expect(bashEnv.F5XC_USERNAME).toBe("testuser@example.com");
			expect(bashEnv.F5XC_CONSOLE_PASSWORD).toBe("test-console-pass");
			expect(bashEnv.F5XC_LB_NAME).toBe("test-lb");
			expect(bashEnv.F5XC_DOMAINNAME).toBe("test.example.com");
			expect(bashEnv.F5XC_ROOT_DOMAIN).toBe("example.com");
		});

		it("F5XC_TENANT is auto-derived from apiUrl hostname", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			await service.loadActive();

			const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
			// TEST_F5XC_URL is https://test-tenant.console.ves.volterra.io
			expect(bashEnv.F5XC_TENANT).toBe("test-tenant");
		});

		it("env map vars respect per-field process.env precedence", async () => {
			process.env.F5XC_EMAIL = "env-email@override.com";
			writeProfile(f5xcProfilesDir, TEST_PROFILE_ENV);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE_ENV.name);

			const service = ProfileService.init(f5xcConfigDir);
			await service.loadActive();

			const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
			// F5XC_EMAIL is in process.env — should NOT be overridden
			expect(bashEnv.F5XC_EMAIL).toBeUndefined();
			// Other env vars should be injected normally
			expect(bashEnv.F5XC_LB_NAME).toBe("test-lb");

			delete process.env.F5XC_EMAIL;
		});

		it("createProfile stores env map in JSON", async () => {
			const service = ProfileService.init(f5xcConfigDir);
			await service.createProfile({
				name: "with-env",
				apiUrl: "https://t.console.ves.volterra.io",
				apiToken: "tok",
				defaultNamespace: "default",
				env: { F5XC_LB_NAME: "my-lb", F5XC_EMAIL: "a@b.com" },
			});

			const data = JSON.parse(fs.readFileSync(path.join(f5xcProfilesDir, "with-env.json"), "utf-8"));
			expect(data.env.F5XC_LB_NAME).toBe("my-lb");
			expect(data.env.F5XC_EMAIL).toBe("a@b.com");
		});

		it("getStatus includes tenant and namespace", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			await service.loadActive();

			const status = service.getStatus();
			expect(status.activeProfileTenant).toBe("test-tenant");
			expect(status.activeProfileNamespace).toBe(TEST_PROFILE.defaultNamespace);
		});

		it("profile switch clears stale F5XC_* vars from previous profile", async () => {
			// Production has F5XC_CONSOLE_PASSWORD in env map, staging does not
			const prodWithPass: F5XCProfile = {
				...TEST_PROFILE,
				env: { F5XC_CONSOLE_PASSWORD: "secret-pass", F5XC_LB_NAME: "prod-lb" },
			};
			const stagingNoPass: F5XCProfile = {
				...TEST_PROFILE_2,
				env: { F5XC_LB_NAME: "staging-lb" },
			};
			writeProfile(f5xcProfilesDir, prodWithPass);
			writeProfile(f5xcProfilesDir, stagingNoPass);
			writeActiveProfile(f5xcConfigDir, prodWithPass.name);

			const service = ProfileService.init(f5xcConfigDir);
			await service.loadActive();

			// Verify production password is present
			let bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
			expect(bashEnv.F5XC_CONSOLE_PASSWORD).toBe("secret-pass");
			expect(bashEnv.F5XC_LB_NAME).toBe("prod-lb");

			// Switch to staging — password must be CLEARED
			await service.activate(stagingNoPass.name);
			bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
			expect(bashEnv.F5XC_CONSOLE_PASSWORD).toBeUndefined();
			expect(bashEnv.F5XC_LB_NAME).toBe("staging-lb");
		});

		it("setNamespace switches namespace in active profile", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			await service.loadActive();

			expect(service.getStatus().activeProfileNamespace).toBe(TEST_PROFILE.defaultNamespace);

			service.setNamespace("other-ns");

			expect(service.getStatus().activeProfileNamespace).toBe("other-ns");
			const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
			expect(bashEnv.F5XC_NAMESPACE).toBe("other-ns");
		});

		it("setNamespace throws when no active profile", () => {
			const service = ProfileService.init(f5xcConfigDir);
			expect(() => service.setNamespace("test")).toThrow(/No active profile/);
		});

		it("profiles without env field work unchanged (backward compat)", async () => {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

			const service = ProfileService.init(f5xcConfigDir);
			const result = await service.loadActive();

			expect(result).not.toBeNull();
			expect(result?.env).toBeUndefined();
			const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
			expect(bashEnv.F5XC_API_URL).toBe(TEST_PROFILE.apiUrl);
			expect(bashEnv.F5XC_TENANT).toBe("test-tenant");
		});
	});

	describe("maskToken", () => {
		it("masks all but last 4 characters", () => {
			const service = ProfileService.init(f5xcConfigDir);
			expect(service.maskToken(_TEST_PROFILE.apiToken)).toBe(`...${_TEST_PROFILE.apiToken.slice(-4)}`);
		});

		it("masks short tokens completely", () => {
			const service = ProfileService.init(f5xcConfigDir);
			expect(service.maskToken("abc")).toBe("****");
		});
	});
});
