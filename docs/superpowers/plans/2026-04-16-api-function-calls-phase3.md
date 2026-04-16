# API Function Calls Phase 3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scale the API framework from 51 operations to ~3,676 by compiling enriched vendor specs, add scored fuzzy search, and introduce advisory response schema validation — all TDD.

**Architecture:** Three sequential stages — (1) add `--input-dir` to `compile_catalog.py` and compile the 40 enriched spec files into a full catalog, (2) replace the keyword-index search with scored relevance search in `ApiCatalogService`, (3) add a `validateResponse()` function and `responseSchema` type to `ApiExecutor` with advisory warnings.

**Tech Stack:** Python 3.11+ / pytest, TypeScript / Bun / `bun:test`

**IMPORTANT:** All `bun test` commands MUST use `--max-concurrency=1` to prevent CPU/RAM crashes.

**Worktrees:**
- Tasks 1–2: `/workspace/api-specs-enriched/`
- Tasks 3–6: `/workspace/xcsh/.worktrees/feature/function-calls/`

**Spec:** `docs/superpowers/specs/2026-04-16-api-function-calls-phase3-design.md`

---

## File Map

### api-specs-enriched repo

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/compile_catalog.py` | Modify | Add `merge_spec_files()` and `--input-dir` CLI flag |
| `tests/test_compile_catalog.py` | Modify | Add 5 tests for merge + input-dir |

### xcsh repo

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/coding-agent/src/services/api-catalog.ts` | Modify | Replace `search()` with scored fuzzy search |
| `packages/coding-agent/src/services/api-types.ts` | Modify | Add `responseSchema` to `ApiOperation` |
| `packages/coding-agent/src/services/api-executor.ts` | Modify | Add `validateResponse()`, attach warnings to success response |
| `marketplace/plugins/f5xc-platform/api-catalog.json` | Replace | Full compiled catalog (~3,676 ops) |
| `packages/coding-agent/test/api-catalog.test.ts` | Modify | Add 5 search scoring tests |
| `packages/coding-agent/test/api-executor.test.ts` | Modify | Add 6 response validation tests |

---

## Task 1: merge_spec_files() and --input-dir flag

**Repo:** api-specs-enriched
**Files:**
- Modify: `scripts/compile_catalog.py`
- Modify: `tests/test_compile_catalog.py`

- [ ] **Step 1.1: Write 5 failing tests**

Append to `tests/test_compile_catalog.py`:

```python
import os
from scripts.compile_catalog import merge_spec_files


def test_merge_spec_files_combines_paths_from_multiple_files():
    """merge_spec_files merges paths from all JSON files in a directory."""
    with tempfile.TemporaryDirectory() as tmpdir:
        spec1 = {"openapi": "3.0.3", "paths": {"/api/widgets": {"get": {"responses": {}}}}}
        spec2 = {"openapi": "3.0.3", "paths": {"/api/gadgets": {"post": {"responses": {}}}}}
        Path(tmpdir, "widgets.json").write_text(json.dumps(spec1))
        Path(tmpdir, "gadgets.json").write_text(json.dumps(spec2))

        merged = merge_spec_files(Path(tmpdir))
        assert "/api/widgets" in merged["paths"]
        assert "/api/gadgets" in merged["paths"]
        assert len(merged["paths"]) == 2


def test_merge_spec_files_skips_non_spec_files():
    """merge_spec_files skips JSON files without a 'paths' key."""
    with tempfile.TemporaryDirectory() as tmpdir:
        spec = {"openapi": "3.0.3", "paths": {"/api/items": {"get": {"responses": {}}}}}
        non_spec = {"metadata": {"version": "1.0"}}
        Path(tmpdir, "items.json").write_text(json.dumps(spec))
        Path(tmpdir, "index.json").write_text(json.dumps(non_spec))
        Path(tmpdir, "config.json").write_text(json.dumps(non_spec))

        merged = merge_spec_files(Path(tmpdir))
        assert "/api/items" in merged["paths"]
        assert len(merged["paths"]) == 1


def test_merge_spec_files_handles_duplicate_paths():
    """When same path appears in multiple files, methods are merged."""
    with tempfile.TemporaryDirectory() as tmpdir:
        spec1 = {"openapi": "3.0.3", "paths": {"/api/items": {"get": {"operationId": "list"}}}}
        spec2 = {"openapi": "3.0.3", "paths": {"/api/items": {"post": {"operationId": "create"}}}}
        Path(tmpdir, "spec1.json").write_text(json.dumps(spec1))
        Path(tmpdir, "spec2.json").write_text(json.dumps(spec2))

        merged = merge_spec_files(Path(tmpdir))
        assert "get" in merged["paths"]["/api/items"]
        assert "post" in merged["paths"]["/api/items"]


def test_compile_catalog_from_enriched_specs():
    """compile_catalog processes merged enriched specs and produces a valid catalog."""
    enriched_dir = Path("docs/specifications/api")
    if not enriched_dir.exists():
        pytest.skip("Enriched specs not available")
    merged = merge_spec_files(enriched_dir)
    catalog = compile_catalog(merged)
    assert catalog["service"] == "f5xc"
    total_ops = sum(len(c["operations"]) for c in catalog["categories"])
    assert total_ops > 100, f"Expected >100 operations, got {total_ops}"
    assert len(catalog["categories"]) > 10, f"Expected >10 categories, got {len(catalog['categories'])}"


def test_main_cli_with_input_dir_flag():
    """main() with --input-dir reads all specs and writes catalog."""
    with tempfile.TemporaryDirectory() as tmpdir:
        specs_dir = Path(tmpdir) / "specs"
        specs_dir.mkdir()
        output_path = Path(tmpdir) / "catalog.json"

        spec = {"openapi": "3.0.3", "paths": {
            "/api/config/namespaces/{namespace}/widgets": {"get": {"responses": {}}},
            "/api/config/namespaces/{namespace}/gadgets": {"delete": {"responses": {}}},
        }}
        (specs_dir / "test.json").write_text(json.dumps(spec))

        original_argv = sys.argv
        sys.argv = ["compile_catalog", "--input-dir", str(specs_dir), "--output", str(output_path)]
        try:
            exit_code = main()
        finally:
            sys.argv = original_argv

        assert exit_code == 0
        assert output_path.exists()
        catalog = json.loads(output_path.read_text())
        assert catalog["service"] == "f5xc"
        total_ops = sum(len(c["operations"]) for c in catalog["categories"])
        assert total_ops >= 2
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
cd /workspace/api-specs-enriched
python -m pytest tests/test_compile_catalog.py::test_merge_spec_files_combines_paths_from_multiple_files -v 2>&1 | tail -5
```

