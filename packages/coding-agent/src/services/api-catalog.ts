import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@f5xc-salesdemos/pi-utils";
import type { ApiCatalog, ApiCatalogMeta, ApiOperation } from "./api-types";

export class ApiCatalogService {
	#catalogs = new Map<string, ApiCatalog>();
	#meta = new Map<string, ApiCatalogMeta>();
	#searchPaths: string[];
	#scanned = false;

	constructor(searchPaths: string[]) {
		this.#searchPaths = searchPaths;
	}

	async getServices(): Promise<ApiCatalogMeta[]> {
		if (!this.#scanned) await this.#scan();
		return [...this.#meta.values()];
	}

	async getCatalog(service: string): Promise<ApiCatalog | null> {
		if (!this.#scanned) await this.#scan();
		if (this.#catalogs.has(service)) return this.#catalogs.get(service)!;
		const meta = this.#meta.get(service);
		if (!meta) return null;
		const catalog = await this.#load(meta.filePath);
		if (catalog) this.#catalogs.set(service, catalog);
		return catalog;
	}

	async getOperations(service: string, category?: string): Promise<ApiOperation[]> {
		const catalog = await this.getCatalog(service);
		if (!catalog) return [];
		const cats = category ? catalog.categories.filter(c => c.name === category) : catalog.categories;
		return cats.flatMap(c => c.operations);
	}

	async getOperation(service: string, operationName: string): Promise<ApiOperation | null> {
		const ops = await this.getOperations(service);
		return ops.find(o => o.name === operationName) ?? null;
	}

	async search(service: string, query: string): Promise<ApiOperation[]> {
		const ops = await this.getOperations(service);
		const q = query.toLowerCase();
		return ops.filter(o => o.name.toLowerCase().includes(q) || o.description.toLowerCase().includes(q));
	}

	async #scan(): Promise<void> {
		this.#scanned = true;
		this.#meta.clear();
		for (const searchPath of this.#searchPaths) {
			const found = await this.#findCatalogFiles(searchPath);
			for (const filePath of found) {
				const catalog = await this.#load(filePath);
				if (!catalog) continue;
				const opCount = catalog.categories.reduce((n, c) => n + c.operations.length, 0);
				this.#meta.set(catalog.service, {
					service: catalog.service,
					displayName: catalog.displayName,
					version: catalog.version,
					filePath,
					operationCount: opCount,
					categories: catalog.categories.map(c => c.name),
				});
				this.#catalogs.set(catalog.service, catalog);
			}
		}
	}

	async #findCatalogFiles(dir: string): Promise<string[]> {
		const results: string[] = [];
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					const nested = await this.#findCatalogFiles(full);
					results.push(...nested);
				} else if (entry.name === "api-catalog.json") {
					results.push(full);
				}
			}
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		return results;
	}

	async #load(filePath: string): Promise<ApiCatalog | null> {
		try {
			return (await Bun.file(filePath).json()) as ApiCatalog;
		} catch {
			return null;
		}
	}
}
