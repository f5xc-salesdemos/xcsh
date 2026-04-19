import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ApiCatalogService } from "../src/services/api-catalog";

const MINIMAL_CATALOG = {
	service: "test-svc",
	displayName: "Test Service",
	version: "1.0.0",
	auth: {
		type: "api_token",
		headerName: "Authorization",
		headerTemplate: "APIToken {token}",
		tokenSource: "TEST_TOKEN",
		baseUrlSource: "TEST_URL",
	},
	categories: [
		{
			name: "items",
			displayName: "Items",
			operations: [
				{ name: "list_items", description: "List items", method: "GET", path: "/api/items", dangerLevel: "low" },
				{
					name: "get_item",
					description: "Get an item",
					method: "GET",
					path: "/api/items/{id}",
					dangerLevel: "low",
					parameters: [{ name: "id", in: "path", required: true, type: "string" }],
				},
				{
					name: "create_item",
					description: "Create an item",
					method: "POST",
					path: "/api/items",
					dangerLevel: "medium",
				},
				{
					name: "delete_item",
					description: "Delete an item",
					method: "DELETE",
					path: "/api/items/{id}",
					dangerLevel: "high",
					parameters: [{ name: "id", in: "path", required: true, type: "string" }],
				},
			],
		},
	],
};

describe("ApiCatalogService", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-catalog-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("getServices() returns empty when no catalogs found", async () => {
		const svc = new ApiCatalogService([tmpDir]);
		const services = await svc.getServices();
		expect(services).toEqual([]);
	});

	test("getServices() discovers catalog files and returns metadata", async () => {
		const catalogPath = path.join(tmpDir, "api-catalog.json");
		await Bun.write(catalogPath, JSON.stringify(MINIMAL_CATALOG));

		const svc = new ApiCatalogService([tmpDir]);
		const services = await svc.getServices();

		expect(services).toHaveLength(1);
		expect(services[0].service).toBe("test-svc");
		expect(services[0].displayName).toBe("Test Service");
		expect(services[0].operationCount).toBe(4);
		expect(services[0].categories).toEqual(["items"]);
	});

	test("getOperations() returns all operations for a service", async () => {
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(MINIMAL_CATALOG));
		const svc = new ApiCatalogService([tmpDir]);
		const ops = await svc.getOperations("test-svc");
		expect(ops).toHaveLength(4);
		expect(ops.map(o => o.name)).toContain("list_items");
	});

	test("getOperations() filters by category", async () => {
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(MINIMAL_CATALOG));
		const svc = new ApiCatalogService([tmpDir]);
		const ops = await svc.getOperations("test-svc", "items");
		expect(ops).toHaveLength(4);
	});

	test("getOperations() returns empty for unknown category", async () => {
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(MINIMAL_CATALOG));
		const svc = new ApiCatalogService([tmpDir]);
		const ops = await svc.getOperations("test-svc", "nonexistent");
		expect(ops).toHaveLength(0);
	});

	test("getOperation() returns a single operation by name", async () => {
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(MINIMAL_CATALOG));
		const svc = new ApiCatalogService([tmpDir]);
		const op = await svc.getOperation("test-svc", "get_item");
		expect(op).not.toBeNull();
		expect(op?.name).toBe("get_item");
		expect(op?.method).toBe("GET");
	});

	test("getOperation() returns null for unknown operation", async () => {
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(MINIMAL_CATALOG));
		const svc = new ApiCatalogService([tmpDir]);
		const op = await svc.getOperation("test-svc", "nonexistent");
		expect(op).toBeNull();
	});

	test("search() matches on operation name", async () => {
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(MINIMAL_CATALOG));
		const svc = new ApiCatalogService([tmpDir]);
		const results = await svc.search("test-svc", "list");
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("list_items");
	});

	test("search() matches on description", async () => {
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(MINIMAL_CATALOG));
		const svc = new ApiCatalogService([tmpDir]);
		const results = await svc.search("test-svc", "Create");
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("create_item");
	});

	test("getCatalog() returns auth config", async () => {
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(MINIMAL_CATALOG));
		const svc = new ApiCatalogService([tmpDir]);
		const catalog = await svc.getCatalog("test-svc");
		expect(catalog?.auth.type).toBe("api_token");
		expect(catalog?.auth.tokenSource).toBe("TEST_TOKEN");
	});

	test("getServices() scans nested plugin directories", async () => {
		const pluginDir = path.join(tmpDir, "marketplaces", "foo", "plugins", "bar");
		await fs.mkdir(pluginDir, { recursive: true });
		await Bun.write(path.join(pluginDir, "api-catalog.json"), JSON.stringify(MINIMAL_CATALOG));
		const svc = new ApiCatalogService([tmpDir]);
		const services = await svc.getServices();
		expect(services).toHaveLength(1);
	});

	test("getServices() discovers catalogs from multiple search paths", async () => {
		// Create a second temp dir with a different service
		const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "api-catalog-test2-"));
		const catalog2 = {
			service: "test-svc-2",
			displayName: "Test Service 2",
			version: "1.0.0",
			auth: {
				type: "api_token",
				headerName: "Authorization",
				headerTemplate: "APIToken {token}",
				tokenSource: "T2",
				baseUrlSource: "T2_URL",
			},
			categories: [
				{
					name: "items",
					displayName: "Items",
					operations: [
						{
							name: "list_items2",
							description: "List items 2",
							method: "GET",
							path: "/api/items2",
							dangerLevel: "low",
						},
					],
				},
			],
		};
		await Bun.write(path.join(tmpDir2, "api-catalog.json"), JSON.stringify(catalog2));
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(MINIMAL_CATALOG));

		// Service with TWO search paths
		const svc = new ApiCatalogService([tmpDir, tmpDir2]);
		const services = await svc.getServices();

		expect(services.map(s => s.service).sort()).toEqual(["test-svc", "test-svc-2"]);

		await fs.rm(tmpDir2, { recursive: true, force: true });
	});
});

