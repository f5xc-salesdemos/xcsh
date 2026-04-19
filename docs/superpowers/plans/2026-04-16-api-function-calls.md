# API Function Calls Framework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4 built-in tools (`api_services`, `api_discover`, `api_call`, `api_describe`) to xcsh that let the LLM make deterministic F5XC API calls from a vendor-supplied operation catalog, replacing ad-hoc curl exploration.

**Architecture:** Vendor catalogs (`api-catalog.json`) ship as marketplace plugins. A catalog loader discovers them at session start. An HTTP executor resolves path templates, injects auth, and calls `fetch()`. Four AgentTool classes expose this as LLM-callable tools with a combined ~600-token system prompt footprint.

**Tech Stack:** TypeScript, Bun, `@sinclair/typebox`, `bun:test`, `node:fs/promises`, `node:path`

**Worktree:** `/workspace/xcsh/.worktrees/feature/function-calls/`

**Spec:** `docs/superpowers/specs/2026-04-16-api-function-calls-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/coding-agent/src/services/api-types.ts` | Create | All shared TypeScript interfaces |
| `packages/coding-agent/src/services/api-catalog.ts` | Create | Discover, load, and search operation catalogs |
| `packages/coding-agent/src/services/api-executor.ts` | Create | Auth injection, path resolution, HTTP fetch |
| `packages/coding-agent/src/tools/api-tool.ts` | Create | 4 AgentTool classes wired to catalog + executor |
| `packages/coding-agent/src/tools/index.ts` | Modify | Register 4 new tools in BUILTIN_TOOLS |
| `packages/coding-agent/test/api-catalog.test.ts` | Create | Unit tests for catalog loader |
| `packages/coding-agent/test/api-executor.test.ts` | Create | Unit tests for executor |
| `packages/coding-agent/test/api-tool.test.ts` | Create | Integration tests for tools |
| `marketplace/plugins/f5xc-platform/api-catalog.json` | Create | F5XC operation catalog (20 operations) |

---

## Task 1: Type Definitions

**Files:**
- Create: `packages/coding-agent/src/services/api-types.ts`

No tests needed for pure type definitions.

- [ ] **Step 1.1: Write the type file**

```typescript
// packages/coding-agent/src/services/api-types.ts

export type ApiAuthType = "api_token" | "bearer" | "basic" | "custom";

export type ApiDangerLevel = "low" | "medium" | "high" | "critical";

export type ApiParamLocation = "path" | "query" | "body";

export interface ApiParameter {
	name: string;
	in: ApiParamLocation;
	required: boolean;
	type: string;
	description?: string;
	default?: string; // "$ENV_VAR" syntax for env-resolved defaults
	example?: unknown;
}

export interface ApiOperation {
	name: string;
	description: string;
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	dangerLevel: ApiDangerLevel;
	parameters?: ApiParameter[];
	bodySchema?: Record<string, unknown>;
	prerequisites?: string[];
	commonErrors?: Array<{ code: number; reason: string; solution: string }>;
	bestPractices?: string[];
}

export interface ApiCategory {
	name: string;
	displayName: string;
	operations: ApiOperation[];
}

export interface ApiAuthConfig {
	type: ApiAuthType;
	// api_token / bearer
	headerName?: string;
	headerTemplate?: string; // "APIToken {token}"
	tokenSource?: string; // env var name, e.g. "F5XC_API_TOKEN"
	// basic
	usernameSource?: string;
	passwordSource?: string;
	// custom
	headerValueSource?: string;
	// base URL
	baseUrlSource: string; // env var name, e.g. "F5XC_API_URL"
}

export interface ApiDefaults {
	[paramName: string]: { source: string }; // source = env var name
}

export interface ApiCatalog {
	service: string;
	displayName: string;
	version: string;
	specSource?: string;
	auth: ApiAuthConfig;
	defaults?: ApiDefaults;
	categories: ApiCategory[];
}

export interface ApiCatalogMeta {
	service: string;
	displayName: string;
	version: string;
	filePath: string;
	operationCount: number;
	categories: string[];
}

// Resolved auth headers for a request
export interface ResolvedAuth {
	headers: Record<string, string>;
	baseUrl: string;
}
```

- [ ] **Step 1.2: Commit**

```bash
git add packages/coding-agent/src/services/api-types.ts
git commit -m "feat(coding-agent): add API framework type definitions"
```

---

## Task 2: Catalog Loader

**Files:**
- Create: `packages/coding-agent/src/services/api-catalog.ts`
- Create: `packages/coding-agent/test/api-catalog.test.ts`

- [ ] **Step 2.1: Write the failing test**

