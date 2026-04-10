#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
const repo = "f5xc-salesdemos/xcsh";
const tapRepo = "f5xc-salesdemos/homebrew-tap";

interface ArchiveTarget {
	binary: string;
	archive: string;
	platform: "darwin" | "linux";
	arch: "arm64" | "x64";
	format: "zip" | "tar.gz";
}

const archiveTargets: ArchiveTarget[] = [
	{ binary: "xcsh-darwin-arm64", archive: "xcsh-darwin-arm64.zip", platform: "darwin", arch: "arm64", format: "zip" },
	{ binary: "xcsh-darwin-x64", archive: "xcsh-darwin-x64.zip", platform: "darwin", arch: "x64", format: "zip" },
	{ binary: "xcsh-linux-arm64", archive: "xcsh-linux-arm64.tar.gz", platform: "linux", arch: "arm64", format: "tar.gz" },
	{ binary: "xcsh-linux-x64", archive: "xcsh-linux-x64.tar.gz", platform: "linux", arch: "x64", format: "tar.gz" },
];

const isDryRun = process.argv.includes("--dry-run");
const packageOnly = process.argv.includes("--package-only");
const updateTapOnly = process.argv.includes("--update-tap");

function getVersion(): string {
	const ref = process.env.GITHUB_REF_NAME || "";
	if (ref.startsWith("v")) return ref.slice(1);
	// Fall back to reading from package.json
	try {
		const pkg = require(path.join(repoRoot, "packages", "coding-agent", "package.json"));
		return pkg.version;
	} catch {
		throw new Error("Cannot determine version: set GITHUB_REF_NAME or ensure packages/coding-agent/package.json exists");
	}
}

function getTag(): string {
	return process.env.GITHUB_REF_NAME || `v${getVersion()}`;
}

async function createArchives(): Promise<void> {
	console.log("Creating archives for Homebrew...");

	for (const target of archiveTargets) {
		const binaryPath = path.join(binariesDir, target.binary);
		const archivePath = path.join(binariesDir, target.archive);

		try {
			await fs.stat(binaryPath);
		} catch {
			console.log(`  Skipping ${target.binary} (not found)`);
			continue;
		}

		// Binary must be named "xcsh" inside the archive (formula does `bin.install "xcsh"`)
		const tmpDir = await fs.mkdtemp(path.join(repoRoot, ".tmp-homebrew-"));
		try {
			await fs.copyFile(binaryPath, path.join(tmpDir, "xcsh"));

			if (target.format === "zip") {
				if (isDryRun) {
					console.log(`  DRY RUN: zip -j ${archivePath} ${tmpDir}/xcsh`);
				} else {
					await $`zip -j ${archivePath} ${path.join(tmpDir, "xcsh")}`;
					console.log(`  Created ${target.archive}`);
				}
			} else {
				if (isDryRun) {
					console.log(`  DRY RUN: tar czf ${archivePath} -C ${tmpDir} xcsh`);
				} else {
					await $`tar czf ${archivePath} -C ${tmpDir} xcsh`;
					console.log(`  Created ${target.archive}`);
				}
			}
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	}
}

async function computeChecksums(): Promise<Map<string, string>> {
	const checksums = new Map<string, string>();

	for (const target of archiveTargets) {
		const archivePath = path.join(binariesDir, target.archive);
		try {
			await fs.stat(archivePath);
		} catch {
			continue;
		}

		if (isDryRun) {
			checksums.set(target.archive, "DRY_RUN_SHA256_PLACEHOLDER");
			console.log(`  DRY RUN: sha256sum ${target.archive}`);
		} else {
			const result = await $`sha256sum ${archivePath}`.text();
			const sha = result.split(" ")[0].trim();
			checksums.set(target.archive, sha);
			console.log(`  ${target.archive}: ${sha}`);
		}
	}

	return checksums;
}

function generateFormula(version: string, tag: string, checksums: Map<string, string>): string {
	const sha = (archive: string) => checksums.get(archive) || "MISSING_SHA256";

	return `# typed: false
# frozen_string_literal: true

class Xcsh < Formula
  desc "AI coding agent for the terminal"
  homepage "https://github.com/${repo}"
  version "${version}"

  depends_on "ripgrep"

  on_macos do
    if Hardware::CPU.intel?
      url "https://github.com/${repo}/releases/download/${tag}/xcsh-darwin-x64.zip"
      sha256 "${sha("xcsh-darwin-x64.zip")}"

      def install
        bin.install "xcsh"
      end
    end
    if Hardware::CPU.arm?
      url "https://github.com/${repo}/releases/download/${tag}/xcsh-darwin-arm64.zip"
      sha256 "${sha("xcsh-darwin-arm64.zip")}"

      def install
        bin.install "xcsh"
      end
    end
  end

  on_linux do
    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?
      url "https://github.com/${repo}/releases/download/${tag}/xcsh-linux-x64.tar.gz"
      sha256 "${sha("xcsh-linux-x64.tar.gz")}"

      def install
        bin.install "xcsh"
      end
    end
    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?
      url "https://github.com/${repo}/releases/download/${tag}/xcsh-linux-arm64.tar.gz"
      sha256 "${sha("xcsh-linux-arm64.tar.gz")}"

      def install
        bin.install "xcsh"
      end
    end
  end
end
`;
}

async function updateTap(version: string, tag: string, checksums: Map<string, string>): Promise<void> {
	const ghToken = process.env.GH_TOKEN;
	if (!ghToken && !isDryRun) {
		throw new Error("GH_TOKEN is required to push to the Homebrew tap");
	}

	const formula = generateFormula(version, tag, checksums);

	if (isDryRun) {
		console.log("\nGenerated formula:\n");
		console.log(formula);
		console.log("DRY RUN: would clone, commit, and push to", tapRepo);
		return;
	}

	const tmpDir = "/tmp/homebrew-tap";
	try {
		await fs.rm(tmpDir, { recursive: true, force: true });
	} catch {}

	console.log(`Cloning ${tapRepo}...`);
	await $`git clone https://x-access-token:${ghToken}@github.com/${tapRepo}.git ${tmpDir}`;

	await fs.writeFile(path.join(tmpDir, "xcsh.rb"), formula);

	const diff = await $`git -C ${tmpDir} diff --quiet`.nothrow();
	if (diff.exitCode === 0) {
		console.log("No changes to tap formula — skipping push");
		return;
	}

	await $`git -C ${tmpDir} config user.name "github-actions[bot]"`;
	await $`git -C ${tmpDir} config user.email "41898282+github-actions[bot]@users.noreply.github.com"`;
	await $`git -C ${tmpDir} add xcsh.rb`;
	await $`git -C ${tmpDir} commit -m ${"Update xcsh to " + tag}`;
	await $`git -C ${tmpDir} push`;
	console.log(`Pushed updated formula to ${tapRepo}`);
}

async function main(): Promise<void> {
	const version = getVersion();
	const tag = getTag();
	console.log(`Homebrew release: version=${version} tag=${tag}`);

	if (!updateTapOnly) {
		await createArchives();
	}

	if (!packageOnly) {
		console.log("\nComputing checksums...");
		const checksums = await computeChecksums();
		await updateTap(version, tag, checksums);
	}
}

await main();