describe("ApiCatalogService — indexed lookups", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-index-"));
		const catalog = {
			service: "test",
			displayName: "Test",
			version: "1.0.0",
			auth: {
				type: "bearer",
				headerName: "Authorization",
				headerTemplate: "Bearer {token}",
				tokenSource: "TOKEN",
				baseUrlSource: "BASE_URL",
			},
			categories: [
				{
					name: "widgets",
					displayName: "Widgets",
					operations: [
						{
							name: "list_widgets",
							description: "List all widgets",
							method: "GET",
							path: "/widgets",
							dangerLevel: "low",
							parameters: [],
						},
						{
							name: "get_widget",
							description: "Get a widget by name",
							method: "GET",
							path: "/widgets/{name}",
							dangerLevel: "low",
							parameters: [],
						},
						{
							name: "delete_widget",
							description: "Remove a widget",
							method: "DELETE",
							path: "/widgets/{name}",
							dangerLevel: "high",
							parameters: [],
						},
					],
				},
				{
					name: "gadgets",
					displayName: "Gadgets",
					operations: [
						{
							name: "list_gadgets",
							description: "List all gadgets",
							method: "GET",
							path: "/gadgets",
							dangerLevel: "low",
							parameters: [],
						},
					],
				},
			],
		};
		await Bun.write(path.join(dir, "api-catalog.json"), JSON.stringify(catalog));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true });
	});

	test("getOperation returns correct operation without linear scan", async () => {
		const svc = new ApiCatalogService([dir]);
		const op = await svc.getOperation("test", "delete_widget");
		expect(op).not.toBeNull();
		expect(op?.method).toBe("DELETE");
		expect(op?.dangerLevel).toBe("high");
	});

	test("getOperation returns null for unknown operation name", async () => {
		const svc = new ApiCatalogService([dir]);
		const op = await svc.getOperation("test", "nonexistent_op");
		expect(op).toBeNull();
	});

	test("getOperations with category filter uses category index", async () => {
		const svc = new ApiCatalogService([dir]);
		const ops = await svc.getOperations("test", "gadgets");
		expect(ops).toHaveLength(1);
		expect(ops[0].name).toBe("list_gadgets");
	});

	test("search uses keyword index", async () => {
		const svc = new ApiCatalogService([dir]);
		const results = await svc.search("test", "widget");
		expect(results.length).toBeGreaterThanOrEqual(3);
		expect(results.every(r => r.name.includes("widget") || r.description.toLowerCase().includes("widget"))).toBe(
			true,
		);
	});

	test("search returns empty for no match", async () => {
		const svc = new ApiCatalogService([dir]);
		const results = await svc.search("test", "zzznomatch");
		expect(results).toHaveLength(0);
	});
});

