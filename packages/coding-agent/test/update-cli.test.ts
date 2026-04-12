import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resolveUpdateMethodForTest } from "../src/cli/update-cli";

describe("update-cli install target detection", () => {
	// --- Existing tests (bun and binary) ---

	it("uses bun update when prioritized xcsh is inside bun global bin", () => {
		const method = _resolveUpdateMethodForTest("/Users/test/.bun/bin/xcsh", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses binary update when prioritized xcsh is outside bun global bin", () => {
		const method = _resolveUpdateMethodForTest("/Users/test/.local/bin/xcsh", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = _resolveUpdateMethodForTest("/Users/test/.local/bin/xcsh", undefined);

		expect(method).toBe("binary");
	});

	// --- Brew detection (path-based) ---

	it("uses brew update when path contains Cellar", () => {
		const method = _resolveUpdateMethodForTest("/opt/homebrew/Cellar/xcsh/15.5.0/bin/xcsh", undefined);

		expect(method).toBe("brew");
	});

	it("uses brew update when path contains homebrew", () => {
		const method = _resolveUpdateMethodForTest("/opt/homebrew/bin/xcsh", undefined);

		expect(method).toBe("brew");
	});

	it("prefers bun over brew when binary is in bun global bin under homebrew", () => {
		const method = _resolveUpdateMethodForTest("/opt/homebrew/.bun/bin/xcsh", "/opt/homebrew/.bun/bin");

		expect(method).toBe("bun");
	});

	// --- npm detection (symlink-based) ---

	describe("npm detection via symlinks", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xcsh-update-test-"));
		});

		afterEach(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("uses npm update when binary is a symlink into node_modules", () => {
			// Create a fake node_modules structure
			const nodeModulesTarget = path.join(tmpDir, "node_modules", "@f5xc-salesdemos", "xcsh", "dist");
			fs.mkdirSync(nodeModulesTarget, { recursive: true });
			const targetFile = path.join(nodeModulesTarget, "xcsh");
			fs.writeFileSync(targetFile, "");

			// Create a symlink pointing into node_modules
			const symlink = path.join(tmpDir, "xcsh");
			fs.symlinkSync(path.join("node_modules", "@f5xc-salesdemos", "xcsh", "dist", "xcsh"), symlink);

			const method = _resolveUpdateMethodForTest(symlink, undefined);

			expect(method).toBe("npm");
		});

		it("uses npm update for chained symlinks resolving into node_modules", () => {
			// Create node_modules target
			const nodeModulesTarget = path.join(tmpDir, "lib", "node_modules", "@f5xc-salesdemos", "xcsh", "dist");
			fs.mkdirSync(nodeModulesTarget, { recursive: true });
			const targetFile = path.join(nodeModulesTarget, "xcsh");
			fs.writeFileSync(targetFile, "");

			// First symlink: usr/bin/xcsh -> lib/node_modules/.../xcsh
			const binDir = path.join(tmpDir, "usr", "bin");
			fs.mkdirSync(binDir, { recursive: true });
			const firstLink = path.join(binDir, "xcsh");
			fs.symlinkSync(
				path.join(tmpDir, "lib", "node_modules", "@f5xc-salesdemos", "xcsh", "dist", "xcsh"),
				firstLink,
			);

			// Second symlink: local/bin/xcsh -> usr/bin/xcsh
			const localBinDir = path.join(tmpDir, "local", "bin");
			fs.mkdirSync(localBinDir, { recursive: true });
			const secondLink = path.join(localBinDir, "xcsh");
			fs.symlinkSync(firstLink, secondLink);

			const method = _resolveUpdateMethodForTest(secondLink, undefined);

			expect(method).toBe("npm");
		});
	});
});
