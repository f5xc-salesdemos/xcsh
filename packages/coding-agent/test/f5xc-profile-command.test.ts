import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@f5xc-salesdemos/pi-utils";
import { _resetSettingsForTest, Settings } from "@f5xc-salesdemos/xcsh/config/settings";
import { ProfileService } from "@f5xc-salesdemos/xcsh/services/f5xc-profile";
import { handleProfileCommand } from "@f5xc-salesdemos/xcsh/services/f5xc-profile-command";
import {
	TEST_PROFILE,
	TEST_PROFILE_STAGING as TEST_PROFILE_2,
	TEST_STAGING_URL,
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

/** Minimal mock of InteractiveModeContext for slash command testing */
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

describe("/profile slash command handler", () => {
	let testDir: string;
	let f5xcConfigDir: string;
	let f5xcProfilesDir: string;
	let projectDir: string;
	let agentDir: string;

	beforeEach(async () => {
		_resetSettingsForTest();
		ProfileService._resetForTest();
		// Ensure F5XC env vars don't leak from system environment
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("F5XC_")) delete process.env[key];
		}

		testDir = path.join(os.tmpdir(), "test-f5xc-cmd", Snowflake.next());
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

	it("/profile list shows profiles with active marker", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE);
		writeProfile(f5xcProfilesDir, TEST_PROFILE_2);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "list", text: "/profile list" },
			ctx,
		);

		expect(ctx.messages.length).toBe(1);
		expect(ctx.messages[0].type).toBe("status");
		expect(ctx.messages[0].text).toContain("* production");
		expect(ctx.messages[0].text).toContain("  staging");
	});

	it("/profile list shows helpful message when no profiles", async () => {
		ProfileService.init(f5xcConfigDir);

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "list", text: "/profile list" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("status");
		expect(ctx.messages[0].text).toContain("No F5 XC profiles found");
	});

	it("/profile activate switches profile", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE);
		writeProfile(f5xcProfilesDir, TEST_PROFILE_2);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "activate staging", text: "/profile activate staging" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("status");
		expect(ctx.messages[0].text).toContain("Switched to F5 XC profile: staging");

		const bashEnv = Settings.instance.get("bash.environment") as Record<string, string>;
		expect(bashEnv.F5XC_API_URL).toBe(TEST_PROFILE_2.apiUrl);
	});

	it("/profile activate with no arg shows error", async () => {
		ProfileService.init(f5xcConfigDir);

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "activate", text: "/profile activate" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("error");
		expect(ctx.messages[0].text).toContain("Usage");
	});

	it("/profile show displays masked token", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

		const service = ProfileService.init(f5xcConfigDir);
		const loaded = await service.loadActive();
		expect(loaded).not.toBeNull(); // Ensure profile actually loaded

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "show", text: "/profile show" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("status");
		expect(ctx.messages[0].text).toContain(`...${TEST_PROFILE.apiToken.slice(-4)}`);
		// Full token must NEVER appear in output
		expect(ctx.messages[0].text).not.toContain(TEST_PROFILE.apiToken);
	});

	it("/profile status shows auth status", async () => {
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
		expect(ctx.messages[0].text).toContain("production");
		expect(ctx.messages[0].text).toContain("profile");
	});

	// --- /profile create ---

	it("/profile create with valid args creates profile and shows success", async () => {
		ProfileService.init(f5xcConfigDir);

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "create myprof https://t.console.ves.volterra.io tok-secret staging-ns", text: "/profile create ..." },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("status");
		expect(ctx.messages[0].text).toContain("Profile 'myprof' created");
		// Profile file should exist on disk
		expect(fs.existsSync(path.join(f5xcProfilesDir, "myprof.json"))).toBe(true);
	});

	it("/profile create defaults namespace to 'default' when omitted", async () => {
		ProfileService.init(f5xcConfigDir);

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "create myprof https://t.console.ves.volterra.io tok-secret", text: "/profile create ..." },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("status");
		const data = JSON.parse(fs.readFileSync(path.join(f5xcProfilesDir, "myprof.json"), "utf-8"));
		expect(data.defaultNamespace).toBe("default");
	});

	it("/profile create with missing args shows usage error", async () => {
		ProfileService.init(f5xcConfigDir);

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "create myprof", text: "/profile create myprof" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("error");
		expect(ctx.messages[0].text).toContain("Usage");
	});

	it("/profile create with invalid profile name shows error", async () => {
		ProfileService.init(f5xcConfigDir);

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "create ../../bad https://t.console.ves.volterra.io tok", text: "/profile create ..." },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("error");
		expect(ctx.messages[0].text).toContain("alphanumeric");
	});

	it("/profile create with HTTP URL (not HTTPS) shows error", async () => {
		ProfileService.init(f5xcConfigDir);

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "create valid http://insecure.example.com tok", text: "/profile create ..." },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("error");
		expect(ctx.messages[0].text).toContain("HTTPS");
	});

	it("/profile create with invalid URL shows error", async () => {
		ProfileService.init(f5xcConfigDir);

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "create valid not-a-url tok", text: "/profile create ..." },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("error");
		expect(ctx.messages[0].text).toContain("HTTPS");
	});

	it("/profile create with duplicate name shows error", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE);
		ProfileService.init(f5xcConfigDir);

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: `create ${TEST_PROFILE.name} https://t.console.ves.volterra.io tok`, text: "/profile create ..." },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("error");
		expect(ctx.messages[0].text).toContain("already exists");
	});

	it("/profile create success output never contains raw token", async () => {
		const secretToken = "super-secret-token-value-12345";
		ProfileService.init(f5xcConfigDir);

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: `create myprof https://t.console.ves.volterra.io ${secretToken}`, text: "/profile create ..." },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("status");
		expect(ctx.messages[0].text).not.toContain(secretToken);
	});

	// --- /profile delete ---

	it("/profile delete with --confirm deletes profile and shows success", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE);
		writeProfile(f5xcProfilesDir, TEST_PROFILE_2);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "delete staging --confirm", text: "/profile delete staging --confirm" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("status");
		expect(ctx.messages[0].text).toContain("deleted");
		expect(fs.existsSync(path.join(f5xcProfilesDir, "staging.json"))).toBe(false);
	});

	it("/profile delete without --confirm shows confirmation prompt", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE);
		writeProfile(f5xcProfilesDir, TEST_PROFILE_2);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "delete staging", text: "/profile delete staging" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("status");
		expect(ctx.messages[0].text).toContain("--confirm");
		// File should still exist
		expect(fs.existsSync(path.join(f5xcProfilesDir, "staging.json"))).toBe(true);
	});

	it("/profile delete with no name shows usage error", async () => {
		ProfileService.init(f5xcConfigDir);

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "delete", text: "/profile delete" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("error");
		expect(ctx.messages[0].text).toContain("Usage");
	});

	it("/profile delete prevents deleting the active profile", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: `delete ${TEST_PROFILE.name} --confirm`, text: "/profile delete production --confirm" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("error");
		expect(ctx.messages[0].text).toContain("Cannot delete the active profile");
	});

	it("/profile delete non-existent profile with --confirm shows error", async () => {
		ProfileService.init(f5xcConfigDir);

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "delete ghost --confirm", text: "/profile delete ghost --confirm" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("error");
		expect(ctx.messages[0].text).toContain("not found");
	});

	it("/profile (no subcommand) defaults to list", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "", text: "/profile" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("status");
		expect(ctx.messages[0].text).toContain("* production");
	});

	it("/profile unknown shows error with valid subcommands", async () => {
		ProfileService.init(f5xcConfigDir);

		const ctx = createMockCtx();
		await handleProfileCommand(
			{ name: "profile", args: "banana", text: "/profile banana" },
			ctx,
		);

		expect(ctx.messages[0].type).toBe("error");
		expect(ctx.messages[0].text).toContain("Unknown subcommand");
	});
});
