#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

interface BinaryTarget {
	platform: string;
	arch: string;
	target: string;
	outfile: string;
}

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
const entrypoint = "./packages/coding-agent/src/cli.ts";
const isDryRun = process.argv.includes("--dry-run");

// Parse --platform flag to filter targets (e.g. --platform darwin or --platform linux,win32)
const platformIdx = process.argv.indexOf("--platform");
const platformFilter = platformIdx !== -1 ? process.argv[platformIdx + 1]?.split(",") : null;

// Parse --arch flag to filter targets (e.g. --arch arm64 or --arch x64)
const archIdx = process.argv.indexOf("--arch");
const archFilter = archIdx !== -1 ? process.argv[archIdx + 1]?.split(",") : null;

const allTargets: BinaryTarget[] = [
	{
		platform: "darwin",
		arch: "arm64",
		target: "bun-darwin-arm64",
		outfile: "packages/coding-agent/binaries/xcsh-darwin-arm64",
	},
	{
		platform: "darwin",
		arch: "x64",
		target: "bun-darwin-x64",
		outfile: "packages/coding-agent/binaries/xcsh-darwin-x64",
	},
	{
		platform: "linux",
		arch: "x64",
		target: "bun-linux-x64-modern",
		outfile: "packages/coding-agent/binaries/xcsh-linux-x64",
	},
	{
		platform: "linux",
		arch: "arm64",
		target: "bun-linux-arm64",
		outfile: "packages/coding-agent/binaries/xcsh-linux-arm64",
	},
	{
		platform: "win32",
		arch: "x64",
		target: "bun-windows-x64-modern",
		outfile: "packages/coding-agent/binaries/xcsh-windows-x64.exe",
	},
];

const targets = allTargets
	.filter((t) => !platformFilter || platformFilter.includes(t.platform))
	.filter((t) => !archFilter || archFilter.includes(t.arch));

async function embedNative(target: BinaryTarget): Promise<void> {
	if (isDryRun) {
		console.log(`DRY RUN bun --cwd=packages/natives run embed:native [${target.platform}/${target.arch}]`);
		return;
	}

	await $`bun --cwd=packages/natives run embed:native`
		.cwd(repoRoot)
		.env({
			...Bun.env,
			TARGET_PLATFORM: target.platform,
			TARGET_ARCH: target.arch,
		});
}

async function buildBinary(target: BinaryTarget): Promise<void> {
	console.log(`Building ${target.outfile}...`);
	await embedNative(target);
	if (isDryRun) {
		console.log(`DRY RUN bun build --compile --define PI_COMPILED=true --root . --external mupdf --target=${target.target} ${entrypoint} --outfile ${target.outfile}`);
		return;
	}

	await $`bun build --compile --define PI_COMPILED=true --root . --external mupdf --target=${target.target} ${entrypoint} --outfile ${target.outfile}`.cwd(
		repoRoot,
	);
}

async function generateBundle(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun --cwd=packages/stats scripts/generate-client-bundle.ts --generate");
		return;
	}
	await $`bun --cwd=packages/stats scripts/generate-client-bundle.ts --generate`.cwd(repoRoot);
}

async function resetArtifacts(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun --cwd=packages/natives run embed:native --reset");
		console.log("DRY RUN bun --cwd=packages/stats scripts/generate-client-bundle.ts --reset");
		return;
	}
	await $`bun --cwd=packages/natives run embed:native --reset`.cwd(repoRoot);
	await $`bun --cwd=packages/stats scripts/generate-client-bundle.ts --reset`.cwd(repoRoot);
}

async function smokeTestHostBinary(): Promise<void> {
	const hostPlatform = process.platform;
	const hostArch = process.arch;
	const hostTarget = targets.find((t) => t.platform === hostPlatform && t.arch === hostArch);
	if (!hostTarget) {
		console.log(`Skipping compiled binary smoke test (no target for ${hostPlatform}-${hostArch})`);
		return;
	}

	const binaryPath = path.join(repoRoot, hostTarget.outfile);
	try {
		await fs.stat(binaryPath);
	} catch {
		console.log(`Skipping compiled binary smoke test (${hostTarget.outfile} not found)`);
		return;
	}

	console.log(`Smoke-testing ${hostTarget.outfile}...`);
	const result = Bun.spawnSync([binaryPath, "--version"], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...Bun.env, HOME: await fs.mkdtemp(path.join(repoRoot, ".tmp-smoke-")), PI_DEV: "1" },
	});

	const stderr = result.stderr.toString();
	if (result.exitCode !== 0) {
		console.error(`FAIL: compiled binary exited with code ${result.exitCode}`);
		console.error(stderr);
		throw new Error("Compiled binary smoke test failed — native addon may not be embedded correctly");
	}

	const stdout = result.stdout.toString().trim();
	console.log(`  ${stdout}`);
	if (stderr.includes("Failed to load pi_natives")) {
		console.error(`FAIL: compiled binary could not load native addon`);
		console.error(stderr);
		throw new Error("Compiled binary smoke test failed — native addon loading error detected");
	}
	console.log(`Smoke test passed for ${hostTarget.outfile}`);
}

async function main(): Promise<void> {
	await fs.mkdir(binariesDir, { recursive: true });
	await generateBundle();
	try {
		for (const target of targets) {
			await buildBinary(target);
		}
		if (!isDryRun) {
			await smokeTestHostBinary();
		}
	} finally {
		await resetArtifacts();
	}
}

await main();
