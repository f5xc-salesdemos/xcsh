# API Function Calls Phase 3 — Design Spec

## Overview

Phase 3 extends the API framework from a 51-operation catalog to a full-scale 3,676-operation catalog compiled from enriched vendor specs, adds scored fuzzy search for efficient operation discovery at scale, and introduces advisory response schema validation. All work is TDD — tests first, then implementation.

## Scope

Three pillars:
1. **Full catalog generation** from enriched specs (api-specs-enriched repo)
2. **Scored fuzzy search** for 3,676+ operations (xcsh repo)
3. **Advisory response schema validation** (xcsh repo)

**Out of scope:** Multi-tenant support (handled by existing `/profile` command), automatic catalog updates (sync-catalog.ts is sufficient), live API discovery re-run (operational task, not code).

---

## Stage 1: Full Catalog Compilation

**Repo:** api-specs-enriched

### Problem

`compile_catalog.py` takes a single OpenAPI JSON file as `--input`. But the enriched specs live in `docs/specifications/api/` as 39 separate categorized JSON files (e.g., `dns.json`, `cdn.json`, `network.json`). Each file has its own `paths` section following OpenAPI 3.0 structure with F5XC-specific extensions.

### Solution

Add `--input-dir` flag to `compile_catalog.py`:

```
python -m scripts.compile_catalog --input-dir docs/specifications/api --output release/api-catalog.json
```

**Behavior:**
- When `--input-dir` is provided, read all `*.json` files in the directory (skip `index.json`)
- Merge all `paths` from all files into one combined paths dict
- Handle duplicate paths: if the same path appears in multiple files, merge their methods
- Pass the merged paths dict to the existing `compile_catalog()` function
- The existing `--input` single-file mode continues to work unchanged

**New function:** `merge_spec_files(dir: Path) -> dict[str, Any]`
- Reads all JSON files in the directory
- Returns a unified `{"openapi": "3.0.3", "paths": {...merged...}}` dict
- Skips files that don't have a `paths` key (non-spec files like `index.json`)

**POST-as-list edge case:** F5XC uses POST for some list/query operations (e.g., `POST /api/.../introspect`). The existing `generate_operation_name` maps POST → `create_*`. These POST-list operations typically have paths that don't end in a collection name (e.g., they end in a verb like `/introspect` or `/report`). For Phase 3, we accept this — the naming is functional if not perfectly semantic. A future enrichment step can add operation name overrides.

**Output:** Generate the full catalog and place it at:
- `release/api-catalog.json` (CI artifact)
- Copy to xcsh's `marketplace/plugins/f5xc-platform/api-catalog.json` (replaces the hand-crafted 17-op version)

**Testing:**
- `test_merge_spec_files_combines_paths_from_multiple_files`
- `test_merge_spec_files_skips_non_spec_files`
- `test_merge_spec_files_handles_duplicate_paths`
- `test_compile_catalog_from_enriched_specs` (integration test against real enriched specs)
- `test_main_cli_with_input_dir_flag`

---

## Stage 2: Scored Fuzzy Search

**Repo:** xcsh
**File:** `packages/coding-agent/src/services/api-catalog.ts`

### Problem

The current `search()` method does substring matching against a keyword index. With 3,676 operations, results are unranked and can return hundreds of matches for common terms like "list" or "namespace".

### Solution

Replace keyword-index search with a scored relevance search:

**Scoring rules:**
| Match type | Score |
|-----------|-------|
| Exact operation name match | 100 |
| Operation name token match (underscore-split) | 80 |
| Category name match | 60 |
| Description word match | 40 |
| Substring match in name or description | 20 |

**Algorithm:**
1. If `operationsByName.has(query)` → return that single operation (score 100, O(1))
2. Tokenize query into words (split on spaces, underscores, hyphens)
3. For each operation: compute best match score across all query tokens
4. Filter operations with score > 0
5. Sort by score descending, then by operation name alphabetically (stable tie-break)
6. Return top 25 results

**Return type change:** `search()` currently returns `ApiOperation[]`. Keep this — the scoring is internal. Callers don't need to see scores.

