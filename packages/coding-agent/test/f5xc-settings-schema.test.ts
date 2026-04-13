import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@f5xc-salesdemos/pi-utils";
import { _resetSettingsForTest, Settings } from "@f5xc-salesdemos/xcsh/config/settings";

describe("bash.environment setting", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		_resetSettingsForTest();
		testDir = path.join(os.tmpdir(), "test-f5xc-settings", Snowflake.next());
		agentDir = path.join(testDir, "agent");
		projectDir = path.join(testDir, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(path.join(projectDir, ".xcsh"), { recursive: true });
	});

	afterEach(() => {
		_resetSettingsForTest();
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	it("defaults to empty object", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir, inMemory: true });
		const bashEnv = settings.get("bash.environment");
		expect(bashEnv).toEqual({});
	});

	it("returns overridden value after settings.override()", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir, inMemory: true });
		settings.override("bash.environment", { F5XC_API_URL: "https://test.console.ves.volterra.io" });
		const bashEnv = settings.get("bash.environment");
		expect(bashEnv).toEqual({ F5XC_API_URL: "https://test.console.ves.volterra.io" });
	});

	it("override replaces previous value completely", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir, inMemory: true });
		settings.override("bash.environment", { A: "1", B: "2" });
		settings.override("bash.environment", { C: "3" });
		const bashEnv = settings.get("bash.environment");
		expect(bashEnv).toEqual({ C: "3" });
	});
});
