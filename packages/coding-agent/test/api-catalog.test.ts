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
});
