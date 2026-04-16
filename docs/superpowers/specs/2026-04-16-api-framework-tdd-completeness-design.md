# API Framework TDD Completeness — Design Spec

## Overview

Post-Phase-2 gap audit identified 18 missing tests across both repos. All feature implementations are working correctly (the suspected `specs_dir` bug was a false alarm — the pipeline processes 1,891 spec endpoints expanding to 3,676 CRUD targets). This spec covers the tests-only sprint to achieve full TDD completeness before merging `feature/function-calls`.

**Approach:** Tests-only. No code changes unless a test reveals an actual bug. Fix bugs inline if discovered.

## Scope: 18 New Tests

### Repo: api-specs-enriched

**File: `tests/test_discover_crud.py`** — 3 new tests

| Test | What it verifies |
|------|-----------------|
| `test_run_discovery_expands_crud_endpoints` | `run_discovery()` with a synthetic spec dir produces CRUD variants (POST, PUT, DELETE variants from GET endpoints). Uses `dry_run=True` to avoid live API calls. |
| `test_run_discovery_auto_discovers_namespaces` | `run_discovery()` calls `fetch_namespaces()` inside the AsyncClient block and updates `session.namespaces` when auto-discovery succeeds. Mock the client. |
| `test_run_discovery_dry_run_with_crud_expansion` | `dry_run=True` with CRUD expansion enabled prints the expanded count (not just the spec-extracted count). |

**File: `tests/test_compile_catalog.py`** — 3 new tests

| Test | What it verifies |
|------|-----------------|
| `test_main_cli_writes_output_file` | Call `main()` with `--input specs/discovered/openapi.json --output /tmp/test-out.json`. Verify output file exists, is valid JSON, contains `service: "f5xc"`, and has at least one category. |
| `test_compile_catalog_against_real_spec` | Load `specs/discovered/openapi.json`, run `compile_catalog()`, verify it returns categories list and all operations have required fields (`name`, `method`, `path`, `dangerLevel`, `parameters`). |
| `test_compile_catalog_handles_extension_fields` | OpenAPI spec with `x-response-time-ms`, `x-ves-proto-service`, and no `parameters` field on an operation. Verify compiler does not raise and produces valid output. |

---

### Repo: xcsh (`packages/coding-agent`)

**File: `test/api-catalog.test.ts`** — 2 new tests

| Test | What it verifies |
|------|-----------------|
| `test same service defined in two catalogs — last-scanned wins` | Two temp dirs each containing `api-catalog.json` with `service: "svc"` but different `displayName`. Pass both to `ApiCatalogService`. The returned `displayName` is from the second dir (last wins). Documents the collision behavior. |
| `test getServices skips disk re-scan on second call` | Call `getServices()`, write a new `api-catalog.json` to the search dir, call `getServices()` again. The second call must NOT return the newly written catalog (proves `#scanned` flag works). |

**File: `test/api-executor.test.ts`** — 3 new tests

| Test | What it verifies |
|------|-----------------|
| `test cache entry expires after TTL` | Manually set `expiresAt` to `Date.now() - 1` on a cache entry via a test accessor, or use `Date` mock. Verify next GET re-fetches instead of returning cached data. Implementation note: easiest approach is to `clearCache()` + re-execute to prime, then manipulate time via `Date.now` override. |
| `test LRU eviction when cache exceeds 100 entries` | Make 101 unique GET requests (101 distinct URLs). Verify the cache contains exactly 100 entries. Then re-request the first URL — it must re-fetch (was evicted), call count increments. |
| `test POST to collection invalidates cached GET for same path` | GET `/api/resources` (cache it). POST `/api/resources` (should invalidate). GET `/api/resources` again. Verify fetch was called 3 times (no cache hit on third call). |

**File: `test/api-tool.test.ts`** — 3 new tests (in existing "ApiBatchTool" describe block or new sub-describe)

| Test | What it verifies |
|------|-----------------|
| `test strict mode stops on first API failure` | Batch two ops, first returns HTTP 500. Verify second op's URL was never fetched (fetch call count = 1). |
| `test batch returns error for missing required parameter` | Batch an op that has a required path param, pass no params. Verify result contains `ok: false` and the error message names the missing parameter. |
| `test batch applies 200ms inter-operation delay` | Batch two ops that both succeed. Measure elapsed time. Verify total elapsed ≥ 200ms. |

**File: `marketplace/plugins/f5xc-platform/scripts/sync-catalog.test.ts`** — 4 new tests (new file)

| Test | What it verifies |
|------|-----------------|
| `validateCatalog accepts a valid catalog` | Pass a well-formed catalog object. Verify no exception thrown and no error output. |
| `validateCatalog rejects wrong service name` | Pass `{ service: "wrong", ... }`. Verify it throws with a message containing `"f5xc"`. |
| `validateCatalog rejects zero operations` | Pass `{ service: "f5xc", auth: {}, categories: [] }`. Verify it throws mentioning "0 operations". |
| `validateCatalog rejects missing auth field` | Pass `{ service: "f5xc", categories: [...] }` (no `auth`). Verify it throws mentioning `"auth"`. |

The `validateCatalog` function is exported from `sync-catalog.ts` — if it is not already exported, the only change needed is adding `export` to the function declaration.

---

## Test Infrastructure Notes

### api-specs-enriched: run_discovery() integration tests

`run_discovery()` is an `async` function that calls `httpx.AsyncClient`. Tests must:
- Create a temporary directory with a minimal OpenAPI JSON (1–2 paths)
- Mock `httpx.AsyncClient` to return synthetic responses
- Use `pytest.mark.asyncio` (already available in the test env)
- Pass `dry_run=True` where live HTTP calls would be needed

### xcsh: LRU eviction test

`CACHE_MAX_SIZE = 100` is a module-level constant. To test eviction without making 101 real HTTP calls, mock `globalThis.fetch` to return a unique response per URL and track which URLs were called.

### xcsh: TTL expiry test

`CACHE_TTL_MS = 60_000` is too long to sleep. Use `Date.now` override: `globalThis.Date = { now: () => <timestamp> }` or override the executor's internal TTL by calling `#setCache` with a fabricated expired entry via a test helper. Simplest approach: override `Date.now` to return a timestamp 61 seconds in the future after the first GET.

### xcsh: sync-catalog.ts exportability

`validateCatalog` is currently defined inside `sync-catalog.ts` but not exported. The only code change permitted under the tests-only approach is adding `export` to this function.

---

## Verification

After all tests pass:

```bash
# api-specs-enriched
cd /workspace/api-specs-enriched
python -m pytest tests/test_discover_crud.py tests/test_compile_catalog.py -v

# xcsh
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test packages/coding-agent/test/api-catalog.test.ts \
         packages/coding-agent/test/api-executor.test.ts \
         packages/coding-agent/test/api-tool.test.ts \
         marketplace/plugins/f5xc-platform/scripts/sync-catalog.test.ts

# Type check
bun run check:ts
```

Expected totals:
- Python: 30 + 6 = **36 tests** passing
- TypeScript: 60 + 2 + 3 + 3 + 4 = **72 tests** passing
