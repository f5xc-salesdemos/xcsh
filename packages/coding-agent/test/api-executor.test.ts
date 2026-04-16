import { afterEach, describe, expect, test } from "bun:test";
import { ApiExecutor } from "../src/services/api-executor";
import type { ApiAuthConfig, ApiOperation } from "../src/services/api-types";

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
		delete process.env["TEST_API_TOKEN"];
		delete process.env["TEST_BASE_URL"];
	});

	test("builds APIToken header from env var", () => {
		process.env["TEST_API_TOKEN"] = "mytoken";
		process.env["TEST_BASE_URL"] = "https://api.example.com";

		const executor = new ApiExecutor();
		const auth = executor.resolveAuth(TEST_AUTH);

		expect(auth.headers["Authorization"]).toBe("APIToken mytoken");
		expect(auth.baseUrl).toBe("https://api.example.com");
	});

	test("throws when token env var is missing", () => {
		delete process.env["TEST_API_TOKEN"];
		process.env["TEST_BASE_URL"] = "https://api.example.com";

		const executor = new ApiExecutor();
		expect(() => executor.resolveAuth(TEST_AUTH)).toThrow("Missing required environment variable: TEST_API_TOKEN");
	});

	test("throws when base URL env var is missing", () => {
		process.env["TEST_API_TOKEN"] = "mytoken";
		delete process.env["TEST_BASE_URL"];

		const executor = new ApiExecutor();
		expect(() => executor.resolveAuth(TEST_AUTH)).toThrow("Missing required environment variable: TEST_BASE_URL");
	});
});

describe("ApiExecutor.resolveParams()", () => {
	test("applies env-var defaults for omitted params", () => {
		process.env["DEFAULT_NS"] = "my-namespace";
		const opWithDefault: ApiOperation = {
			...LIST_OP,
			parameters: [{ name: "namespace", in: "path", required: true, type: "string", default: "$DEFAULT_NS" }],
		};

		const executor = new ApiExecutor();
		const resolved = executor.resolveParams(opWithDefault, {});
		expect(resolved["namespace"]).toBe("my-namespace");

		delete process.env["DEFAULT_NS"];
	});

	test("explicit params override defaults", () => {
		process.env["DEFAULT_NS"] = "my-namespace";
		const opWithDefault: ApiOperation = {
			...LIST_OP,
			parameters: [{ name: "namespace", in: "path", required: true, type: "string", default: "$DEFAULT_NS" }],
		};

		const executor = new ApiExecutor();
		const resolved = executor.resolveParams(opWithDefault, { namespace: "other-ns" });
		expect(resolved["namespace"]).toBe("other-ns");

		delete process.env["DEFAULT_NS"];
	});
});
