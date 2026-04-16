import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiExecutor } from "../src/services/api-executor";
import type { ApiAuthConfig, ApiOperation, ResolvedAuth } from "../src/services/api-types";

const TEST_AUTH: ApiAuthConfig = {
	type: "api_token",
	headerName: "Authorization",
	headerTemplate: "APIToken {token}",
	tokenSource: "TEST_API_TOKEN",
	baseUrlSource: "TEST_BASE_URL",
};

const LIST_OP: ApiOperation = {
	name: "list_items",
	description: "List items",
	method: "GET",
	path: "/api/items",
	dangerLevel: "low",
};

describe("ApiExecutor.resolveUrl()", () => {
	test("resolves path template with params", () => {
		const executor = new ApiExecutor();
		const url = executor.resolveUrl("https://api.example.com", "/api/items/{id}", { id: "abc" });
		expect(url).toBe("https://api.example.com/api/items/abc");
	});

	test("resolves path with no params", () => {
		const executor = new ApiExecutor();
		const url = executor.resolveUrl("https://api.example.com", "/api/items", {});
		expect(url).toBe("https://api.example.com/api/items");
	});

	test("appends query params for GET operations", () => {
		const executor = new ApiExecutor();
		const url = executor.resolveUrl("https://api.example.com", "/api/items", {}, { limit: "10" });
		expect(url).toBe("https://api.example.com/api/items?limit=10");
	});
});

describe("ApiExecutor.resolveAuth()", () => {
	afterEach(() => {
		delete process.env.TEST_API_TOKEN;
		delete process.env.TEST_BASE_URL;
	});

	test("builds APIToken header from env var", () => {
		process.env.TEST_API_TOKEN = "mytoken";
		process.env.TEST_BASE_URL = "https://api.example.com";

		const executor = new ApiExecutor();
		const auth = executor.resolveAuth(TEST_AUTH);

		expect(auth.headers.Authorization).toBe("APIToken mytoken");
		expect(auth.baseUrl).toBe("https://api.example.com");
	});

	test("throws when token env var is missing", () => {
		delete process.env.TEST_API_TOKEN;
		process.env.TEST_BASE_URL = "https://api.example.com";

		const executor = new ApiExecutor();
		expect(() => executor.resolveAuth(TEST_AUTH)).toThrow("Missing required environment variable: TEST_API_TOKEN");
	});

	test("throws when base URL env var is missing", () => {
		process.env.TEST_API_TOKEN = "mytoken";
		delete process.env.TEST_BASE_URL;

		const executor = new ApiExecutor();
		expect(() => executor.resolveAuth(TEST_AUTH)).toThrow("Missing required environment variable: TEST_BASE_URL");
	});

	test("bearer type defaults header to 'Bearer {token}'", () => {
		process.env["TEST_API_TOKEN"] = "mytoken";
		process.env["TEST_BASE_URL"] = "https://api.example.com";

		const executor = new ApiExecutor();
		const auth = executor.resolveAuth({
			type: "bearer",
			tokenSource: "TEST_API_TOKEN",
			baseUrlSource: "TEST_BASE_URL",
		});

		expect(auth.headers["Authorization"]).toBe("Bearer mytoken");

		delete process.env["TEST_API_TOKEN"];
		delete process.env["TEST_BASE_URL"];
	});
});

describe("ApiExecutor.resolveParams()", () => {
	test("applies env-var defaults for omitted params", () => {
		process.env.DEFAULT_NS = "my-namespace";
		const opWithDefault: ApiOperation = {
			...LIST_OP,
			parameters: [{ name: "namespace", in: "path", required: true, type: "string", default: "$DEFAULT_NS" }],
		};

		const executor = new ApiExecutor();
		const resolved = executor.resolveParams(opWithDefault, {});
		expect(resolved.namespace).toBe("my-namespace");

		delete process.env.DEFAULT_NS;
	});

	test("explicit params override defaults", () => {
		process.env.DEFAULT_NS = "my-namespace";
		const opWithDefault: ApiOperation = {
			...LIST_OP,
			parameters: [{ name: "namespace", in: "path", required: true, type: "string", default: "$DEFAULT_NS" }],
		};

		const executor = new ApiExecutor();
		const resolved = executor.resolveParams(opWithDefault, { namespace: "other-ns" });
		expect(resolved.namespace).toBe("other-ns");

		delete process.env.DEFAULT_NS;
	});
});