Expected: `ImportError` — `merge_spec_files` not found.

- [ ] **Step 1.3: Add merge_spec_files() to compile_catalog.py**

Add this function after the `F5XC_DEFAULTS` constant and before `assign_danger_level`:

```python
def merge_spec_files(dir_path: Path) -> dict[str, Any]:
    """Read all OpenAPI JSON files in a directory and merge their paths.

    Skips files without a 'paths' key (non-spec files like index.json).
    When the same path appears in multiple files, their methods are merged.
    """
    merged_paths: dict[str, Any] = {}

    for spec_file in sorted(dir_path.glob("*.json")):
        try:
            with spec_file.open() as f:
                spec = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        paths = spec.get("paths")
        if not paths or not isinstance(paths, dict):
            continue

        for path, path_item in paths.items():
            if not isinstance(path_item, dict):
                continue
            if path not in merged_paths:
                merged_paths[path] = {}
            merged_paths[path].update(path_item)

    return {"openapi": "3.0.3", "paths": merged_paths}
```

- [ ] **Step 1.4: Update main() to accept --input-dir**

Replace the `main()` function with:

```python
def main() -> int:
    parser = argparse.ArgumentParser(description="Compile F5XC OpenAPI spec to xcsh catalog JSON")
    parser.add_argument("--input", type=Path, default=None, help="Single OpenAPI spec input file")
    parser.add_argument("--input-dir", type=Path, default=None, help="Directory of OpenAPI spec files to merge")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output api-catalog.json path")
    args = parser.parse_args()

    if args.input_dir:
        if not args.input_dir.is_dir():
            print(f"Error: input directory not found: {args.input_dir}", file=sys.stderr)
            return 1
        openapi = merge_spec_files(args.input_dir)
    elif args.input:
        if not args.input.exists():
            print(f"Error: input file not found: {args.input}", file=sys.stderr)
            return 1
        with args.input.open() as f:
            openapi = json.load(f)
    else:
        if not DEFAULT_INPUT.exists():
            print(f"Error: default input not found: {DEFAULT_INPUT}", file=sys.stderr)
            return 1
        with DEFAULT_INPUT.open() as f:
            openapi = json.load(f)

    catalog = compile_catalog(openapi)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w") as f:
        json.dump(catalog, f, indent=2)
        f.write("\n")

    total_ops = sum(len(c["operations"]) for c in catalog["categories"])
    print(f"Compiled {total_ops} operations across {len(catalog['categories'])} categories -> {args.output}")
    return 0
```

