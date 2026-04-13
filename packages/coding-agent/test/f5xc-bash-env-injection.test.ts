import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@f5xc-salesdemos/xcsh/config/settings";
import { executeBash } from "@f5xc-salesdemos/xcsh/exec/bash-executor";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "xcsh-bash-env-"));
}

describe("bash.environment injection into subprocess", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = makeTempDir();
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("F5XC_")) delete process.env[key];
		}
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });
	});

	afterEach(() => {
		_resetSettingsForTest();
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("F5XC_")) delete process.env[key];
		}
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	it("injects bash.environment vars into subprocess", async () => {
		Settings.instance.override("bash.environment", {
			F5XC_TEST_VAR: "injected_value",
		});
		const result = await executeBash("echo $F5XC_TEST_VAR", {
			cwd: tempDir,
			timeout: 5000,
		});
		expect(result.output.trim()).toBe("injected_value");
	});

	it("per-call env overrides bash.environment", async () => {
		Settings.instance.override("bash.environment", {
			F5XC_TEST_VAR: "from_settings",
		});
		const result = await executeBash("echo $F5XC_TEST_VAR", {
			cwd: tempDir,
			timeout: 5000,
			env: { F5XC_TEST_VAR: "from_per_call" },
		});
		expect(result.output.trim()).toBe("from_per_call");
	});

	it("empty bash.environment has no effect", async () => {
		// bash.environment defaults to {} — should not break existing behavior
		const result = await executeBash("echo hello", {
			cwd: tempDir,
			timeout: 5000,
		});
		expect(result.output.trim()).toBe("hello");
	});
});