```typescript
// packages/coding-agent/test/api-catalog.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ApiCatalogService } from "@f5xc-salesdemos/xcsh/services/api-catalog";

const MINIMAL_CATALOG = {
	service: "test-svc",
	displayName: "Test Service",
	version: "1.0.0",
	auth: { type: "api_token", headerName: "Authorization", headerTemplate: "APIToken {token}", tokenSource: "TEST_TOKEN", baseUrlSource: "TEST_URL" },
	categories: [
		{
			name: "items",
			displayName: "Items",
			operations: [
				{ name: "list_items", description: "List items", method: "GET", path: "/api/items", dangerLevel: "low" },
				{ name: "get_item", description: "Get an item", method: "GET", path: "/api/items/{id}", dangerLevel: "low", parameters: [{ name: "id", in: "path", required: true, type: "string" }] },
				{ name: "create_item", description: "Create an item", method: "POST", path: "/api/items", dangerLevel: "medium" },
				{ name: "delete_item", description: "Delete an item", method: "DELETE", path: "/api/items/{id}", dangerLevel: "high", parameters: [{ name: "id", in: "path", required: true, type: "string" }] },
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
		const catalogPath = path.join(tmpDir, "api-catalog.json");
		await Bun.write(catalogPath, JSON.stringify(MINIMAL_CATALOG));

		const svc = new ApiCatalogService([tmpDir]);
		const ops = await svc.getOperations("test-svc");

		expect(ops).toHaveLength(4);
		expect(ops.map(o => o.name)).toContain("list_items");
	});

	test("getOperations() filters by category", async () => {
		const catalogPath = path.join(tmpDir, "api-catalog.json");
		await Bun.write(catalogPath, JSON.stringify(MINIMAL_CATALOG));

		const svc = new ApiCatalogService([tmpDir]);
		const ops = await svc.getOperations("test-svc", "items");

		expect(ops).toHaveLength(4);
	});

	test("getOperations() returns empty for unknown category", async () => {
		const catalogPath = path.join(tmpDir, "api-catalog.json");
		await Bun.write(catalogPath, JSON.stringify(MINIMAL_CATALOG));

		const svc = new ApiCatalogService([tmpDir]);
		const ops = await svc.getOperations("test-svc", "nonexistent");

		expect(ops).toHaveLength(0);
	});

	test("getOperation() returns a single operation by name", async () => {
		const catalogPath = path.join(tmpDir, "api-catalog.json");
		await Bun.write(catalogPath, JSON.stringify(MINIMAL_CATALOG));

		const svc = new ApiCatalogService([tmpDir]);
		const op = await svc.getOperation("test-svc", "get_item");

		expect(op).not.toBeNull();
		expect(op?.name).toBe("get_item");
		expect(op?.method).toBe("GET");
	});

	test("getOperation() returns null for unknown operation", async () => {
		const catalogPath = path.join(tmpDir, "api-catalog.json");
		await Bun.write(catalogPath, JSON.stringify(MINIMAL_CATALOG));

		const svc = new ApiCatalogService([tmpDir]);
		const op = await svc.getOperation("test-svc", "nonexistent");

		expect(op).toBeNull();
	});

	test("search() matches on operation name", async () => {
		const catalogPath = path.join(tmpDir, "api-catalog.json");
		await Bun.write(catalogPath, JSON.stringify(MINIMAL_CATALOG));

		const svc = new ApiCatalogService([tmpDir]);
		const results = await svc.search("test-svc", "list");

		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("list_items");
	});

	test("search() matches on description", async () => {
		const catalogPath = path.join(tmpDir, "api-catalog.json");
		await Bun.write(catalogPath, JSON.stringify(MINIMAL_CATALOG));

		const svc = new ApiCatalogService([tmpDir]);
		const results = await svc.search("test-svc", "Create");

		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("create_item");
	});

	test("getCatalog() returns auth config", async () => {
		const catalogPath = path.join(tmpDir, "api-catalog.json");
		await Bun.write(catalogPath, JSON.stringify(MINIMAL_CATALOG));

		const svc = new ApiCatalogService([tmpDir]);
		const catalog = await svc.getCatalog("test-svc");

		expect(catalog?.auth.type).toBe("api_token");
		expect(catalog?.auth.tokenSource).toBe("TEST_TOKEN");
	});

	test("getServices() scans nested plugin directories", async () => {
		// Simulate marketplace plugin layout: searchDir/marketplaces/foo/plugins/bar/api-catalog.json
		const pluginDir = path.join(tmpDir, "marketplaces", "foo", "plugins", "bar");
		await fs.mkdir(pluginDir, { recursive: true });
		await Bun.write(path.join(pluginDir, "api-catalog.json"), JSON.stringify(MINIMAL_CATALOG));

		const svc = new ApiCatalogService([tmpDir]);
		const services = await svc.getServices();

		expect(services).toHaveLength(1);
	});
});
```

- [ ] **Step 2.2: Run the failing test**

```bash
bun test --cwd packages/coding-agent --filter api-catalog
```

Expected: FAIL — `Cannot find module '@f5xc-salesdemos/xcsh/services/api-catalog'`

- [ ] **Step 2.3: Implement `ApiCatalogService`**

```typescript
// packages/coding-agent/src/services/api-catalog.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@f5xc-salesdemos/pi-utils";
import type { ApiCatalog, ApiCatalogMeta, ApiOperation } from "./api-types";

export class ApiCatalogService {
	// Parsed catalogs keyed by service name
	#catalogs = new Map<string, ApiCatalog>();
	// Metadata only (cheap), populated on first getServices()
	#meta = new Map<string, ApiCatalogMeta>();
	#searchPaths: string[];
	#scanned = false;

	constructor(searchPaths: string[]) {
		this.#searchPaths = searchPaths;
	}

	async getServices(): Promise<ApiCatalogMeta[]> {
		if (!this.#scanned) {
			await this.#scan();
		}
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
		return ops.filter(
			o => o.name.toLowerCase().includes(q) || o.description.toLowerCase().includes(q),
		);
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
				// Cache the parsed catalog immediately — we already parsed it
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
			return await Bun.file(filePath).json() as ApiCatalog;
		} catch {
			return null;
		}
	}
}
```

