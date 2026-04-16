import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@f5xc-salesdemos/pi-utils";
import type { ApiCatalog, ApiCatalogMeta, ApiCategory, ApiOperation } from "./api-types";

interface CatalogIndex {
	operationsByName: Map<string, ApiOperation>;
	categoriesByName: Map<string, ApiCategory>;
}

export class ApiCatalogService {
	#catalogs = new Map<string, ApiCatalog>();
	#indexes = new Map<string, CatalogIndex>();
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
		if (catalog) {
			this.#catalogs.set(service, catalog);
			this.#buildIndex(service, catalog);
		}
		return catalog;
	}

	async getOperations(service: string, category?: string): Promise<ApiOperation[]> {
		const catalog = await this.getCatalog(service);
		if (!catalog) return [];
		if (!category) return [...this.#indexes.get(service)!.operationsByName.values()];
		const cat = this.#indexes.get(service)?.categoriesByName.get(category);
		return cat ? [...cat.operations] : [];
	}

	async getOperation(service: string, operationName: string): Promise<ApiOperation | null> {
		await this.getCatalog(service);
		return this.#indexes.get(service)?.operationsByName.get(operationName) ?? null;
	}

	async search(service: string, query: string): Promise<ApiOperation[]> {
		if (!query) return [];
		await this.getCatalog(service);
		const index = this.#indexes.get(service);
		if (!index) return [];

		const q = query.toLowerCase();

		const exact = index.operationsByName.get(q);
		if (exact) return [exact];

		const queryTokens = q.split(/[\s_-]+/).filter(t => t.length > 0);
		const scored: Array<{ op: ApiOperation; score: number }> = [];

		for (const [, category] of index.categoriesByName) {
			const categoryNameLower = category.name.toLowerCase();
			for (const op of category.operations) {
				let bestScore = 0;
				const nameTokens = op.name.toLowerCase().split("_");
				const descLower = op.description.toLowerCase();

				for (const token of queryTokens) {
					if (nameTokens.includes(token)) {
						bestScore = Math.max(bestScore, 80);
					} else if (categoryNameLower.includes(token)) {
						bestScore = Math.max(bestScore, 60);
					} else if (descLower.includes(token)) {
						bestScore = Math.max(bestScore, 40);
					} else if (op.name.toLowerCase().includes(token)) {
						bestScore = Math.max(bestScore, 20);
					}
				}

				if (bestScore > 0) scored.push({ op, score: bestScore });
			}
		}

		scored.sort((a, b) => b.score - a.score || a.op.name.localeCompare(b.op.name));
		return scored.slice(0, 25).map(s => s.op);
	}

	#buildIndex(service: string, catalog: ApiCatalog): void {
		const operationsByName = new Map<string, ApiOperation>();
		const categoriesByName = new Map<string, ApiCategory>();

		for (const category of catalog.categories) {
			categoriesByName.set(category.name, category);
			for (const op of category.operations) {
				operationsByName.set(op.name, op);
			}
		}

		this.#indexes.set(service, { operationsByName, categoriesByName });
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
				this.#buildIndex(catalog.service, catalog);
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
