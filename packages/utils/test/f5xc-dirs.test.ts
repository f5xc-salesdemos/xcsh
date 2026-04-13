import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getF5XCActiveProfilePath, getF5XCConfigDir, getF5XCProfilePath, getF5XCProfilesDir } from "../src/dirs";

describe("F5XC XDG path helpers", () => {
	const originalXdgConfig = process.env.XDG_CONFIG_HOME;

	afterEach(() => {
		if (originalXdgConfig === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfig;
		}
	});

	describe("getF5XCConfigDir", () => {
		it("returns ~/.config/f5xc when XDG_CONFIG_HOME is not set", () => {
			delete process.env.XDG_CONFIG_HOME;
			const expected = path.join(os.homedir(), ".config", "f5xc");
			expect(getF5XCConfigDir()).toBe(expected);
		});

		it("returns $XDG_CONFIG_HOME/f5xc when XDG_CONFIG_HOME is set", () => {
			process.env.XDG_CONFIG_HOME = "/custom/config";
			expect(getF5XCConfigDir()).toBe("/custom/config/f5xc");
		});
	});

	describe("getF5XCProfilesDir", () => {
		it("returns config dir + /profiles", () => {
			delete process.env.XDG_CONFIG_HOME;
			const expected = path.join(os.homedir(), ".config", "f5xc", "profiles");
			expect(getF5XCProfilesDir()).toBe(expected);
		});
	});

	describe("getF5XCActiveProfilePath", () => {
		it("returns config dir + /active_profile", () => {
			delete process.env.XDG_CONFIG_HOME;
			const expected = path.join(os.homedir(), ".config", "f5xc", "active_profile");
			expect(getF5XCActiveProfilePath()).toBe(expected);
		});
	});

	describe("getF5XCProfilePath", () => {
		it("returns profiles dir + /<name>.json", () => {
			delete process.env.XDG_CONFIG_HOME;
			const expected = path.join(os.homedir(), ".config", "f5xc", "profiles", "production.json");
			expect(getF5XCProfilePath("production")).toBe(expected);
		});
	});
});