- [ ] **Step 2.4: Run the tests**

```bash
bun test --cwd packages/coding-agent --filter api-catalog
```

Expected: all 10 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add packages/coding-agent/src/services/api-catalog.ts packages/coding-agent/test/api-catalog.test.ts
git commit -m "feat(coding-agent): add ApiCatalogService with TDD"
```

---

## Task 3: HTTP Executor

**Files:**
- Create: `packages/coding-agent/src/services/api-executor.ts`
- Create: `packages/coding-agent/test/api-executor.test.ts`

- [ ] **Step 3.1: Write the failing test**

```typescript
// packages/coding-agent/test/api-executor.test.ts
import { describe, expect, test, spyOn, afterEach, mock } from "bun:test";
import { ApiExecutor } from "@f5xc-salesdemos/xcsh/services/api-executor";
import type { ApiAuthConfig, ApiOperation } from "@f5xc-salesdemos/xcsh/services/api-types";

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

const GET_OP: ApiOperation = {
	name: "get_item",
	description: "Get an item",
	method: "GET",
	path: "/api/items/{id}",
	dangerLevel: "low",
	parameters: [{ name: "id", in: "path", required: true, type: "string" }],
};

const CREATE_OP: ApiOperation = {
	name: "create_item",
	description: "Create an item",
	method: "POST",
	path: "/api/items",
	dangerLevel: "medium",
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

describe("ApiExecutor.resolveAuthHeaders()", () => {
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
		expect(() => executor.resolveAuth(TEST_AUTH)).toThrow(
			"Missing required environment variable: TEST_API_TOKEN",
		);
	});

	test("throws when base URL env var is missing", () => {
		process.env["TEST_API_TOKEN"] = "mytoken";
		delete process.env["TEST_BASE_URL"];

		const executor = new ApiExecutor();
		expect(() => executor.resolveAuth(TEST_AUTH)).toThrow(
			"Missing required environment variable: TEST_BASE_URL",
		);
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
```

- [ ] **Step 3.2: Run the failing tests**

```bash
bun test --cwd packages/coding-agent --filter api-executor
```

Expected: FAIL — `Cannot find module '@f5xc-salesdemos/xcsh/services/api-executor'`

- [ ] **Step 3.3: Implement `ApiExecutor`**

```typescript
// packages/coding-agent/src/services/api-executor.ts
import { logger } from "@f5xc-salesdemos/pi-utils";
import type { ApiAuthConfig, ApiOperation, ResolvedAuth } from "./api-types";

export class ApiExecutor {
	resolveAuth(auth: ApiAuthConfig): ResolvedAuth {
		const baseUrl = this.#requireEnv(auth.baseUrlSource);

		let headers: Record<string, string> = {};

		if (auth.type === "api_token" || auth.type === "bearer") {
			const token = this.#requireEnv(auth.tokenSource!);
			const headerValue = (auth.headerTemplate ?? "{token}").replace("{token}", token);
			headers[auth.headerName ?? "Authorization"] = headerValue;
		} else if (auth.type === "basic") {
			const username = this.#requireEnv(auth.usernameSource!);
			const password = this.#requireEnv(auth.passwordSource!);
			const encoded = btoa(`${username}:${password}`);
			headers["Authorization"] = `Basic ${encoded}`;
		} else if (auth.type === "custom") {
			const value = this.#requireEnv(auth.headerValueSource!);
			headers[auth.headerName!] = value;
		}

		return { headers, baseUrl };
	}

	resolveParams(op: ApiOperation, userParams: Record<string, unknown>): Record<string, string> {
		const resolved: Record<string, string> = {};

		for (const [key, value] of Object.entries(userParams)) {
			resolved[key] = String(value);
		}

		for (const param of op.parameters ?? []) {
			if (resolved[param.name] !== undefined) continue;
			if (!param.default) continue;

			if (param.default.startsWith("$")) {
				const envVar = param.default.slice(1);
				const envValue = process.env[envVar];
				if (envValue) resolved[param.name] = envValue;
			} else {
				resolved[param.name] = param.default;
			}
		}

		return resolved;
	}

	resolveUrl(baseUrl: string, pathTemplate: string, pathParams: Record<string, string>, queryParams?: Record<string, string>): string {
		let resolved = pathTemplate;
		for (const [key, value] of Object.entries(pathParams)) {
			resolved = resolved.replace(`{${key}}`, encodeURIComponent(value));
		}

		const url = baseUrl.replace(/\/$/, "") + resolved;

		if (queryParams && Object.keys(queryParams).length > 0) {
			const qs = new URLSearchParams(queryParams);
			return `${url}?${qs.toString()}`;
		}

		return url;
	}

	async execute(
		auth: ResolvedAuth,
		op: ApiOperation,
		resolvedParams: Record<string, string>,
		body?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
		// Split path vs query params
		const pathParams: Record<string, string> = {};
		const queryParams: Record<string, string> = {};

		for (const param of op.parameters ?? []) {
			const value = resolvedParams[param.name];
			if (value === undefined) continue;
			if (param.in === "path") pathParams[param.name] = value;
			else if (param.in === "query") queryParams[param.name] = value;
		}

		const url = this.resolveUrl(auth.baseUrl, op.path, pathParams, queryParams);

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...auth.headers,
		};

		const init: RequestInit = {
			method: op.method,
			headers,
			signal,
		};

		if (body && ["POST", "PUT", "PATCH"].includes(op.method)) {
			init.body = JSON.stringify(body);
		}

		logger.debug("ApiExecutor: executing request", { method: op.method, url });

		let response: Response;
		try {
			response = await fetch(url, init);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, status: 0, error: `Network error: ${message}` };
		}

		const text = await response.text();
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			data = text;
		}

		if (!response.ok) {
			const errMsg = typeof data === "object" && data !== null && "message" in data
				? (data as { message: string }).message
				: text;
			logger.debug("ApiExecutor: request failed", { status: response.status, url });
			return { ok: false, status: response.status, error: `HTTP ${response.status}: ${errMsg}` };
		}

		return { ok: true, data };
	}

	#requireEnv(name: string): string {
		const value = process.env[name];
		if (!value) throw new Error(`Missing required environment variable: ${name}`);
		return value;
	}
}
```

- [ ] **Step 3.4: Run the tests**

```bash
bun test --cwd packages/coding-agent --filter api-executor
```

Expected: all tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add packages/coding-agent/src/services/api-executor.ts packages/coding-agent/test/api-executor.test.ts
git commit -m "feat(coding-agent): add ApiExecutor with TDD"
```

