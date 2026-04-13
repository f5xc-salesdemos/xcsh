import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@f5xc-salesdemos/pi-utils";
import { _resetSettingsForTest, Settings } from "@f5xc-salesdemos/xcsh/config/settings";
import { ProfileError, ProfileService } from "@f5xc-salesdemos/xcsh/services/f5xc-profile";
import { handleProfileCommand } from "@f5xc-salesdemos/xcsh/services/f5xc-profile-command";
import {
	TEST_LONG_TOKEN,
	TEST_PROFILE,
	TEST_PROFILE_WITH_ENV,
} from "./f5xc-test-fixtures";

function writeProfile(profilesDir: string, profile: { name: string; apiUrl: string; apiToken: string; defaultNamespace: string }): void {
	fs.mkdirSync(profilesDir, { recursive: true });
	fs.writeFileSync(
		path.join(profilesDir, `${profile.name}.json`),
		JSON.stringify(profile, null, 2),
		{ mode: 0o600 },
	);
}

function writeActiveProfile(configDir: string, name: string): void {
	fs.writeFileSync(path.join(configDir, "active_profile"), name);
}

function createMockCtx() {
	const messages: { type: string; text: string }[] = [];
	return {
		messages,
		showStatus(msg: string) { messages.push({ type: "status", text: msg }); },
		showError(msg: string) { messages.push({ type: "error", text: msg }); },
		showWarning(msg: string) { messages.push({ type: "warning", text: msg }); },
		editor: { setText(_text: string) {} },
		statusLine: { invalidate() {} },
		updateEditorTopBorder() {},
		ui: { requestRender() {} },
	};
}

describe("F5XC security: token never in output", () => {
	let testDir: string;
	let f5xcConfigDir: string;
	let f5xcProfilesDir: string;
	let projectDir: string;
	let agentDir: string;

	beforeEach(async () => {
		_resetSettingsForTest();
		ProfileService._resetForTest();
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("F5XC_")) delete process.env[key];
		}

		testDir = path.join(os.tmpdir(), "test-f5xc-security", Snowflake.next());
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
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("F5XC_")) delete process.env[key];
		}
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	it("maskToken never returns the full token for any length", () => {
		const service = ProfileService.init(f5xcConfigDir);
		const cases = ["", "a", "ab", "abc", "abcd", "abcde", "0123456789", TEST_LONG_TOKEN];

		for (const token of cases) {
			const masked = service.maskToken(token);
			if (token.length > 0) {
				expect(masked).not.toBe(token);
			}
			// For longer tokens, the masked form must not contain the full token
			// and must be shorter than the original
			if (token.length > 8) {
				expect(masked).not.toContain(token);
				expect(masked.length).toBeLessThan(token.length);
			}
		}
	});

	it("/profile show output never contains full token (128-char token)", async () => {
		const longTokenProfile = { ...TEST_PROFILE, name: "long-tok", apiToken: TEST_LONG_TOKEN };
		writeProfile(f5xcProfilesDir, longTokenProfile);
		writeActiveProfile(f5xcConfigDir, "long-tok");

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "show", text: "/profile show" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("status");
		expect(ctx.messages[0].text).not.toContain(TEST_LONG_TOKEN);
		// Masked suffix should be present
		expect(ctx.messages[0].text).toContain(`...${TEST_LONG_TOKEN.slice(-4)}`);
	});

	it("/profile status output never contains full token", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "status", text: "/profile status" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("status");
		expect(ctx.messages[0].text).not.toContain(TEST_PROFILE.apiToken);
	});

	it("/profile list output never contains any token", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "list", text: "/profile list" },
			ctx,
		);

		expect(ctx.messages[0].text).not.toContain(TEST_PROFILE.apiToken);
	});

	it("ProfileError messages never contain token values", async () => {
		const service = ProfileService.init(f5xcConfigDir);

		// Trigger various error paths
		const errors: string[] = [];

		try { await service.activate("../../escape"); } catch (e) { if (e instanceof ProfileError) errors.push(e.message); }
		try { await service.activate("nonexistent"); } catch (e) { if (e instanceof ProfileError) errors.push(e.message); }
		try { await service.deleteProfile("ghost"); } catch (e) { if (e instanceof ProfileError) errors.push(e.message); }
		try {
			writeProfile(f5xcProfilesDir, TEST_PROFILE);
			await service.createProfile({ ...TEST_PROFILE });
		} catch (e) { if (e instanceof ProfileError) errors.push(e.message); }

		expect(errors.length).toBeGreaterThan(0);
		for (const msg of errors) {
			expect(msg).not.toContain(TEST_PROFILE.apiToken);
		}
	});
});

