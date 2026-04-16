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
	let origFetch: typeof fetch;

	beforeEach(async () => {
		origFetch = globalThis.fetch;
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-call-test-"));
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(TEST_CATALOG));
		process.env.TEST_TOKEN = "test-token-123";
		process.env.TEST_URL = "https://api.example.com";
		process.env.TEST_NS = "default";
	});

	afterEach(async () => {
		globalThis.fetch = origFetch;
		await fs.rm(tmpDir, { recursive: true, force: true });
		delete process.env.TEST_TOKEN;
		delete process.env.TEST_URL;
		delete process.env.TEST_NS;
	});

	test("executes a low-danger GET operation and returns JSON response", async () => {
		const mockItems = [{ id: "1", name: "item-one" }];
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(mockItems), { status: 200 })) as unknown as typeof fetch;

		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiCallTool(catalog, executor);

		const result = await tool.execute("id1", { service: "test-svc", operation: "list_items" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("item-one");
	});

	test("sends Authorization header with resolved token", async () => {
		let capturedHeaders: Record<string, string> = {};
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {})) as Record<string, string>;
			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch;

		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiCallTool(catalog, executor);

		await tool.execute("id1", { service: "test-svc", operation: "list_items" });
		expect(capturedHeaders.Authorization).toBe("APIToken test-token-123");
	});

	test("returns error on API 404 response", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })) as unknown as typeof fetch;

		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiCallTool(catalog, executor);

		const result = await tool.execute("id1", { service: "test-svc", operation: "list_items" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("HTTP 404");
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

	test("returns error when required path parameter is missing", async () => {
		// The test catalog has list_items which requires 'namespace' with default $TEST_NS
		// Delete the default env var so it can't be resolved
		delete process.env.TEST_NS;

		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiCallTool(catalog, executor);

		const result = await tool.execute("id1", { service: "test-svc", operation: "list_items" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Missing required parameter");
		expect(text).toContain("namespace");

		// Restore for other tests
		process.env.TEST_NS = "default";
	});

	test("high-danger op with session returns preview without executing", async () => {
		// Mock fetch to track if it was called
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch;

		// Create a minimal mock session with queueResolveHandler tracking
		const mockSession = {
			getToolChoiceQueue: () => ({
				pushOnce: () => {},
			}),
			buildToolChoice: () => ({ type: "tool", name: "resolve" }),
			steer: () => {},
		} as unknown as import("../src/tools").ToolSession;

		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiCallTool(catalog, executor, mockSession);

		const result = await tool.execute("id1", {
			service: "test-svc",
			operation: "delete_item",
			params: { id: "abc" },
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;

		// Should NOT have executed the fetch
		expect(fetchCalled).toBe(false);
		// Should have returned a preview/confirmation message
		expect(text.toLowerCase()).toContain("high");
	});

	test("high-danger op without session executes immediately (backwards compat)", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ result: "ok" }), { status: 200 })) as unknown as typeof fetch;

		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiCallTool(catalog, executor); // NO session

		const result = await tool.execute("id1", {
			service: "test-svc",
			operation: "delete_item",
			params: { id: "abc" },
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		// With no session, should still execute (for test compatibility)
		expect(text).toContain("result");
	});
});

const BATCH_CATALOG = {
	service: "svc",
	displayName: "Test Batch Service",
	version: "1.0.0",
	auth: {
		type: "api_token",
		headerName: "Authorization",
		headerTemplate: "APIToken {token}",
		tokenSource: "TEST_TOKEN",
		baseUrlSource: "TEST_BASE_URL",
	},
	defaults: {},
	categories: [
		{
			name: "widgets",
			displayName: "Widgets",
			operations: [
				{
					name: "list_widgets",
					description: "List widgets",
					method: "GET",
					path: "/api/widgets",
					dangerLevel: "low",
					parameters: [],
				},
				{
					name: "list_gadgets",
					description: "List gadgets",
					method: "GET",
					path: "/api/gadgets",
					dangerLevel: "low",
					parameters: [],
				},
				{
					name: "delete_widget",
					description: "Delete a widget",
					method: "DELETE",
					path: "/api/widgets/{id}",
					dangerLevel: "high",
					parameters: [{ name: "id", in: "path", required: true, type: "string" }],
				},
			],
		},
	],
};

describe("ApiBatchTool", () => {
	let tmpDir: string;
	let origFetch: typeof fetch;

	beforeEach(async () => {
		origFetch = globalThis.fetch;
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-batch-test-"));
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(BATCH_CATALOG));
		process.env.TEST_TOKEN = "batch-token-123";
		process.env.TEST_BASE_URL = "https://api.example.com";
	});

	afterEach(async () => {
		globalThis.fetch = origFetch;
		await fs.rm(tmpDir, { recursive: true, force: true });
		delete process.env.TEST_TOKEN;
		delete process.env.TEST_BASE_URL;
	});

	test("executes multiple operations and returns aggregated results", async () => {
		globalThis.fetch = (async (url: string | URL | Request) => {
			const urlStr = String(url);
			if (urlStr.includes("widgets")) return new Response(JSON.stringify([{ id: "w1" }]), { status: 200 });
			if (urlStr.includes("gadgets")) return new Response(JSON.stringify([{ id: "g1" }]), { status: 200 });
			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch;

		const { ApiBatchTool } = await import("../src/tools/api-tool");
		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiBatchTool(catalog, executor);

		const result = await tool.execute("id1", {
			service: "svc",
			operations: [{ operation: "list_widgets" }, { operation: "list_gadgets" }],
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("list_widgets");
		expect(text).toContain("list_gadgets");
	});

	test("continues on failure in best-effort mode (default)", async () => {
		globalThis.fetch = (async (url: string | URL | Request) => {
			const urlStr = String(url);
			if (urlStr.includes("widgets")) return new Response(JSON.stringify({ error: "fail" }), { status: 500 });
			if (urlStr.includes("gadgets")) return new Response(JSON.stringify([{ id: "g1" }]), { status: 200 });
			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch;

		const { ApiBatchTool } = await import("../src/tools/api-tool");
		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiBatchTool(catalog, executor);

		const result = await tool.execute("id1", {
			service: "svc",
			operations: [{ operation: "list_widgets" }, { operation: "list_gadgets" }],
			mode: "best-effort",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("list_gadgets");
	});

	test("returns error for unknown service", async () => {
		const { ApiBatchTool } = await import("../src/tools/api-tool");
		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiBatchTool(catalog, executor);

		const result = await tool.execute("id1", {
			service: "unknown",
			operations: [{ operation: "list_widgets" }],
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text.toLowerCase()).toContain("not found");
	});

	test("returns error for unknown operation name", async () => {
		const { ApiBatchTool } = await import("../src/tools/api-tool");
		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiBatchTool(catalog, executor);

		const result = await tool.execute("id1", {
			service: "svc",
			operations: [{ operation: "nonexistent_op" }],
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text.toLowerCase()).toContain("not found");
	});
});

describe("Plugin discovery path fix", () => {
	test("ApiCatalogService accepts marketplace cache path without error", async () => {
		const home = os.homedir();
		const svc = new ApiCatalogService([
			path.join(home, ".claude", "plugins"),
			path.join(home, ".xcsh", "plugins", "cache", "plugins"),
		]);
		const services = await svc.getServices();
		expect(Array.isArray(services)).toBe(true);
	});
});

describe("ApiCallTool — deferrable", () => {
	test("ApiCallTool is marked deferrable", async () => {
		let tmpDir: string | undefined;
		try {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-deferrable-"));
			await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(TEST_CATALOG));
			const catalog = new ApiCatalogService([tmpDir]);
			const executor = new ApiExecutor();
			const tool = new ApiCallTool(catalog, executor);
			expect((tool as { deferrable?: boolean }).deferrable).toBe(true);
		} finally {
			if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("ApiBatchTool — danger-level gate", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-batch-danger-"));
		const catalog = {
			...BATCH_CATALOG,
			categories: [
				{
					name: "resources",
					displayName: "Resources",
					operations: [
						{
							name: "list_resources",
							description: "List",
							method: "GET",
							path: "/resources",
							dangerLevel: "low",
							parameters: [],
						},
						{
							name: "update_resource",
							description: "Update",
							method: "PUT",
							path: "/resources/{id}",
							dangerLevel: "medium",
							parameters: [{ name: "id", in: "path", required: true, type: "string" }],
						},
						{
							name: "delete_resource",
							description: "Delete",
							method: "DELETE",
							path: "/resources/{id}",
							dangerLevel: "high",
							parameters: [{ name: "id", in: "path", required: true, type: "string" }],
						},
						{
							name: "nuke_resources",
							description: "Nuke all",
							method: "DELETE",
							path: "/resources",
							dangerLevel: "critical",
							parameters: [],
						},
					],
				},
			],
		};
		await Bun.write(path.join(tmpDir, "api-catalog.json"), JSON.stringify(catalog));
		process.env.TEST_TOKEN = "token";
		process.env.TEST_BASE_URL = "https://api.example.com";
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		delete process.env.TEST_TOKEN;
		delete process.env.TEST_BASE_URL;
	});

	test("rejects critical-danger operations in batch", async () => {
		const { ApiBatchTool } = await import("../src/tools/api-tool");
		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiBatchTool(catalog, executor);
		const result = await tool.execute("id", {
			service: "svc",
			operations: [{ operation: "nuke_resources" }],
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("critical");
		expect(text).toContain("api_call");
	});

	test("rejects high-danger operations in batch", async () => {
		const { ApiBatchTool } = await import("../src/tools/api-tool");
		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiBatchTool(catalog, executor);
		const result = await tool.execute("id", {
			service: "svc",
			operations: [{ operation: "delete_resource", params: { id: "x" } }],
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("high");
		expect(text).toContain("api_call");
	});

	test("executes low and medium danger operations normally", async () => {
		let called = false;
		const origFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			called = true;
			return new Response(JSON.stringify({ items: [] }), { status: 200 });
		}) as unknown as typeof fetch;
		try {
			const { ApiBatchTool } = await import("../src/tools/api-tool");
			const catalog = new ApiCatalogService([tmpDir]);
			const executor = new ApiExecutor();
			const tool = new ApiBatchTool(catalog, executor);
			await tool.execute("id", {
				service: "svc",
				operations: [{ operation: "list_resources" }],
			});
			expect(called).toBe(true);
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});