- [ ] **Step 1.5: Run all compile tests**

```bash
cd /workspace/api-specs-enriched
python -m pytest tests/test_compile_catalog.py -v 2>&1 | tail -25
```

Expected: all 29 tests pass (24 existing + 5 new).

- [ ] **Step 1.6: Commit**

```bash
cd /workspace/api-specs-enriched
git add scripts/compile_catalog.py tests/test_compile_catalog.py
git commit -m "feat(compile): add --input-dir flag and merge_spec_files()

Reads all OpenAPI JSON files in a directory, merges their paths,
and compiles a unified catalog. Handles duplicate paths by merging
methods. Backward-compatible with existing --input single-file mode."
```

---

## Task 2: Compile Full Catalog and Deploy to xcsh

**Repo:** api-specs-enriched → xcsh
**Files:**
- Output: `release/api-catalog.json`
- Replace: `/workspace/xcsh/.worktrees/feature/function-calls/marketplace/plugins/f5xc-platform/api-catalog.json`

- [ ] **Step 2.1: Compile the full catalog from enriched specs**

```bash
cd /workspace/api-specs-enriched
python -m scripts.compile_catalog --input-dir docs/specifications/api --output release/api-catalog.json
```

Verify output:
```bash
node -e "
const c = require('./release/api-catalog.json');
const ops = c.categories.reduce((n,cat) => n + cat.operations.length, 0);
console.log('Service:', c.service);
console.log('Categories:', c.categories.length);
console.log('Total ops:', ops);
console.log('Auth:', c.auth.type, c.auth.headerTemplate);
"
```

Expected: >100 categories, >1000 operations.

- [ ] **Step 2.2: Copy to xcsh marketplace plugin**

```bash
cp /workspace/api-specs-enriched/release/api-catalog.json /workspace/xcsh/.worktrees/feature/function-calls/marketplace/plugins/f5xc-platform/api-catalog.json
```

- [ ] **Step 2.3: Verify xcsh can load the new catalog**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
node -e "
const c = require('./marketplace/plugins/f5xc-platform/api-catalog.json');
const ops = c.categories.reduce((n,cat) => n + cat.operations.length, 0);
console.log('Service:', c.service);
console.log('Categories:', c.categories.length);
console.log('Total ops:', ops);
"
```

- [ ] **Step 2.4: Run existing tests to verify no regressions**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test --max-concurrency=1 packages/coding-agent/test/api-catalog.test.ts packages/coding-agent/test/api-executor.test.ts packages/coding-agent/test/api-tool.test.ts 2>&1 | tail -10
```

Expected: all 68 tests still pass.

- [ ] **Step 2.5: Commit in xcsh**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
git add marketplace/plugins/f5xc-platform/api-catalog.json
git commit -m "feat(f5xc): replace hand-crafted catalog with full compiled catalog