describe("F5XC security: sensitive env var masking", () => {
	let testDir: string;
	let f5xcConfigDir: string;
	let f5xcProfilesDir: string;
	let projectDir: string;
	let agentDir: string;

	beforeEach(async () => {
		_resetSettingsForTest();
		ProfileService._resetForTest();
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("F5XC_")) delete process.env[key];
		}

		testDir = path.join(os.tmpdir(), "test-f5xc-mask", Snowflake.next());
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
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("F5XC_")) delete process.env[key];
		}
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	it("F5XC_CONSOLE_PASSWORD is masked in /profile show output", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE_WITH_ENV);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE_WITH_ENV.name);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "show", text: "/profile show" },
			ctx,
		);

		const output = ctx.messages[0].text;
		// Full password must NOT appear
		expect(output).not.toContain("test-console-pass");
		// Masked suffix should be present
		expect(output).toContain("...pass");
		// Non-sensitive env vars should appear in full
		expect(output).toContain("test@example.com");
		expect(output).toContain("test-lb");
	});

	it("/profile show displays tenant derived from URL", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE_WITH_ENV);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE_WITH_ENV.name);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "show", text: "/profile show" },
			ctx,
		);

		const output = ctx.messages[0].text;
		// Table output has ANSI codes — strip them for content checks
		const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("F5XC_TENANT");
		expect(plain).toContain("test-tenant");
	});
});

describe("F5XC security: TUI sanitization", () => {
	let testDir: string;
	let f5xcConfigDir: string;
	let f5xcProfilesDir: string;
	let projectDir: string;
	let agentDir: string;

	beforeEach(async () => {
		_resetSettingsForTest();
		ProfileService._resetForTest();
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("F5XC_")) delete process.env[key];
		}

		testDir = path.join(os.tmpdir(), "test-f5xc-tui", Snowflake.next());
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
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("F5XC_")) delete process.env[key];
		}
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	it("/profile show strips control characters from profile fields", async () => {
		// Write profile with embedded control characters via direct file write
		const malicious = {
			name: "evil",
			apiUrl: "https://evil.io\n  INJECTED LINE",
			apiToken: "tok123",
			defaultNamespace: "ns\ttab\nnewline",
		};
		fs.mkdirSync(f5xcProfilesDir, { recursive: true });
		fs.writeFileSync(
			path.join(f5xcProfilesDir, "evil.json"),
			JSON.stringify(malicious),
			{ mode: 0o600 },
		);
		writeActiveProfile(f5xcConfigDir, "evil");

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "show", text: "/profile show" },
			ctx,
		);

		const output = ctx.messages[0].text;
		// Control characters should be stripped — no tabs or carriage returns
		expect(output).not.toContain("\t");
		expect(output).toContain("https://evil.io");
		// The newline within the URL field should be stripped so it can't
		// break onto a separate line (the text remains but is harmless inline)
		const urlLine = output.split("\n").find((l: string) => l.includes("F5XC_API_URL"));
		expect(urlLine).toBeDefined();
		expect(urlLine).toContain("https://evil.io");
	});

	it("/profile list strips control characters from profile fields", async () => {
		const malicious = {
			name: "evil",
			apiUrl: "https://evil.io\r\nINJECTED",
			apiToken: "tok123",
			defaultNamespace: "ns",
		};
		fs.mkdirSync(f5xcProfilesDir, { recursive: true });
		fs.writeFileSync(
			path.join(f5xcProfilesDir, "evil.json"),
			JSON.stringify(malicious),
			{ mode: 0o600 },
		);
		writeActiveProfile(f5xcConfigDir, "evil");

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "list", text: "/profile list" },
			ctx,
		);

		const output = ctx.messages[0].text;
		// \r\n stripped — "INJECTED" text remains inline but can't spoof a new line
		const lines = output.split("\n");
		// Should be a single line (no injected newlines breaking the output)
		expect(lines.length).toBe(1);
		expect(output).toContain("https://evil.io");
	});
});

describe("F5XC security: path traversal prevention", () => {
	let testDir: string;
	let f5xcConfigDir: string;
	let f5xcProfilesDir: string;
	let projectDir: string;
	let agentDir: string;

	beforeEach(async () => {
		_resetSettingsForTest();
		ProfileService._resetForTest();
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("F5XC_")) delete process.env[key];
		}

		testDir = path.join(os.tmpdir(), "test-f5xc-security-pt", Snowflake.next());
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
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("F5XC_")) delete process.env[key];
		}
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	it("createProfile rejects dangerous names", async () => {
		const service = ProfileService.init(f5xcConfigDir);
		const dangerous = ["../escape", "sub/dir", "has spaces", ".hidden", "a".repeat(65)];

		for (const name of dangerous) {
			await expect(
				service.createProfile({ name, apiUrl: "https://x.io", apiToken: "t", defaultNamespace: "d" }),
			).rejects.toThrow(/Invalid profile name/);
		}
	});

	it("deleteProfile rejects dangerous names", async () => {
		const service = ProfileService.init(f5xcConfigDir);
		const dangerous = ["../escape", "sub/dir", "has spaces", ".hidden", "a".repeat(65)];

		for (const name of dangerous) {
			await expect(service.deleteProfile(name)).rejects.toThrow(/Invalid profile name/);
		}
	});

	it("active_profile with path traversal content is rejected on load", async () => {
		fs.mkdirSync(f5xcConfigDir, { recursive: true });
		writeActiveProfile(f5xcConfigDir, "../../etc/passwd");

		const service = ProfileService.init(f5xcConfigDir);
		const result = await service.loadActive();

		expect(result).toBeNull();
	});
});
