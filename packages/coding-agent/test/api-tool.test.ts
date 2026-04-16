import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ApiCatalogService } from "../src/services/api-catalog";
import { ApiExecutor } from "../src/services/api-executor";
import { ApiCallTool, ApiDescribeTool, ApiDiscoverTool, ApiServicesTool } from "../src/tools/api-tool";

const TEST_CATALOG = {
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
	defaults: { namespace: { source: "TEST_NS" } },
	categories: [
		{
			name: "items",
			displayName: "Items",
			operations: [
				{
					name: "list_items",
					description: "List all items",
					method: "GET",
					path: "/api/items",
					dangerLevel: "low",
					parameters: [{ name: "namespace", in: "path", required: true, type: "string", default: "$TEST_NS" }],
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

describe("ApiServicesTool", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-tool-test-"));
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(TEST_CATALOG));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("lists installed services", async () => {
		const catalog = new ApiCatalogService([tmpDir]);
		const tool = new ApiServicesTool(catalog);
		const result = await tool.execute("id1", {});
		expect(result.content[0].type).toBe("text");
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("test-svc");
		expect(text).toContain("Test Service");
	});

	test("returns empty message when no catalogs installed", async () => {
		const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "empty-"));
		const catalog = new ApiCatalogService([emptyDir]);
		const tool = new ApiServicesTool(catalog);
		const result = await tool.execute("id1", {});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("No API catalogs");
		await fs.rm(emptyDir, { recursive: true, force: true });
	});
});

describe("ApiDiscoverTool", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-discover-test-"));
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(TEST_CATALOG));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("returns all operations for a service", async () => {
		const catalog = new ApiCatalogService([tmpDir]);
		const tool = new ApiDiscoverTool(catalog);
		const result = await tool.execute("id1", { service: "test-svc" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("list_items");
		expect(text).toContain("delete_item");
	});

	test("filters by category", async () => {
		const catalog = new ApiCatalogService([tmpDir]);
		const tool = new ApiDiscoverTool(catalog);
		const result = await tool.execute("id1", { service: "test-svc", category: "items" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("list_items");
	});

	test("filters by search query", async () => {
		const catalog = new ApiCatalogService([tmpDir]);
		const tool = new ApiDiscoverTool(catalog);
		const result = await tool.execute("id1", { service: "test-svc", search: "delete" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("delete_item");
		expect(text).not.toContain("list_items");
	});

	test("returns error for unknown service", async () => {
		const catalog = new ApiCatalogService([tmpDir]);
		const tool = new ApiDiscoverTool(catalog);
		const result = await tool.execute("id1", { service: "no-such-svc" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Service 'no-such-svc' not found");
	});
});

describe("ApiDescribeTool", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-describe-test-"));
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(TEST_CATALOG));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("returns operation details", async () => {
		const catalog = new ApiCatalogService([tmpDir]);
		const tool = new ApiDescribeTool(catalog);
		const result = await tool.execute("id1", { service: "test-svc", operation: "list_items" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("list_items");
		expect(text).toContain("GET");
		expect(text).toContain("/api/items");
		expect(text).toContain("low");
	});

	test("returns error for unknown operation", async () => {
		const catalog = new ApiCatalogService([tmpDir]);
		const tool = new ApiDescribeTool(catalog);
		const result = await tool.execute("id1", { service: "test-svc", operation: "no_such_op" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Operation 'no_such_op' not found");
	});
});

describe("ApiCallTool", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-call-test-"));
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(TEST_CATALOG));
		process.env.TEST_TOKEN = "test-token-123";
		process.env.TEST_URL = "https://api.example.com";
		process.env.TEST_NS = "default";
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		delete process.env.TEST_TOKEN;
		delete process.env.TEST_URL;
		delete process.env.TEST_NS;
	});

	test("executes a low-danger GET operation and returns JSON response", async () => {
		const mockItems = [{ id: "1", name: "item-one" }];
		const origFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(mockItems), { status: 200 })) as unknown as typeof fetch;

		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiCallTool(catalog, executor);

		const result = await tool.execute("id1", { service: "test-svc", operation: "list_items" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("item-one");

		globalThis.fetch = origFetch;
	});

	test("sends Authorization header with resolved token", async () => {
		let capturedHeaders: Record<string, string> = {};
		const origFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {})) as Record<string, string>;
			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch;

		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiCallTool(catalog, executor);

		await tool.execute("id1", { service: "test-svc", operation: "list_items" });
		expect(capturedHeaders.Authorization).toBe("APIToken test-token-123");

		globalThis.fetch = origFetch;
	});

	test("returns error on API 404 response", async () => {
		const origFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })) as unknown as typeof fetch;

		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiCallTool(catalog, executor);

		const result = await tool.execute("id1", { service: "test-svc", operation: "list_items" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("HTTP 404");

		globalThis.fetch = origFetch;
	});

	test("returns error for unknown operation", async () => {
		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiCallTool(catalog, executor);

		const result = await tool.execute("id1", { service: "test-svc", operation: "nonexistent_op" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Operation 'nonexistent_op' not found");
	});

	test("blocks critical-danger operations", async () => {
		const criticalCatalog = {
			...TEST_CATALOG,
			categories: [
				{
					name: "dangerous",
					displayName: "Dangerous",
					operations: [
						{
							name: "nuke_everything",
							description: "Destroy all",
							method: "DELETE",
							path: "/api/all",
							dangerLevel: "critical",
						},
					],
				},
			],
		};
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(criticalCatalog));

		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiCallTool(catalog, executor);

		const result = await tool.execute("id1", { service: "test-svc", operation: "nuke_everything" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text.toLowerCase()).toContain("critical");
	});
});
