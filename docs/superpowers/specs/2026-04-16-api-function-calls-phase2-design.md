# API Function Calls Phase 2 — Design Spec

## Overview

Phase 2 extends the Phase 1 API function calls framework from a hand-crafted 17-operation F5XC catalog to a full auto-generated catalog with runtime improvements for scale. Work spans two repositories: `api-specs-enriched` (discovery + compiler) and `xcsh` (runtime upgrades + integration).

## Architecture

```
api-specs-enriched repo                    xcsh repo
┌─────────────────────────┐    ┌──────────────────────────────────┐
│ Stage 1: Discovery      │    │ Stage 3: Runtime Upgrades        │
│ Full CRUD endpoint      │    │ - Indexed operation lookups      │
│ discovery against live   │    │ - Response caching with TTL      │
│ F5XC API                │    │ - Batch operation orchestration   │
│           │              │    │ - Fix plugin discovery paths     │
│           ▼              │    │           │                      │
│ Stage 2: Compiler        │    │           ▼                      │
│ OpenAPI → api-catalog.json│──▶│ Stage 4: Integration             │
│ Published as GH release  │    │ sync-catalog.ts downloads        │
│ artifact                 │    │ catalog from GH release          │
└─────────────────────────┘    └──────────────────────────────────┘
```

**Data flow**: F5XC API → discover.py → openapi.json → compile_catalog.py → api-catalog.json (GH release) → sync-catalog.ts → xcsh runtime

## Stage 1: Full CRUD Discovery

**Repo**: api-specs-enriched
**Goal**: Extend discovery from 80 GET-only endpoints to full CRUD coverage across all F5XC resource types.

### Current State

- `scripts/discover.py` probes the F5XC API and produces `specs/discovered/openapi.json`
- Last run: 300/1000 endpoints, 80 in final spec, all GET
- Method filter is config-driven (line 71, 147): `["GET", "OPTIONS"]`
- Rate limiter and retry logic already exist

### Changes Required

1. **Update discovery config methods**: `["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]`
2. **CRUD endpoint pattern inference**: For each discovered list endpoint (`GET .../resources`), automatically probe:
   - `POST .../resources` (create)
   - `GET .../resources/{name}` (get by name)
   - `PUT .../resources/{name}` (full replace)
   - `DELETE .../resources/{name}` (delete)
3. **Safe write discovery**: Use `OPTIONS` preflight or `--dry-run` mode to detect write endpoint existence without creating/deleting resources. For POST/PUT, send minimal payloads or use `Content-Length: 0` to detect 405 (not allowed) vs 400 (bad request, meaning endpoint exists).
4. **Broader namespace coverage**: Configure discovery to use the tenant's actual namespaces from `GET /api/web/namespaces`, not just hardcoded `system`/`shared`.

### Deliverable

Updated `specs/discovered/openapi.json` with full CRUD operations. Estimated 300-500 operations across all F5XC resource types and namespaces.

## Stage 2: Catalog Compiler

**Repo**: api-specs-enriched
**Goal**: Deterministic transformation of OpenAPI spec into xcsh api-catalog.json format.

### Script: `scripts/compile_catalog.py`

**Input**: `specs/discovered/openapi.json` (OpenAPI 3.0.3)
**Output**: `release/api-catalog.json` (xcsh catalog schema)

### Compiler Logic

1. **Parse OpenAPI paths** and group by resource type:
   - `/api/config/namespaces/{namespace}/http_loadbalancers` → category `load-balancers`
   - `/api/config/namespaces/{namespace}/origin_pools` → category `origin-pools`
   - `/api/web/namespaces` → category `namespaces`

2. **Category naming**: Strip the path prefix, pluralize/kebab-case the resource name. Group all HTTP methods for the same resource path into one category.

3. **Operation naming**: Map HTTP method + path to operation name:
   - `GET /resources` → `list_{resources}`
   - `GET /resources/{name}` → `get_{resource}`
   - `POST /resources` → `create_{resource}`
   - `PUT /resources/{name}` → `replace_{resource}`
   - `PATCH /resources/{name}` → `update_{resource}`
   - `DELETE /resources/{name}` → `delete_{resource}`

4. **Parameter extraction**:
   - Path parameters from `{param}` placeholders → `"in": "path", "required": true`
   - Query parameters from OpenAPI spec → `"in": "query"`
   - Body schema from OpenAPI `requestBody` → `"bodySchema"` field
   - Namespace params get default `"$F5XC_NAMESPACE"`

5. **Danger level assignment**:
   - `GET`, `OPTIONS` → `"low"`
   - `POST` → `"medium"`
   - `PUT`, `PATCH` → `"medium"`
   - `DELETE` → `"high"`

6. **Auth config**: Static for F5XC:
   ```json
   {
     "type": "api_token",
     "headerName": "Authorization",
     "headerTemplate": "APIToken {token}",
     "tokenSource": "F5XC_API_TOKEN",
     "baseUrlSource": "F5XC_API_URL"
   }
   ```

7. **Defaults**: `{ "namespace": { "source": "F5XC_NAMESPACE" } }`

### Output Schema

Must match the Phase 1 `ApiCatalog` TypeScript interface exactly:

```typescript
interface ApiCatalog {
  service: string;
  displayName: string;
  version: string;
  specSource?: string;
  auth: ApiAuthConfig;
  defaults?: ApiDefaults;
  categories: ApiCategory[];
}
```

### CI Integration