Compiled from 40 enriched spec files in api-specs-enriched.
Previous: 17 operations across 6 categories.
New: compiled from enriched vendor specifications."
```

---

## Task 3: Scored Fuzzy Search

**Repo:** xcsh
**Files:**
- Modify: `packages/coding-agent/src/services/api-catalog.ts`
- Modify: `packages/coding-agent/test/api-catalog.test.ts`

- [ ] **Step 3.1: Write 5 failing search tests**

Append to `packages/coding-agent/test/api-catalog.test.ts`:

```typescript
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
						{ name: "list_http_loadbalancers", description: "List all HTTP load balancers", method: "GET", path: "/lbs", dangerLevel: "low", parameters: [] },
						{ name: "get_http_loadbalancer", description: "Get a specific HTTP load balancer", method: "GET", path: "/lbs/{name}", dangerLevel: "low", parameters: [] },
						{ name: "delete_http_loadbalancer", description: "Remove an HTTP load balancer", method: "DELETE", path: "/lbs/{name}", dangerLevel: "high", parameters: [] },
					],
				},
				{
					name: "origin-pools",
					displayName: "Origin Pools",
					operations: [
						{ name: "list_origin_pools", description: "List all origin pools", method: "GET", path: "/pools", dangerLevel: "low", parameters: [] },
					],
				},
				...Array.from({ length: 30 }, (_, i) => ({
					name: `filler-${i}`,
					displayName: `Filler ${i}`,
					operations: [
						{ name: `filler_op_${i}`, description: `Filler operation ${i} for loadbalancer testing`, method: "GET", path: `/filler/${i}`, dangerLevel: "low", parameters: [] },
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
		const descOnlyIdx = results.findIndex(r => r.name.startsWith("filler_op_") && r.description.includes("loadbalancer"));
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
```

- [ ] **Step 3.2: Run tests to see current behavior**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test --max-concurrency=1 packages/coding-agent/test/api-catalog.test.ts 2>&1 | tail -15
```

Some tests may pass with the current substring search, others may fail (especially the ranking tests and the 25-cap test).

- [ ] **Step 3.3: Replace search() with scored fuzzy search**

In `packages/coding-agent/src/services/api-catalog.ts`, replace the `search()` method:

```typescript
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
```

Also remove the `keywordIndex` from the `CatalogIndex` interface and `#buildIndex` since it's no longer used:

In the `CatalogIndex` interface, remove `keywordIndex: Map<string, Set<string>>;`

In `#buildIndex`, remove:
```typescript
const keywordIndex = new Map<string, Set<string>>();

const addKeyword = (keyword: string, opName: string) => {
	if (!keywordIndex.has(keyword)) keywordIndex.set(keyword, new Set());
	keywordIndex.get(keyword)!.add(opName);
};
```

And in the loop, remove:
```typescript
for (const token of op.name.split("_")) addKeyword(token, op.name);
for (const word of op.description.toLowerCase().split(/\s+/)) {
	if (word.length > 2) addKeyword(word, op.name);
}
addKeyword(category.name, op.name);
```

Update the `this.#indexes.set(...)` call to only include `{ operationsByName, categoriesByName }`.

- [ ] **Step 3.4: Run all catalog tests**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test --max-concurrency=1 packages/coding-agent/test/api-catalog.test.ts 2>&1 | tail -15
```

Expected: all tests pass (existing + 5 new). Note: the existing "search uses keyword index" test may need updating — its assertion checked that results included all operations matching "widget". The new scored search still returns those matches, just ranked.

- [ ] **Step 3.5: Commit**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
git add packages/coding-agent/src/services/api-catalog.ts packages/coding-agent/test/api-catalog.test.ts
git commit -m "perf(coding-agent): replace keyword-index search with scored fuzzy search

Relevance scoring: exact name (100) > name token (80) > category (60)
> description (40) > substring (20). Results capped at 25, sorted by
score then alphabetically. Removes keyword index — no longer needed."
```

---

## Task 4: Add responseSchema Type to ApiOperation

**Repo:** xcsh
**Files:**
- Modify: `packages/coding-agent/src/services/api-types.ts`

- [ ] **Step 4.1: Add responseSchema to ApiOperation interface**

In `packages/coding-agent/src/services/api-types.ts`, add after the `bestPractices` field in the `ApiOperation` interface:

```typescript
responseSchema?: {
	type: string;
	properties?: Record<string, { type: string }>;
	required?: string[];
};
```

- [ ] **Step 4.2: Run type check to verify no breakage**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun run check:ts 2>&1 | tail -5
```

Expected: clean exit.

- [ ] **Step 4.3: Commit**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
git add packages/coding-agent/src/services/api-types.ts
git commit -m "feat(coding-agent): add responseSchema to ApiOperation type

Optional structural schema for response validation.
Backward-compatible — all existing code works without it."
```

---

## Task 5: validateResponse() and Advisory Warnings

**Repo:** xcsh
**Files:**
- Modify: `packages/coding-agent/src/services/api-executor.ts`
- Modify: `packages/coding-agent/test/api-executor.test.ts`

- [ ] **Step 5.1: Write 6 failing validation tests**

Append to `packages/coding-agent/test/api-executor.test.ts`:

```typescript
describe("validateResponse", () => {
	test("returns empty array for valid data matching schema", async () => {
		const { validateResponse } = await import("../src/services/api-executor");
		const schema = { type: "object", properties: { items: { type: "array" } }, required: ["items"] };
		const warnings = validateResponse({ items: [1, 2] }, schema);
		expect(warnings).toHaveLength(0);
	});

	test("warns on wrong top-level type", async () => {
		const { validateResponse } = await import("../src/services/api-executor");
		const schema = { type: "array" };
		const warnings = validateResponse({ not: "array" }, schema);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain("array");
	});

	test("warns on missing required key", async () => {
		const { validateResponse } = await import("../src/services/api-executor");
		const schema = { type: "object", required: ["items", "metadata"] };
		const warnings = validateResponse({ items: [] }, schema);
		expect(warnings.some(w => w.includes("metadata"))).toBe(true);
	});

	test("warns on wrong property type", async () => {
		const { validateResponse } = await import("../src/services/api-executor");
		const schema = { type: "object", properties: { count: { type: "number" } } };
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
```

- [ ] **Step 5.2: Run tests to verify they fail**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test --max-concurrency=1 packages/coding-agent/test/api-executor.test.ts 2>&1 | tail -15
```

Expected: new tests fail — `validateResponse` not exported, `warnings` property doesn't exist.

- [ ] **Step 5.3: Add validateResponse() function to api-executor.ts**

Add this exported function at the top of `api-executor.ts`, after the imports and constants:

```typescript
export function validateResponse(
	data: unknown,
	schema: { type: string; properties?: Record<string, { type: string }>; required?: string[] },
): string[] {
	const warnings: string[] = [];

	const actualType = Array.isArray(data) ? "array" : typeof data;
	if (schema.type && actualType !== schema.type) {
		warnings.push(`Expected top-level type '${schema.type}', got '${actualType}'`);
		return warnings;
	}

	if (schema.required && typeof data === "object" && data !== null) {
		for (const key of schema.required) {
			if (!(key in (data as Record<string, unknown>))) {
				warnings.push(`Missing required key '${key}'`);
			}
		}
	}

	if (schema.properties && typeof data === "object" && data !== null) {
		const obj = data as Record<string, unknown>;
		for (const [key, prop] of Object.entries(schema.properties)) {
			if (key in obj) {
				const valType = Array.isArray(obj[key]) ? "array" : typeof obj[key];
				if (valType !== prop.type) {
					warnings.push(`Property '${key}' expected type '${prop.type}', got '${valType}'`);
				}
			}
		}
	}

	return warnings;
}
```

- [ ] **Step 5.4: Update execute() return type and add validation call**

Change the return type of `execute()` from:
```typescript
Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }>
```
To:
```typescript
Promise<{ ok: true; data: unknown; warnings?: string[] } | { ok: false; status: number; error: string }>
```

At the final success return (around line 153, `return { ok: true, data };`), replace with:

```typescript
if (op.method === "GET") {
	this.#setCache(url, data);
}

if (op.responseSchema) {
	const warnings = validateResponse(data, op.responseSchema);
	return { ok: true, data, ...(warnings.length > 0 ? { warnings } : {}) };
}

return { ok: true, data };
```

Also update the cache-hit return (around line 104) to skip validation for cached responses:
```typescript
return { ok: true, data: cached };
```
(This stays unchanged — cached data was already validated on first fetch.)

- [ ] **Step 5.5: Run all executor tests**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test --max-concurrency=1 packages/coding-agent/test/api-executor.test.ts 2>&1 | tail -15
```

Expected: all tests pass (21 existing + 6 new = 27).

- [ ] **Step 5.6: Run full test suite**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test --max-concurrency=1 packages/coding-agent/test/api-catalog.test.ts packages/coding-agent/test/api-executor.test.ts packages/coding-agent/test/api-tool.test.ts marketplace/plugins/f5xc-platform/scripts/sync-catalog.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5.7: Commit**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
git add packages/coding-agent/src/services/api-executor.ts packages/coding-agent/test/api-executor.test.ts
git commit -m "feat(coding-agent): add advisory response schema validation

validateResponse() checks top-level type, required keys, and property
types. Returns warnings without blocking the response. execute()
attaches warnings when op.responseSchema is defined."
```

---

## Task 6: End-to-End Phase 3 Verification

- [ ] **Step 6.1: Run Python tests**

```bash
cd /workspace/api-specs-enriched
python -m pytest tests/test_compile_catalog.py -v 2>&1 | tail -20
```

Expected: all 29 tests pass.

- [ ] **Step 6.2: Run TypeScript tests**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test --max-concurrency=1 packages/coding-agent/test/api-catalog.test.ts packages/coding-agent/test/api-executor.test.ts packages/coding-agent/test/api-tool.test.ts marketplace/plugins/f5xc-platform/scripts/sync-catalog.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6.3: Type check**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun run check:ts 2>&1 | tail -5
```

Expected: `Exited with code 0`

- [ ] **Step 6.4: Verify compiled catalog loads in xcsh**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
node -e "
const c = require('./marketplace/plugins/f5xc-platform/api-catalog.json');
const ops = c.categories.reduce((n,cat) => n + cat.operations.length, 0);
console.log('Service:', c.service);
console.log('Categories:', c.categories.length);
console.log('Total ops:', ops);
console.log('Sample categories:', c.categories.slice(0, 5).map(cat => cat.name).join(', '));
"
```

- [ ] **Step 6.5: Tag Phase 3 completion**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
git tag feature/function-calls-phase3
```