---

## Task 4: API Tools

**Files:**
- Create: `packages/coding-agent/src/tools/api-tool.ts`
- Create: `packages/coding-agent/test/api-tool.test.ts`
- Modify: `packages/coding-agent/src/tools/index.ts`

The 4 tools (`api_services`, `api_discover`, `api_describe`, `api_call`) live in one file since they share the same `ApiCatalogService` and `ApiExecutor` dependencies. Each is a separate class.

- [ ] **Step 4.1: Write the failing tests**

```typescript
// packages/coding-agent/test/api-tool.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ApiServicesTool, ApiDiscoverTool, ApiDescribeTool, ApiCallTool } from "@f5xc-salesdemos/xcsh/tools/api-tool";
import { ApiCatalogService } from "@f5xc-salesdemos/xcsh/services/api-catalog";
import { ApiExecutor } from "@f5xc-salesdemos/xcsh/services/api-executor";

const TEST_CATALOG = {
	service: "test-svc",
	displayName: "Test Service",
	version: "1.0.0",
	auth: { type: "api_token", headerName: "Authorization", headerTemplate: "APIToken {token}", tokenSource: "TEST_TOKEN", baseUrlSource: "TEST_URL" },
	defaults: { namespace: { source: "TEST_NS" } },
	categories: [
		{
			name: "items",
			displayName: "Items",
			operations: [
				{ name: "list_items", description: "List all items", method: "GET", path: "/api/items", dangerLevel: "low", parameters: [{ name: "namespace", in: "path", required: true, type: "string", default: "$TEST_NS" }] },
				{ name: "delete_item", description: "Delete an item", method: "DELETE", path: "/api/items/{id}", dangerLevel: "high", parameters: [{ name: "id", in: "path", required: true, type: "string" }] },
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
		process.env["TEST_TOKEN"] = "test-token-123";
		process.env["TEST_URL"] = "https://api.example.com";
		process.env["TEST_NS"] = "default";
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		delete process.env["TEST_TOKEN"];
		delete process.env["TEST_URL"];
		delete process.env["TEST_NS"];
	});

	test("executes a low-danger GET operation and returns JSON response", async () => {
		const mockItems = [{ id: "1", name: "item-one" }];

		// Mock global fetch
		const origFetch = globalThis.fetch;
		globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
			return new Response(JSON.stringify(mockItems), { status: 200, headers: { "Content-Type": "application/json" } });
		};

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
		globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}));
			return new Response(JSON.stringify({}), { status: 200 });
		};

		const catalog = new ApiCatalogService([tmpDir]);
		const executor = new ApiExecutor();
		const tool = new ApiCallTool(catalog, executor);

		await tool.execute("id1", { service: "test-svc", operation: "list_items" });
		expect(capturedHeaders["Authorization"]).toBe("APIToken test-token-123");

		globalThis.fetch = origFetch;
	});

	test("returns error on API 404 response", async () => {
		const origFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });

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
});
```

- [ ] **Step 4.2: Run the failing tests**

```bash
bun test --cwd packages/coding-agent --filter api-tool
```

Expected: FAIL — `Cannot find module '@f5xc-salesdemos/xcsh/tools/api-tool'`

- [ ] **Step 4.3: Implement the 4 tool classes**

> **Import path check:** Before implementing, verify the correct import path for `AgentTool` and `AgentToolResult` by running:
> `grep -n "AgentTool" packages/coding-agent/src/tools/calculator.ts | head -3`
> Copy the import line from there rather than guessing.

