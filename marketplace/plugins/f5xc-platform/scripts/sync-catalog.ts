#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";

const REPO = process.env["CATALOG_RELEASE_REPO"] ?? "f5xc-salesdemos/api-specs-enriched";
const ASSET_NAME = "api-catalog.json";
const OUTPUT_PATH = path.join(import.meta.dir, "..", ASSET_NAME);

async function fetchJson(url: string): Promise<unknown> {
	const headers: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
	const token = process.env["GITHUB_TOKEN"];
	if (token) headers["Authorization"] = `Bearer ${token}`;

	const res = await fetch(url, { headers });
	if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText} — ${url}`);
	return res.json();
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
	const headers: Record<string, string> = { Accept: "application/octet-stream" };
	const token = process.env["GITHUB_TOKEN"];
	if (token) headers["Authorization"] = `Bearer ${token}`;

	const res = await fetch(url, { headers });
	if (!res.ok) throw new Error(`Download error: ${res.status} ${res.statusText} — ${url}`);
	return res.arrayBuffer();
}

export function validateCatalog(catalog: unknown): void {
	if (typeof catalog !== "object" || catalog === null) {
		throw new Error("Catalog is not an object");
	}
	const c = catalog as Record<string, unknown>;
	if (c["service"] !== "f5xc") throw new Error(`Expected service 'f5xc', got '${c["service"]}'`);
	if (c["auth"] === undefined) throw new Error("Catalog missing 'auth' field");
	if (!Array.isArray(c["categories"])) throw new Error("Catalog missing 'categories' array");
	const totalOps = (c["categories"] as Array<{ operations: unknown[] }>).reduce(
		(n, cat) => n + (cat.operations?.length ?? 0),
		0,
	);
	if (totalOps === 0) throw new Error("Catalog has 0 operations — this seems wrong");
	console.log(`Validated: ${totalOps} operations across ${(c["categories"] as unknown[]).length} categories`);
}

async function main(): Promise<void> {
	console.log(`Fetching latest release from ${REPO}...`);

	const latestUrl = `https://api.github.com/repos/${REPO}/releases/latest`;
	const release = (await fetchJson(latestUrl)) as {
		tag_name: string;
		assets: Array<{ name: string; url: string }>;
	};

	console.log(`Found release: ${release.tag_name}`);

	const asset = release.assets.find(a => a.name === ASSET_NAME);
	if (!asset) {
		const names = release.assets.map(a => a.name).join(", ");
		throw new Error(`Asset '${ASSET_NAME}' not found in release. Available: ${names}`);
	}

	console.log(`Downloading ${ASSET_NAME}...`);
	const bytes = await fetchBytes(asset.url);
	const text = new TextDecoder().decode(bytes);

	let catalog: unknown;
	try {
		catalog = JSON.parse(text);
	} catch {
		throw new Error("Downloaded file is not valid JSON");
	}

	validateCatalog(catalog);

	await fs.writeFile(OUTPUT_PATH, text, "utf8");
	console.log(`Saved to ${OUTPUT_PATH}`);
}

if (import.meta.main) {
	main().catch(err => {
		console.error("sync-catalog failed:", err.message);
		process.exit(1);
	});
}