describe("ApiExecutor.execute()", () => {
	const op: ApiOperation = {
		name: "list_items",
		description: "List items",
		method: "GET",
		path: "/api/ns/{namespace}/items",
		dangerLevel: "low",
		parameters: [{ name: "namespace", in: "path", required: true, type: "string" }],
	};

	const auth: ResolvedAuth = {
		headers: { Authorization: "APIToken test-token" },
		baseUrl: "https://api.example.com",
	};

	let origFetch: typeof fetch;

	beforeEach(() => {
		origFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = origFetch;
	});

	test("returns ok:true with parsed JSON on success", async () => {
		const mockData = [{ id: "1", name: "item-one" }];
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(mockData), { status: 200 })) as unknown as typeof fetch;

		const executor = new ApiExecutor();
		const result = await executor.execute(auth, op, { namespace: "default" });

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data).toEqual(mockData);
	});

	test("returns ok:false with status and error on HTTP error", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })) as unknown as typeof fetch;

		const executor = new ApiExecutor();
		const result = await executor.execute(auth, op, { namespace: "default" });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(404);
			expect(result.error).toContain("404");
		}
	});

	test("returns ok:false with status 0 on network error", async () => {
		globalThis.fetch = (async () => {
			throw new Error("Connection refused");
		}) as unknown as typeof fetch;

		const executor = new ApiExecutor();
		const result = await executor.execute(auth, op, { namespace: "default" });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(0);
			expect(result.error).toContain("Connection refused");
		}
	});

	test("sends JSON body for POST operations", async () => {
		const postOp: ApiOperation = { ...op, method: "POST" };
		let capturedBody: string | null = null;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			capturedBody = (init?.body as string) ?? null;
			return new Response(JSON.stringify({}), { status: 201 });
		}) as unknown as typeof fetch;

		const executor = new ApiExecutor();
		await executor.execute(auth, postOp, { namespace: "default" }, { name: "new-item" });

		expect(capturedBody!).toBe(JSON.stringify({ name: "new-item" }));
	});
});

describe("ApiExecutor — response caching", () => {
	const auth: ResolvedAuth = { headers: { Authorization: "APIToken test" }, baseUrl: "https://api.example.com" };
	const getOp: ApiOperation = {
		name: "list_widgets",
		description: "List widgets",
		method: "GET",
		path: "/api/widgets",
		dangerLevel: "low",
		parameters: [],
	};
	const deleteOp: ApiOperation = {
		name: "delete_widget",
		description: "Delete a widget",
		method: "DELETE",
		path: "/api/widgets/{name}",
		dangerLevel: "high",
		parameters: [{ name: "name", in: "path", required: true, type: "string" }],
	};

	let origFetch: typeof fetch;

	beforeEach(() => {
		origFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = origFetch;
	});

	test("GET response is cached on second call", async () => {
		let callCount = 0;
		globalThis.fetch = (async (url: string | URL | Request) => {
			callCount++;
			return new Response(JSON.stringify({ items: [1, 2] }), { status: 200 });
		}) as unknown as typeof fetch;
		const executor = new ApiExecutor();
		await executor.execute(auth, getOp, {});
		await executor.execute(auth, getOp, {});
		expect(callCount).toBe(1);
	});

	test("DELETE invalidates cached GET for same resource path", async () => {
		let callCount = 0;
		globalThis.fetch = (async (url: string | URL | Request) => {
			callCount++;
			const u = typeof url === "string" ? url : url.toString();
			if (u.includes("/foo")) return new Response(JSON.stringify({}), { status: 200 });
			return new Response(JSON.stringify({ items: [1] }), { status: 200 });
		}) as unknown as typeof fetch;
		const executor = new ApiExecutor();
		await executor.execute(auth, getOp, {});
		await executor.execute(auth, deleteOp, { name: "foo" });
		await executor.execute(auth, getOp, {});
		expect(callCount).toBe(3);
	});

	test("clearCache() forces re-fetch on next GET", async () => {
		let callCount = 0;
		globalThis.fetch = (async () => {
			callCount++;
			return new Response(JSON.stringify({ items: [] }), { status: 200 });
		}) as unknown as typeof fetch;
		const executor = new ApiExecutor();
		await executor.execute(auth, getOp, {});
		executor.clearCache();
		await executor.execute(auth, getOp, {});
		expect(callCount).toBe(2);
	});

	test("POST response is never cached", async () => {
		const postOp: ApiOperation = {
			name: "create_widget",
			description: "Create a widget",
			method: "POST",
			path: "/api/widgets",
			dangerLevel: "medium",
			parameters: [],
		};
		let callCount = 0;
		globalThis.fetch = (async () => {
			callCount++;
			return new Response(JSON.stringify({ name: "new" }), { status: 201 });
		}) as unknown as typeof fetch;
		const executor = new ApiExecutor();
		await executor.execute(auth, postOp, {}, { name: "new" });
		await executor.execute(auth, postOp, {}, { name: "new" });
		expect(callCount).toBe(2);
	});

	test("DELETE invalidates cached GET using resolved namespace in URL", async () => {
		// Regression: prefix was built from raw path template ({namespace} literal)
		// so it never matched cached keys with the real value ("default").
		const namespacedGetOp: ApiOperation = {
			name: "list_lbs",
			description: "List load balancers",
			method: "GET",
			path: "/api/config/namespaces/{namespace}/http_loadbalancers",
			dangerLevel: "low",
			parameters: [{ name: "namespace", in: "path", required: true, type: "string", default: "$F5XC_NAMESPACE" }],
		};
		const namespacedDeleteOp: ApiOperation = {
			name: "delete_lb",
			description: "Delete a load balancer",
			method: "DELETE",
			path: "/api/config/namespaces/{namespace}/http_loadbalancers/{name}",
			dangerLevel: "high",
			parameters: [
				{ name: "namespace", in: "path", required: true, type: "string", default: "$F5XC_NAMESPACE" },
				{ name: "name", in: "path", required: true, type: "string" },
			],
		};
		let callCount = 0;
		globalThis.fetch = (async () => {
			callCount++;
			return new Response(JSON.stringify({ items: [] }), { status: 200 });
		}) as unknown as typeof fetch;
		process.env["F5XC_NAMESPACE"] = "default";
		try {
			const nsAuth: ResolvedAuth = {
				headers: { Authorization: "APIToken test" },
				baseUrl: "https://api.example.com",
			};
			const executor = new ApiExecutor();
			await executor.execute(nsAuth, namespacedGetOp, { namespace: "default" }); // cached
			await executor.execute(nsAuth, namespacedDeleteOp, { namespace: "default", name: "my-lb" }); // must invalidate
			await executor.execute(nsAuth, namespacedGetOp, { namespace: "default" }); // must re-fetch
			expect(callCount).toBe(3);
		} finally {
			delete process.env["F5XC_NAMESPACE"];
		}
	});
});