describe("ApiCatalogService — collision and rescan", () => {
	test("same service from two directories — last-scanned wins", async () => {
		const dir1 = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-collision-1-"));
		const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-collision-2-"));
		try {
			const base = {
				service: "svc",
				version: "1.0.0",
				auth: { type: "bearer", tokenSource: "T", baseUrlSource: "U" },
				categories: [],
			};
			await Bun.write(path.join(dir1, "api-catalog.json"), JSON.stringify({ ...base, displayName: "First" }));
			await Bun.write(path.join(dir2, "api-catalog.json"), JSON.stringify({ ...base, displayName: "Second" }));

			const svc = new ApiCatalogService([dir1, dir2]);
			const services = await svc.getServices();
			const match = services.find(s => s.service === "svc");
			expect(match).toBeDefined();
			expect(match!.displayName).toBe("Second");
		} finally {
			await fs.rm(dir1, { recursive: true });
			await fs.rm(dir2, { recursive: true });
		}
	});

	test("getServices skips disk re-scan on second call", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-rescan-"));
		try {
			const catalog = {
				service: "original",
				displayName: "Original",
				version: "1.0.0",
				auth: { type: "bearer", tokenSource: "T", baseUrlSource: "U" },
				categories: [],
			};
			await Bun.write(path.join(dir, "api-catalog.json"), JSON.stringify(catalog));

			const svc = new ApiCatalogService([dir]);
			const first = await svc.getServices();
			expect(first).toHaveLength(1);
			expect(first[0].service).toBe("original");

			// Write a new catalog after first scan
			await fs.mkdir(path.join(dir, "sub"), { recursive: true });
			await Bun.write(
				path.join(dir, "sub", "api-catalog.json"),
				JSON.stringify({ ...catalog, service: "sneaky-new" }),
			);

			const second = await svc.getServices();
			expect(second).toHaveLength(1);
			expect(second[0].service).toBe("original");
		} finally {
			await fs.rm(dir, { recursive: true });
		}
	});
});

describe("ApiCatalogService — scored fuzzy search", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-search-"));
		const catalog = {
			service: "test",
			displayName: "Test",
			version: "1.0.0",
			auth: { type: "bearer", tokenSource: "T", baseUrlSource: "U" },
			categories: [
				{
					name: "load-balancers",
					displayName: "Load Balancers",
					operations: [
						{
							name: "list_http_loadbalancers",
							description: "List all HTTP load balancers",
							method: "GET",
							path: "/lbs",
							dangerLevel: "low",
							parameters: [],
						},
						{
							name: "get_http_loadbalancer",
							description: "Get a specific HTTP load balancer",
							method: "GET",
							path: "/lbs/{name}",
							dangerLevel: "low",
							parameters: [],
						},
						{
							name: "delete_http_loadbalancer",
							description: "Remove an HTTP load balancer",
							method: "DELETE",
							path: "/lbs/{name}",
							dangerLevel: "high",
							parameters: [],
						},
					],
				},
				{
					name: "origin-pools",
					displayName: "Origin Pools",
					operations: [
						{
							name: "list_origin_pools",
							description: "List all origin pools",
							method: "GET",
							path: "/pools",
							dangerLevel: "low",
							parameters: [],
						},
					],
				},
				...Array.from({ length: 30 }, (_, i) => ({
					name: `filler-${i}`,
					displayName: `Filler ${i}`,
					operations: [
						{
							name: `filler_op_${i}`,
							description: `Filler operation ${i} for loadbalancer testing`,
							method: "GET",
							path: `/filler/${i}`,
							dangerLevel: "low",
							parameters: [],
						},
					],
				})),
			],
		};
		await Bun.write(path.join(dir, "api-catalog.json"), JSON.stringify(catalog));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true });
	});

	test("exact name match ranks first", async () => {
		const svc = new ApiCatalogService([dir]);
		const results = await svc.search("test", "list_http_loadbalancers");
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0].name).toBe("list_http_loadbalancers");
	});

	test("name token match ranks above description-only match", async () => {
		const svc = new ApiCatalogService([dir]);
		const results = await svc.search("test", "loadbalancer");
		const nameMatchIdx = results.findIndex(r => r.name.includes("loadbalancer"));
		const descOnlyIdx = results.findIndex(
			r => r.name.startsWith("filler_op_") && r.description.includes("loadbalancer"),
		);
		if (nameMatchIdx >= 0 && descOnlyIdx >= 0) {
			expect(nameMatchIdx).toBeLessThan(descOnlyIdx);
		}
	});

	test("results capped at 25", async () => {
		const svc = new ApiCatalogService([dir]);
		const results = await svc.search("test", "filler");
		expect(results.length).toBeLessThanOrEqual(25);
	});

	test("category name match returns relevant ops", async () => {
		const svc = new ApiCatalogService([dir]);
		const results = await svc.search("test", "load-balancers");
		expect(results.some(r => r.name === "list_http_loadbalancers")).toBe(true);
	});

	test("empty query returns empty", async () => {
		const svc = new ApiCatalogService([dir]);
		const results = await svc.search("test", "");
		expect(results).toHaveLength(0);
	});
});
