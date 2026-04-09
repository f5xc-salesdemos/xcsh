#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const nativeDir = path.join(repoRoot, "packages", "natives", "native");
const expectedAddons = [
	"linux-x64-modern",
	"linux-x64-baseline",
	"linux-arm64",
	"darwin-x64-modern",
	"darwin-x64-baseline",
	"darwin-arm64",
	"win32-x64-modern",
	"win32-x64-baseline",
] as const;

async function main(): Promise<void> {
	const entries = await fs.readdir(nativeDir);

	console.log("Native addons downloaded:");
	for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
		console.log(`  ${entry}`);
	}
	console.log();
	console.log(`Expected addons: ${expectedAddons.join(", ")}`);

	const missingAddons = expectedAddons.filter((platform) => !entries.includes(`pi_natives.${platform}.node`));
	if (missingAddons.length > 0) {
		for (const platform of missingAddons) {
			console.error(`MISSING pi_natives.${platform}.node`);
		}
		process.exit(1);
	}

	for (const platform of expectedAddons) {
		console.log(`OK pi_natives.${platform}.node`);
	}

	// Verify no undefined tree-sitter external scanner symbols in ELF/Mach-O addons.
	// Windows DLLs use a different linking model and are not affected by this class of bug.
	const nonWindowsAddons = expectedAddons.filter((p) => !p.startsWith("win32-"));
	let symbolErrors = 0;

	for (const platform of nonWindowsAddons) {
		const addonPath = path.join(nativeDir, `pi_natives.${platform}.node`);
		const nmProc = Bun.spawn(["nm", "-D", addonPath], { stdout: "pipe", stderr: "pipe" });
		const output = await new Response(nmProc.stdout).text();
		await nmProc.exited;

		const undefinedScannerSymbols = output
			.split("\n")
			.filter((line) => /\bU\b.*tree_sitter_\w+_external_scanner_/.test(line));

		if (undefinedScannerSymbols.length > 0) {
			console.error(`SYMBOL ERROR pi_natives.${platform}.node: ${undefinedScannerSymbols.length} undefined tree-sitter scanner symbol(s)`);
			for (const sym of undefinedScannerSymbols) {
				console.error(`  ${sym.trim()}`);
			}
			symbolErrors++;
		} else {
			console.log(`SYMBOLS OK pi_natives.${platform}.node`);
		}
	}

	if (symbolErrors > 0) {
		console.error(`\n${symbolErrors} addon(s) have undefined tree-sitter scanner symbols`);
		process.exit(1);
	}
}

await main();