**Performance:** With 3,676 operations × ~3 query tokens, this is ~11,000 comparisons — well within budget for synchronous execution. No need for a search index.

**Testing:**
- `test_search_exact_name_match_ranks_first`
- `test_search_name_token_ranks_above_description_match`
- `test_search_results_capped_at_25`
- `test_search_category_name_match`
- `test_search_empty_query_returns_empty`

---

## Stage 3: Advisory Response Schema Validation

**Repo:** xcsh
**Files:** `api-types.ts`, `api-executor.ts`

### Problem

API responses are consumed as-is. When the F5XC API changes its response shape (adds/removes fields), tools silently return unexpected data. There's no way to detect schema drift.

### Solution

Add structural validation that produces warnings without blocking the response.

**Type changes in `api-types.ts`:**
```typescript
// Add to ApiOperation interface
responseSchema?: {
  type: string;
  properties?: Record<string, { type: string }>;
  required?: string[];
};
```

**New function in `api-executor.ts`:**
```typescript
function validateResponse(data: unknown, schema: ApiOperation["responseSchema"]): string[] {
  // Returns list of warning strings (empty if valid)
}
```

**Validation rules:**
1. If `schema.type === "object"` and data is not an object → warning
2. If `schema.type === "array"` and data is not an array → warning
3. For each `schema.required` key: if missing from data → warning
4. For each `schema.properties` entry: if key exists in data but has wrong type → warning

**Return type change in `execute()`:**
```typescript
// Success case becomes:
{ ok: true; data: unknown; warnings?: string[] }
```

When `op.responseSchema` is defined and the response is successful, call `validateResponse()`. If warnings are returned, attach them. If `responseSchema` is not defined, skip validation entirely (backward-compatible).

**Catalog integration:** The compiler can optionally generate `responseSchema` from OpenAPI response schemas when they exist. For Phase 3, this is limited to the fields already present in the discovered spec (many operations have minimal schemas — just `{type: "object", properties: {items: {type: "array"}}}`).

**Testing:**
- `test_validateResponse_returns_empty_for_valid_data`
- `test_validateResponse_warns_on_wrong_top_level_type`
- `test_validateResponse_warns_on_missing_required_key`
- `test_validateResponse_warns_on_wrong_property_type`
- `test_execute_attaches_warnings_when_schema_defined`
- `test_execute_skips_validation_when_no_schema`

---

## Ordering and Dependencies

| Stage | Repo | Depends On | Deliverable |
|-------|------|------------|-------------|
| 1. Full Catalog | api-specs-enriched | None | 3,676-op api-catalog.json |
| 2. Fuzzy Search | xcsh | Stage 1 catalog (for scale testing) | Scored search in ApiCatalogService |
| 3. Response Validation | xcsh | None (parallel-safe with Stage 2) | Advisory warnings in ApiExecutor |

Stages 2 and 3 can run in parallel after Stage 1 completes.

## What's NOT in Phase 3

- **Full JSON Schema validation** (AJV): Structural checks are sufficient for schema drift detection. Full schema validation adds a dependency for marginal value.
- **Live API discovery re-run**: Operational task that requires F5XC credentials. Not a code change.
- **Automatic catalog updates**: `sync-catalog.ts` handles manual/CI-triggered sync. Runtime auto-update is YAGNI.
- **Operation name overrides for POST-as-list**: Accept `create_*` naming for POST operations that are semantically list/query operations. A future enrichment step can add overrides.

## Verification

```bash
# Python: compile full catalog
cd /workspace/api-specs-enriched
python -m scripts.compile_catalog --input-dir docs/specifications/api --output release/api-catalog.json

# Python tests
python -m pytest tests/test_compile_catalog.py -v

# TypeScript tests (sequential)
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test --max-concurrency=1 packages/coding-agent/test/api-catalog.test.ts \
  packages/coding-agent/test/api-executor.test.ts \
  packages/coding-agent/test/api-tool.test.ts

# Type check
bun run check:ts
```