- GitHub Actions workflow runs `compile_catalog.py` on push to main
- Output `release/api-catalog.json` is attached as a GitHub release artifact
- Versioned by date: `f5xc-catalog-YYYY-MM-DD.json`

### Testing

- Unit tests verify category grouping, operation naming, danger level assignment, parameter extraction
- Snapshot test: compile the existing 80-op spec and compare against expected output
- Schema validation: output JSON must pass the `ApiCatalog` JSON schema

## Stage 3: Runtime Upgrades

**Repo**: xcsh
**Goal**: Make the Phase 1 framework handle 300-500+ operations efficiently.

### 3a. Indexed Operation Lookups

**File**: `packages/coding-agent/src/services/api-catalog.ts`

Replace linear scan with indexed data structures:

- Build `Map<string, ApiOperation>` at catalog load time (operation name → operation)
- Build category index: `Map<string, ApiCategory>` (category name → category)
- `getOperation()` becomes O(1) lookup instead of O(n) scan
- `search()` uses pre-built keyword index: tokenize all operation names and descriptions at load time into an inverted index

**Impact**: api_describe and api_discover go from O(n) to O(1) or O(k) where k = matching results.

### 3b. Response Caching

**File**: `packages/coding-agent/src/services/api-executor.ts`

Add in-memory LRU cache:

- Cache key: `${method}:${resolvedUrl}`
- Default TTL: 60 seconds for GET responses, no caching for write operations (POST/PUT/PATCH/DELETE)
- Cache size limit: 100 entries (LRU eviction)
- `clearCache()` method for manual invalidation
- Cache bypassed when `Cache-Control: no-cache` header is present in the request
- Write operations (POST/PUT/PATCH/DELETE) automatically invalidate cached GET responses for the same resource path

### 3c. Batch Operations

**File**: `packages/coding-agent/src/tools/api-tool.ts`

New tool: `api_batch`

- Schema: `{ service: string, operations: Array<{ operation: string, params?: object, body?: object }> }`
- Executes operations sequentially in order
- Returns aggregated results: `{ results: Array<{ operation: string, ok: boolean, data?: unknown, error?: string }> }`
- Rate-limited: configurable delay between operations (default 200ms)
- Stops on first failure in "strict" mode, continues in "best-effort" mode (default)
- Confirmation gate: if any operation in the batch is high/critical danger, prompt for confirmation before executing the entire batch

### 3d. Plugin Discovery Path Fix

**File**: `packages/coding-agent/src/tools/api-tool.ts`

Fix the catalog search paths to include the marketplace plugin cache:

- Current: `~/.claude/plugins` + project plugin paths
- Fixed: Add `~/.xcsh/plugins/cache/plugins/` to the search path list
- Also scan `~/.xcsh/plugins/node_modules/*/` for plugin-provided catalogs

### Testing

- Index tests: verify O(1) lookup, search returns correct results, handles missing operations
- Cache tests: verify TTL expiry, LRU eviction, write-through invalidation, manual clear
- Batch tests: verify sequential execution, error handling modes, rate limiting, danger gate
- Plugin path tests: verify marketplace catalogs are discovered

## Stage 4: Integration

**Repo**: xcsh
**Goal**: Wire xcsh to consume the auto-generated catalog from api-specs-enriched releases.

### Sync Script: `marketplace/plugins/f5xc-platform/scripts/sync-catalog.ts`

- Downloads latest `api-catalog.json` from the api-specs-enriched GitHub release
- Uses `gh api` or direct HTTPS to fetch the release artifact
- Places it at `marketplace/plugins/f5xc-platform/api-catalog.json`
- Verifies schema compatibility: parses the JSON and validates it matches the expected `ApiCatalog` interface
- Run manually: `bun run sync-catalog`
- Run in CI: weekly cron job or triggered by api-specs-enriched release webhook

### Verification

After sync, verify end-to-end:
1. `api_services()` → lists f5xc with 300+ operations
2. `api_discover("f5xc", "load-balancers")` → shows full CRUD operations (list, get, create, delete)
3. `api_describe("f5xc", "create_http_loadbalancer")` → shows parameters, body schema, danger level
4. `api_call("f5xc", "list_http_loadbalancers")` → returns real data from F5XC API
5. `api_batch("f5xc", [{operation: "list_http_loadbalancers"}, {operation: "list_origin_pools"}])` → returns both results

## Ordering and Dependencies

| Stage | Repo | Depends On | Deliverable |
|-------|------|------------|-------------|
| 1. CRUD Discovery | api-specs-enriched | Live F5XC credentials | Updated openapi.json |
| 2. Catalog Compiler | api-specs-enriched | Stage 1 output | compile_catalog.py + GH release |
| 3. Runtime Upgrades | xcsh | None (parallel-safe) | Indexed/cached/batched runtime |
| 4. Integration | xcsh | Stage 2 artifact + Stage 3 | sync-catalog.ts + E2E verification |

Stages 1-2 are sequential in api-specs-enriched. Stage 3 can proceed in parallel. Stage 4 requires both Stage 2 and Stage 3 to be complete.

## What's NOT in Phase 2

- **Fuzzy/semantic search**: Substring search with keyword index is sufficient for 500 operations. Defer to Phase 3 if catalog grows to 3000+.
- **Response schema validation**: API responses are consumed as-is. JSON Schema validation against bodySchema is a Phase 3 enhancement.
- **Multi-tenant support**: Single F5XC tenant per xcsh session. Multi-tenant switching is out of scope.
- **Automatic catalog updates**: The sync script is manual or CI-triggered. No runtime auto-update mechanism.