```typescript
// packages/coding-agent/src/tools/api-tool.ts
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@f5xc-salesdemos/pi-agent-core"; // verify path from calculator.ts
import type { ApiCatalogService } from "../services/api-catalog";
import type { ApiExecutor } from "../services/api-executor";

// ─── api_services ───────────────────────────────────────────────────────────

const servicesSchema = Type.Object({});

export class ApiServicesTool implements AgentTool<typeof servicesSchema> {
	readonly name = "api_services";
	readonly label = "List API Services";
	readonly description = "List all vendor API services available in the current session. Returns service names, operation counts, and category names.";
	readonly parameters = servicesSchema;

	#catalog: ApiCatalogService;

	constructor(catalog: ApiCatalogService) {
		this.#catalog = catalog;
	}

	async execute(_toolCallId: string, _params: Static<typeof servicesSchema>, _signal?: AbortSignal): Promise<AgentToolResult> {
		const services = await this.#catalog.getServices();

		if (services.length === 0) {
			return { content: [{ type: "text", text: "No API catalogs installed. Add an api-catalog.json to a marketplace plugin directory." }] };
		}

		const lines = services.map(s =>
			`- **${s.service}** (${s.displayName}) — ${s.operationCount} operations in: ${s.categories.join(", ")}`,
		);

		return { content: [{ type: "text", text: `Available API services:\n\n${lines.join("\n")}` }] };
	}
}

// ─── api_discover ────────────────────────────────────────────────────────────

const discoverSchema = Type.Object({
	service: Type.String({ description: "Vendor service name (e.g., 'f5xc')" }),
	category: Type.Optional(Type.String({ description: "Narrow results to a specific category" })),
	search: Type.Optional(Type.String({ description: "Fuzzy match on operation name or description" })),
});

export class ApiDiscoverTool implements AgentTool<typeof discoverSchema> {
	readonly name = "api_discover";
	readonly label = "Discover API Operations";
	readonly description = "Browse available operations for an installed vendor API service. Returns operation names, HTTP methods, and danger levels. Optionally filter by category or search term.";
	readonly parameters = discoverSchema;

	#catalog: ApiCatalogService;

	constructor(catalog: ApiCatalogService) {
		this.#catalog = catalog;
	}

	async execute(_toolCallId: string, { service, category, search }: Static<typeof discoverSchema>, _signal?: AbortSignal): Promise<AgentToolResult> {
		const services = await this.#catalog.getServices();
		if (!services.find(s => s.service === service)) {
			const names = services.map(s => s.service).join(", ") || "none";
			return { content: [{ type: "text", text: `Service '${service}' not found. Available: ${names}` }] };
		}

		let ops = search
			? await this.#catalog.search(service, search)
			: await this.#catalog.getOperations(service, category);

		if (ops.length === 0) {
			return { content: [{ type: "text", text: `No operations found for service '${service}'${category ? ` in category '${category}'` : ""}${search ? ` matching '${search}'` : ""}.` }] };
		}

		const lines = ops.map(op =>
			`- **${op.name}** [${op.method}] (${op.dangerLevel}) — ${op.description}`,
		);

		const header = `Operations for ${service}${category ? ` / ${category}` : ""}:\n\n`;
		return { content: [{ type: "text", text: header + lines.join("\n") }] };
	}
}

// ─── api_describe ─────────────────────────────────────────────────────────────

const describeSchema = Type.Object({
	service: Type.String({ description: "Vendor service name" }),
	operation: Type.String({ description: "Operation name to describe" }),
});

export class ApiDescribeTool implements AgentTool<typeof describeSchema> {
	readonly name = "api_describe";
	readonly label = "Describe API Operation";
	readonly description = "Get full details for a single API operation: parameters, body schema, danger level, prerequisites, and common errors. Call before create/update/delete operations.";
	readonly parameters = describeSchema;

	#catalog: ApiCatalogService;

	constructor(catalog: ApiCatalogService) {
		this.#catalog = catalog;
	}

	async execute(_toolCallId: string, { service, operation }: Static<typeof describeSchema>, _signal?: AbortSignal): Promise<AgentToolResult> {
		const op = await this.#catalog.getOperation(service, operation);
		if (!op) {
			return { content: [{ type: "text", text: `Operation '${operation}' not found in service '${service}'. Use api_discover to browse available operations.` }] };
		}

		const parts: string[] = [
			`**${op.name}**`,
			`Method: ${op.method}  Path: ${op.path}  Danger: ${op.dangerLevel}`,
			``,
			op.description,
		];

		if (op.parameters && op.parameters.length > 0) {
			parts.push(``, `**Parameters:**`);
			for (const p of op.parameters) {
				const req = p.required ? "required" : "optional";
				const def = p.default ? ` (default: ${p.default})` : "";
				parts.push(`- \`${p.name}\` [${p.in}] ${req} ${p.type}${def}${p.description ? ` — ${p.description}` : ""}`);
			}
		}

		if (op.prerequisites && op.prerequisites.length > 0) {
			parts.push(``, `**Prerequisites:**`);
			parts.push(...op.prerequisites.map(p => `- ${p}`));
		}

		if (op.commonErrors && op.commonErrors.length > 0) {
			parts.push(``, `**Common Errors:**`);
			parts.push(...op.commonErrors.map(e => `- HTTP ${e.code}: ${e.reason} → ${e.solution}`));
		}

		if (op.bestPractices && op.bestPractices.length > 0) {
			parts.push(``, `**Best Practices:**`);
			parts.push(...op.bestPractices.map(b => `- ${b}`));
		}

		return { content: [{ type: "text", text: parts.join("\n") }] };
	}
}

