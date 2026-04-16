#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const nativeDir = path.join(repoRoot, "packages", "natives", "native");
const ALL_ADDONS = [
	"linux-x64-modern",
	"linux-x64-baseline",
	"linux-arm64",
	"darwin-x64-modern",
	"darwin-x64-baseline",
	"darwin-arm64",
	"win32-x64-modern",
	"win32-x64-baseline",
] as const;

// CI passes PI_NATIVE_EXPECTED_ADDONS to limit verification to built variants
const expectedAddons: readonly string[] = Bun.env.PI_NATIVE_EXPECTED_ADDONS
	? Bun.env.PI_NATIVE_EXPECTED_ADDONS.split(" ").filter(Boolean)
	: ALL_ADDONS;

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

/**
 * Detect AVX-512 markers in disassembly output lines.
 * Flags zmm/k-register usage or EVEX-prefixed (62h) instructions that have a
 * valid 4-byte EVEX prefix (byte-2 bit-2 set distinguishes EVEX from BOUND).
 */
export function hasAvx512Markers(line: string): boolean {
	// zmm or k-register references (e.g. %zmm0, %k1, kmovw)
	if (/\bzmm\d|%k[0-7]\b|\bk[a-z]+[bwdq]\b/.test(line)) return true;
	// EVEX prefix: starts with 62, and second byte has bit 2 set (distinguishes from BOUND)
	const hexMatch = line.match(/:\t((?:[0-9a-f]{2} )+)/);
	if (hexMatch) {
		const bytes = hexMatch[1].trim().split(" ");
		if (bytes[0] === "62" && bytes.length >= 4) {
			const p1 = parseInt(bytes[1], 16);
			// Bit 2 of P1 (the R' bit inverted) is always set in valid EVEX
			if ((p1 & 0x04) !== 0) return true;
		}
	}
	return false;
}

await main();
