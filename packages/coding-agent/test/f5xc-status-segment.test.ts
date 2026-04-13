import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@f5xc-salesdemos/pi-utils";
import { _resetSettingsForTest, Settings } from "@f5xc-salesdemos/xcsh/config/settings";
import { ProfileService } from "@f5xc-salesdemos/xcsh/services/f5xc-profile";
import { renderF5XCProfileSegment } from "@f5xc-salesdemos/xcsh/services/f5xc-profile-segment";
import { TEST_PROFILE } from "./f5xc-test-fixtures";

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

describe("profile.f5xc status line segment", () => {
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

		testDir = path.join(os.tmpdir(), "test-f5xc-segment", Snowflake.next());
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

	it("returns visible: false when no profile is active", () => {
		ProfileService.init(f5xcConfigDir);
		const result = renderF5XCProfileSegment();
		expect(result.visible).toBe(false);
		expect(result.content).toBe("");
	});

	it("returns content with profile name when active", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const result = renderF5XCProfileSegment();
		expect(result.visible).toBe(true);
		expect(result.content).toBe("f5xc:production");
	});

	it("returns visible: false when ProfileService is not initialized (crash isolation)", () => {
		// Do NOT call ProfileService.init() — simulates startup without F5XC config
		ProfileService._resetForTest();
		const result = renderF5XCProfileSegment();
		expect(result.visible).toBe(false);
		expect(result.content).toBe("");
	});

	it("segment content never contains the API token", async () => {
		writeProfile(f5xcProfilesDir, TEST_PROFILE);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		const result = renderF5XCProfileSegment();
		expect(result.visible).toBe(true);
		expect(result.content).not.toContain(TEST_PROFILE.apiToken);
	});

	it("updates after profile switch", async () => {
		const profile2 = { ...TEST_PROFILE, name: "staging", apiUrl: "https://staging.console.ves.volterra.io" };
		writeProfile(f5xcProfilesDir, TEST_PROFILE);
		writeProfile(f5xcProfilesDir, profile2);
		writeActiveProfile(f5xcConfigDir, TEST_PROFILE.name);

		const service = ProfileService.init(f5xcConfigDir);
		await service.loadActive();

		expect(renderF5XCProfileSegment().content).toBe("f5xc:production");

		await service.activate("staging");

		expect(renderF5XCProfileSegment().content).toBe("f5xc:staging");
	});
});