// ─── api_call ─────────────────────────────────────────────────────────────────

const callSchema = Type.Object({
	service: Type.String({ description: "Vendor service name (e.g., 'f5xc')" }),
	operation: Type.String({ description: "Operation name from catalog (e.g., 'list_http_loadbalancers')" }),
	params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Path, query, or named parameters for the operation" })),
	body: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Request body for POST/PUT/PATCH operations" })),
});

const DANGER_NOTICE: Record<string, string> = {
	high: "⚠️  This is a high-danger operation (update/replace). Proceeding.",
	critical: "🛑  This is a critical-danger operation and cannot be executed automatically. Describe what you want and the user will confirm.",
};

export class ApiCallTool implements AgentTool<typeof callSchema> {
	readonly name = "api_call";
	readonly label = "Call API";
	readonly description = "Execute a vendor API operation deterministically. Resolves auth from environment variables, substitutes path parameters, and returns the JSON response. For unfamiliar operations use api_discover first, for body shape use api_describe first.";
	readonly parameters = callSchema;

	#catalog: ApiCatalogService;
	#executor: ApiExecutor;

	constructor(catalog: ApiCatalogService, executor: ApiExecutor) {
		this.#catalog = catalog;
		this.#executor = executor;
	}

	async execute(_toolCallId: string, { service, operation, params, body }: Static<typeof callSchema>, signal?: AbortSignal): Promise<AgentToolResult> {
		// Look up operation
		const op = await this.#catalog.getOperation(service, operation);
		if (!op) {
			return { content: [{ type: "text", text: `Operation '${operation}' not found in service '${service}'. Use api_discover to list available operations.` }] };
		}

		// Block critical operations
		if (op.dangerLevel === "critical") {
			return { content: [{ type: "text", text: DANGER_NOTICE.critical }] };
		}

		// Look up catalog for auth config
		const catalog = await this.#catalog.getCatalog(service);
		if (!catalog) {
			return { content: [{ type: "text", text: `Catalog for service '${service}' could not be loaded.` }] };
		}

		// Resolve auth
		let resolvedAuth;
		try {
			resolvedAuth = this.#executor.resolveAuth(catalog.auth);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text", text: `Authentication error: ${message}` }] };
		}

		// Resolve parameters (merge with catalog defaults)
		const userParams = params ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) : {};
		const resolvedParams = this.#executor.resolveParams(op, userParams);

		// Execute
		const result = await this.#executor.execute(resolvedAuth, op, resolvedParams, body as Record<string, unknown> | undefined, signal);

		const prefix = op.dangerLevel === "high" ? `${DANGER_NOTICE.high}\n\n` : "";

		if (!result.ok) {
			return { content: [{ type: "text", text: `${prefix}Error: ${result.error}` }] };
		}

		const responseText = typeof result.data === "string"
			? result.data
			: JSON.stringify(result.data, null, 2);

		return { content: [{ type: "text", text: `${prefix}${responseText}` }] };
	}
}
```

- [ ] **Step 4.4: Run the tests**

```bash
bun test --cwd packages/coding-agent --filter api-tool
```

Expected: all tests pass.

- [ ] **Step 4.5: Run type check**

```bash
bun run check:ts
```

Expected: zero TypeScript errors.

- [ ] **Step 4.6: Register tools in BUILTIN_TOOLS**

Find the imports section near the top of `packages/coding-agent/src/tools/index.ts` and add the import. Then find the `BUILTIN_TOOLS` object and add the four entries.

```typescript
// Add import near other tool imports at the top of tools/index.ts:
import {
   ApiServicesTool,
   ApiDiscoverTool,
   ApiDescribeTool,
   ApiCallTool,
} from "./api-tool";
import { ApiCatalogService } from "../services/api-catalog";
import { ApiExecutor } from "../services/api-executor";
import * as os from "node:os";
import * as path from "node:path";
```

```typescript
// Add to BUILTIN_TOOLS (find the object, add at the end before the closing brace):
   api_services: s => {
      const catalog = new ApiCatalogService([path.join(os.homedir(), ".claude", "plugins")]);
      return new ApiServicesTool(catalog);
   },
   api_discover: s => {
      const catalog = new ApiCatalogService([path.join(os.homedir(), ".claude", "plugins")]);
      return new ApiDiscoverTool(catalog);
   },
   api_describe: s => {
      const catalog = new ApiCatalogService([path.join(os.homedir(), ".claude", "plugins")]);
      return new ApiDescribeTool(catalog);
   },
   api_call: s => {
      const catalog = new ApiCatalogService([path.join(os.homedir(), ".claude", "plugins")]);
      const executor = new ApiExecutor();
      return new ApiCallTool(catalog, executor);
   },