describe("ApiExecutor — cache edge cases", () => {
	const auth: ResolvedAuth = { headers: { Authorization: "APIToken test" }, baseUrl: "https://api.example.com" };

	let origFetch: typeof fetch;
	let origDateNow: typeof Date.now;

	beforeEach(() => {
		origFetch = globalThis.fetch;
		origDateNow = Date.now;
	});

	afterEach(() => {
		globalThis.fetch = origFetch;
		Date.now = origDateNow;
	});

	test("cache entry expires after TTL", async () => {
		const getOp: ApiOperation = {
			name: "list_things",
			description: "List things",
			method: "GET",
			path: "/api/things",
			dangerLevel: "low",
			parameters: [],
		};
		let callCount = 0;
		globalThis.fetch = (async () => {
			callCount++;
			return new Response(JSON.stringify({ items: [] }), { status: 200 });
		}) as unknown as typeof fetch;

		const executor = new ApiExecutor();
		const baseTime = Date.now();

		await executor.execute(auth, getOp, {});
		expect(callCount).toBe(1);

		await executor.execute(auth, getOp, {});
		expect(callCount).toBe(1);

		Date.now = () => baseTime + 61_000;

		await executor.execute(auth, getOp, {});
		expect(callCount).toBe(2);
	});

	test("LRU eviction when cache exceeds 100 entries", async () => {
		let callCount = 0;
		globalThis.fetch = (async () => {
			callCount++;
			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch;

		const executor = new ApiExecutor();

		for (let i = 0; i < 101; i++) {
			const op: ApiOperation = {
				name: `get_item_${i}`,
				description: `Get item ${i}`,
				method: "GET",
				path: `/api/items/${i}`,
				dangerLevel: "low",
				parameters: [],
			};
			await executor.execute(auth, op, {});
		}
		expect(callCount).toBe(101);

		const firstOp: ApiOperation = {
			name: "get_item_0",
			description: "Get item 0",
			method: "GET",
			path: "/api/items/0",
			dangerLevel: "low",
			parameters: [],
		};
		await executor.execute(auth, firstOp, {});
		expect(callCount).toBe(102);
	});

	test("POST to collection invalidates cached GET for same path", async () => {
		const listOp: ApiOperation = {
			name: "list_resources",
			description: "List resources",
			method: "GET",
			path: "/api/resources",
			dangerLevel: "low",
			parameters: [],
		};
		const createOp: ApiOperation = {
			name: "create_resource",
			description: "Create a resource",
			method: "POST",
			path: "/api/resources",
			dangerLevel: "medium",
			parameters: [],
		};
		let callCount = 0;
		globalThis.fetch = (async () => {
			callCount++;
			return new Response(JSON.stringify({ items: [] }), { status: 200 });
		}) as unknown as typeof fetch;

		const executor = new ApiExecutor();
		await executor.execute(auth, listOp, {});
		expect(callCount).toBe(1);

		await executor.execute(auth, createOp, {}, { name: "new" });
		expect(callCount).toBe(2);

		await executor.execute(auth, listOp, {});
		expect(callCount).toBe(3);
	});
});

describe("validateResponse", () => {
	test("returns empty array for valid data matching schema", async () => {
		const { validateResponse } = await import("../src/services/api-executor");
		const schema = { type: "object" as const, properties: { items: { type: "array" } }, required: ["items"] };
		const warnings = validateResponse({ items: [1, 2] }, schema);
		expect(warnings).toHaveLength(0);
	});

	test("warns on wrong top-level type", async () => {
		const { validateResponse } = await import("../src/services/api-executor");
		const schema = { type: "array" as const };
		const warnings = validateResponse({ not: "array" }, schema);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain("array");
	});

	test("warns on missing required key", async () => {
		const { validateResponse } = await import("../src/services/api-executor");
		const schema = { type: "object" as const, required: ["items", "metadata"] };
		const warnings = validateResponse({ items: [] }, schema);
		expect(warnings.some(w => w.includes("metadata"))).toBe(true);
	});

	test("warns on wrong property type", async () => {
		const { validateResponse } = await import("../src/services/api-executor");
		const schema = { type: "object" as const, properties: { count: { type: "number" } } };
		const warnings = validateResponse({ count: "not-a-number" }, schema);
		expect(warnings.some(w => w.includes("count"))).toBe(true);
	});
});

describe("ApiExecutor — response validation integration", () => {
	let origFetch: typeof fetch;

	beforeEach(() => {
		origFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = origFetch;
	});

	test("execute attaches warnings when responseSchema defined", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ wrong: "shape" }), { status: 200 })) as unknown as typeof fetch;

		const auth: ResolvedAuth = { headers: { Authorization: "test" }, baseUrl: "https://api.example.com" };
		const op: ApiOperation = {
			name: "test_op",
			description: "Test",
			method: "GET",
			path: "/test",
			dangerLevel: "low",
			parameters: [],
			responseSchema: { type: "object", required: ["items"] },
		};
		const executor = new ApiExecutor();
		const result = await executor.execute(auth, op, {});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.warnings).toBeDefined();
			expect(result.warnings!.length).toBeGreaterThan(0);
		}
	});

	test("execute skips validation when no responseSchema", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ data: "ok" }), { status: 200 })) as unknown as typeof fetch;

		const auth: ResolvedAuth = { headers: { Authorization: "test" }, baseUrl: "https://api.example.com" };
		const op: ApiOperation = {
			name: "test_op",
			description: "Test",
			method: "GET",
			path: "/test",
			dangerLevel: "low",
			parameters: [],
		};
		const executor = new ApiExecutor();
		const result = await executor.execute(auth, op, {});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.warnings).toBeUndefined();
		}
	});
});

describe("ApiExecutor — cache auth scoping", () => {
	afterEach(() => {
		globalThis.fetch = undefined as unknown as typeof fetch;
	});

	test("GET cache is scoped by auth context", async () => {
		const getOp: ApiOperation = {
			name: "list_items",
			description: "List",
			method: "GET",
			path: "/api/items",
			dangerLevel: "low",
			parameters: [],
		};
		let callCount = 0;
		globalThis.fetch = (async () => {
			callCount++;
			return new Response(JSON.stringify({ items: [callCount] }), { status: 200 });
		}) as unknown as typeof fetch;

		const executor = new ApiExecutor();
		const auth1: ResolvedAuth = { headers: { Authorization: "Token-A" }, baseUrl: "https://api.example.com" };
		const auth2: ResolvedAuth = { headers: { Authorization: "Token-B" }, baseUrl: "https://api.example.com" };

		await executor.execute(auth1, getOp, {});
		await executor.execute(auth2, getOp, {}); // different auth, must NOT use cache
		expect(callCount).toBe(2);
	});
});