```

> **Note:** Each factory creates a new `ApiCatalogService`. This is acceptable because the service deduplicates via its scan cache. If sharing state between tools is needed, the session can hold a shared instance (refactor as needed).

- [ ] **Step 4.7: Run type check after registration**

```bash
bun run check:ts
```

Expected: zero errors.

- [ ] **Step 4.8: Run full test suite, compare to baseline**

```bash
bun test 2>&1 | tee /tmp/current.txt
BASELINE=8
CURRENT=$(grep -o '[0-9]* fail' /tmp/current.txt | grep -o '[0-9]*' || echo 0)
echo "Baseline: ${BASELINE} | Current: ${CURRENT}"
[ "${CURRENT}" -le "${BASELINE}" ] && echo "OK" || echo "BLOCKER: new failures"
```

Expected: failure count at or below baseline (8).

- [ ] **Step 4.9: Commit**

```bash
git add packages/coding-agent/src/tools/api-tool.ts packages/coding-agent/test/api-tool.test.ts packages/coding-agent/src/tools/index.ts
git commit -m "feat(coding-agent): add api_services, api_discover, api_describe, api_call tools"
```

---

## Task 5: F5XC Operation Catalog

**Files:**
- Create: `marketplace/plugins/f5xc-platform/api-catalog.json`

This is a hand-crafted catalog covering the 20 most common F5XC namespace operations. It uses the URL patterns observed from the live API and the `/workspace/marketplace/plugins/f5xc-platform/skills/api-operations/` reference files.

- [ ] **Step 5.1: Create the catalog file**

```json
{
   "service": "f5xc",
   "displayName": "F5 Distributed Cloud",
   "version": "1.0.0",
   "specSource": "f5xc-salesdemos/api-specs-enriched",
   "auth": {
      "type": "api_token",
      "headerName": "Authorization",
      "headerTemplate": "APIToken {token}",
      "tokenSource": "F5XC_API_TOKEN",
      "baseUrlSource": "F5XC_API_URL"
   },
   "defaults": {
      "namespace": { "source": "F5XC_NAMESPACE" }
   },
   "categories": [
      {
         "name": "load-balancers",
         "displayName": "Load Balancers",
         "operations": [
            {
               "name": "list_http_loadbalancers",
               "description": "List all HTTP load balancers in a namespace",
               "method": "GET",
               "path": "/api/config/namespaces/{namespace}/http_loadbalancers",
               "dangerLevel": "low",
               "parameters": [{ "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" }]
            },
            {
               "name": "get_http_loadbalancer",
               "description": "Get a specific HTTP load balancer by name",
               "method": "GET",
               "path": "/api/config/namespaces/{namespace}/http_loadbalancers/{name}",
               "dangerLevel": "low",
               "parameters": [
                  { "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" },
                  { "name": "name", "in": "path", "required": true, "type": "string" }
               ]
            },
            {
               "name": "delete_http_loadbalancer",
               "description": "Delete an HTTP load balancer by name",
               "method": "DELETE",
               "path": "/api/config/namespaces/{namespace}/http_loadbalancers/{name}",
               "dangerLevel": "high",
               "parameters": [
                  { "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" },
                  { "name": "name", "in": "path", "required": true, "type": "string" }
               ],
               "commonErrors": [
                  { "code": 404, "reason": "Load balancer not found", "solution": "Use list_http_loadbalancers to verify the name" },
                  { "code": 409, "reason": "Has dependent resources", "solution": "Remove virtual hosts or service policies referencing this LB first" }
               ]
            },
            {
               "name": "list_tcp_loadbalancers",
               "description": "List all TCP load balancers in a namespace",
               "method": "GET",
               "path": "/api/config/namespaces/{namespace}/tcp_loadbalancers",
               "dangerLevel": "low",
               "parameters": [{ "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" }]
            }
         ]
      },
      {
         "name": "origin-pools",
         "displayName": "Origin Pools",
         "operations": [
            {
               "name": "list_origin_pools",
               "description": "List all origin pools in a namespace",
               "method": "GET",
               "path": "/api/config/namespaces/{namespace}/origin_pools",
               "dangerLevel": "low",
               "parameters": [{ "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" }]
            },
            {
               "name": "get_origin_pool",
               "description": "Get a specific origin pool by name",
               "method": "GET",
               "path": "/api/config/namespaces/{namespace}/origin_pools/{name}",
               "dangerLevel": "low",
               "parameters": [
                  { "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" },
                  { "name": "name", "in": "path", "required": true, "type": "string" }
               ]
            },
            {
               "name": "delete_origin_pool",
               "description": "Delete an origin pool by name",
               "method": "DELETE",
               "path": "/api/config/namespaces/{namespace}/origin_pools/{name}",
               "dangerLevel": "high",
               "parameters": [
                  { "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" },
                  { "name": "name", "in": "path", "required": true, "type": "string" }
               ],
               "prerequisites": ["Ensure no load balancers reference this origin pool before deleting"]
            }
         ]
      },
      {
         "name": "security",
         "displayName": "Security",
         "operations": [
            {
               "name": "list_app_firewalls",
               "description": "List all WAF/app firewall policies in a namespace",
               "method": "GET",
               "path": "/api/config/namespaces/{namespace}/app_firewalls",
               "dangerLevel": "low",
               "parameters": [{ "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" }]
            },
            {
               "name": "get_app_firewall",
               "description": "Get a specific app firewall policy by name",
               "method": "GET",
               "path": "/api/config/namespaces/{namespace}/app_firewalls/{name}",
               "dangerLevel": "low",
               "parameters": [
                  { "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" },
                  { "name": "name", "in": "path", "required": true, "type": "string" }
               ]
            },
            {
               "name": "list_service_policys",
               "description": "List all service policies in a namespace",
               "method": "GET",
               "path": "/api/config/namespaces/{namespace}/service_policys",
               "dangerLevel": "low",
               "parameters": [{ "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" }]
            },
            {
               "name": "get_service_policy",
               "description": "Get a specific service policy by name",
               "method": "GET",
               "path": "/api/config/namespaces/{namespace}/service_policys/{name}",
               "dangerLevel": "low",
               "parameters": [
                  { "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" },
                  { "name": "name", "in": "path", "required": true, "type": "string" }
               ]
            }
         ]
      },
      {
         "name": "health-checks",
         "displayName": "Health Checks",
         "operations": [
            {
               "name": "list_healthchecks",
               "description": "List all health check configurations in a namespace",
               "method": "GET",
               "path": "/api/config/namespaces/{namespace}/healthchecks",
               "dangerLevel": "low",
               "parameters": [{ "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" }]
            },
            {
               "name": "get_healthcheck",
               "description": "Get a specific health check by name",
               "method": "GET",
               "path": "/api/config/namespaces/{namespace}/healthchecks/{name}",
               "dangerLevel": "low",
               "parameters": [
                  { "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" },
                  { "name": "name", "in": "path", "required": true, "type": "string" }
               ]
            }
         ]
      },
      {
         "name": "namespaces",
         "displayName": "Namespace Management",
         "operations": [
            {
               "name": "list_namespaces",
               "description": "List all namespaces in the tenant",
               "method": "GET",
               "path": "/api/web/namespaces",
               "dangerLevel": "low",
               "parameters": []
            },
            {
               "name": "get_namespace",
               "description": "Get details for a specific namespace",
               "method": "GET",
               "path": "/api/web/namespaces/{name}",
               "dangerLevel": "low",
               "parameters": [
                  { "name": "name", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" }
               ]
            }
         ]
      },
      {
         "name": "certificates",
         "displayName": "Certificates",
         "operations": [
            {
               "name": "list_certificates",
               "description": "List all TLS certificates in a namespace",
               "method": "GET",
               "path": "/api/config/namespaces/{namespace}/certificates",
               "dangerLevel": "low",
               "parameters": [{ "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" }]
            },
            {
               "name": "get_certificate",
               "description": "Get a specific certificate by name",
               "method": "GET",
               "path": "/api/config/namespaces/{namespace}/certificates/{name}",
               "dangerLevel": "low",
               "parameters": [
                  { "name": "namespace", "in": "path", "required": true, "type": "string", "default": "$F5XC_NAMESPACE" },
                  { "name": "name", "in": "path", "required": true, "type": "string" }
               ]
            }
         ]
      }
   ]
}
```

Save the above to `marketplace/plugins/f5xc-platform/api-catalog.json`.

- [ ] **Step 5.2: Verify catalog loads correctly**

```bash
node -e "
const catalog = require('/workspace/marketplace/plugins/f5xc-platform/api-catalog.json');
const count = catalog.categories.reduce((n,c) => n + c.operations.length, 0);
console.log('Service:', catalog.service);
console.log('Categories:', catalog.categories.map(c => c.name).join(', '));
console.log('Operations:', count);
"
```

Expected output:
```
Service: f5xc
Categories: load-balancers, origin-pools, security, health-checks, namespaces, certificates
Operations: 20
```

- [ ] **Step 5.3: Commit**

```bash
git add marketplace/plugins/f5xc-platform/api-catalog.json
git commit -m "feat: add F5XC API catalog with 20 namespace operations"
```

---

## Task 6: End-to-End Verification

- [ ] **Step 6.1: Run the full test suite one final time**

```bash
bun test 2>&1 | tee /tmp/final-test.txt
BASELINE=8
CURRENT=$(grep -o '[0-9]* fail' /tmp/final-test.txt | grep -o '[0-9]*' || echo 0)
echo "Baseline: ${BASELINE} | Current: ${CURRENT}"
[ "${CURRENT}" -le "${BASELINE}" ] && echo "OK — no new failures" || echo "BLOCKER: new failures introduced"
```

- [ ] **Step 6.2: Run type check**

```bash
bun run check:ts
```

Expected: zero TypeScript errors.

- [ ] **Step 6.3: Manual tool verification (requires F5XC env vars)**

If `F5XC_API_TOKEN`, `F5XC_API_URL`, and `F5XC_NAMESPACE` are set:

```bash
# Start xcsh and verify in a session:
# 1. api_services()
#    → lists f5xc with 20 operations

# 2. api_discover("f5xc", "load-balancers")
#    → shows list_http_loadbalancers, get_http_loadbalancer, delete_http_loadbalancer, list_tcp_loadbalancers

# 3. api_call("f5xc", "list_http_loadbalancers")
#    → returns real HTTP load balancer data from F5XC_NAMESPACE

# 4. api_describe("f5xc", "delete_http_loadbalancer")
#    → shows parameters, danger level (high), common errors
```

- [ ] **Step 6.4: Final commit tag**

```bash
git tag feature/function-calls-phase1
```

---

## What's NOT in This Plan (Phase 2)

- **Spec compiler** (`api-specs-enriched/scripts/compile_catalog.py`): auto-generates catalog JSON from OpenAPI specs. Separate plan.
- **Full F5XC catalog** (3,234 operations): generated by spec compiler. Separate plan.
- **Response caching** and **batch operations**: future enhancement.
