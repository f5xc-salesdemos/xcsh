# API Function Calls Phase 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Phase 1 API framework from a hand-crafted 17-operation catalog to a fully auto-generated CRUD catalog, with a spec compiler pipeline in `api-specs-enriched` and runtime scale improvements in `xcsh`.

**Architecture:** Four sequential stages across two repos — (1) extend `discover.py` for full CRUD endpoint coverage, (2) write `compile_catalog.py` to transform OpenAPI → xcsh catalog JSON and publish as a GitHub release artifact, (3) upgrade the xcsh runtime with indexed lookups, response caching, batch operations, and a plugin path fix, (4) wire xcsh to consume the generated catalog via a `sync-catalog.ts` script.

**Tech Stack:** Python 3.11+, pytest, TypeScript, Bun, `bun:test`, `node:fs/promises`, `node:path`, `@sinclair/typebox`, `httpx`

**Worktrees:**
- Stage 1 & 2: `/workspace/api-specs-enriched/`
- Stage 3 & 4: `/workspace/xcsh/.worktrees/feature/function-calls/`

**Spec:** `docs/superpowers/specs/2026-04-16-api-function-calls-phase2-design.md`

---

## File Map

### api-specs-enriched repo

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/discover.py` | Modify | Add CRUD method support, namespace auto-discovery, CRUD pattern inference |
| `scripts/compile_catalog.py` | Create | Transform OpenAPI JSON → xcsh api-catalog.json |
| `tests/test_compile_catalog.py` | Create | Unit tests for compiler (category grouping, naming, danger levels, params) |
| `tests/test_discover_crud.py` | Create | Unit tests for CRUD inference and safe write detection |
| `release/api-catalog.json` | Generated | Output artifact from compiler (not committed, produced by CI) |
| `.github/workflows/compile-catalog.yml` | Create | CI workflow: run compiler on push, attach as release artifact |

### xcsh repo

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/coding-agent/src/services/api-catalog.ts` | Modify | Add operation index + category index for O(1) lookups; keyword search index |
| `packages/coding-agent/src/services/api-executor.ts` | Modify | Add LRU response cache with TTL and write-through invalidation |
| `packages/coding-agent/src/tools/api-tool.ts` | Modify | Add `ApiBatchTool` class |
| `packages/coding-agent/src/tools/index.ts` | Modify | Register `api_batch` tool; add marketplace cache path to search paths |
| `marketplace/plugins/f5xc-platform/scripts/sync-catalog.ts` | Create | Download latest catalog artifact from api-specs-enriched GH releases |
| `packages/coding-agent/test/api-catalog.test.ts` | Modify | Add index tests |
| `packages/coding-agent/test/api-executor.test.ts` | Modify | Add cache tests |
| `packages/coding-agent/test/api-tool.test.ts` | Modify | Add batch tool tests |

---

## Task 1: CRUD Endpoint Inference in discover.py

**Repo:** api-specs-enriched
**Files:**
- Modify: `scripts/discover.py`
- Create: `tests/test_discover_crud.py`

The current `get_default_config()` only allows `GET` and `OPTIONS`. We need to add CRUD method support and a function that generates write-method variants from discovered list endpoints.

- [ ] **Step 1.1: Write failing tests for CRUD inference**

Create `tests/test_discover_crud.py`:

```python
# tests/test_discover_crud.py
import pytest
from scripts.discover import generate_crud_variants, is_list_endpoint, is_item_endpoint


def test_is_list_endpoint_true():
    assert is_list_endpoint("/api/config/namespaces/{namespace}/http_loadbalancers") is True


def test_is_list_endpoint_false_for_named():
    assert is_list_endpoint("/api/config/namespaces/{namespace}/http_loadbalancers/{name}") is False


def test_is_item_endpoint_true():
    assert is_item_endpoint("/api/config/namespaces/{namespace}/http_loadbalancers/{name}") is True


def test_is_item_endpoint_false_for_list():
    assert is_item_endpoint("/api/config/namespaces/{namespace}/http_loadbalancers") is False


def test_generate_crud_variants_from_list_endpoint():
    path = "/api/config/namespaces/{namespace}/http_loadbalancers"
    variants = generate_crud_variants(path)
    methods_and_paths = [(v["method"], v["path"]) for v in variants]
    assert ("POST", path) in methods_and_paths
    assert ("GET", path + "/{name}") in methods_and_paths
    assert ("PUT", path + "/{name}") in methods_and_paths
    assert ("DELETE", path + "/{name}") in methods_and_paths


def test_generate_crud_variants_no_duplicates():
    path = "/api/config/namespaces/{namespace}/http_loadbalancers"
    variants = generate_crud_variants(path)
    seen = set()
    for v in variants:
        key = (v["method"], v["path"])
        assert key not in seen, f"Duplicate variant: {key}"
        seen.add(key)


def test_generate_crud_variants_skips_already_item_path():
    # Item paths don't generate further sub-paths
    path = "/api/config/namespaces/{namespace}/http_loadbalancers/{name}"
    variants = generate_crud_variants(path)
    # Should only get PUT/PATCH/DELETE on the item path itself, no further nesting
    paths = [v["path"] for v in variants]
    assert not any("{name}/{" in p for p in paths)
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
cd /workspace/api-specs-enriched
python -m pytest tests/test_discover_crud.py -v
```

Expected: `ImportError` — `generate_crud_variants`, `is_list_endpoint`, `is_item_endpoint` not defined.

- [ ] **Step 1.3: Add the three functions to discover.py**

After the `resolve_path_params` function (around line 173), add:

```python
def is_list_endpoint(path: str) -> bool:
    """Return True if path ends with a collection (no trailing {name})."""
    segments = path.rstrip("/").split("/")
    last = segments[-1] if segments else ""
    return not (last.startswith("{") and last.endswith("}"))


def is_item_endpoint(path: str) -> bool:
    """Return True if path ends with a named item placeholder."""
    segments = path.rstrip("/").split("/")
    last = segments[-1] if segments else ""
    return last.startswith("{") and last.endswith("}")


def generate_crud_variants(path: str) -> list[dict[str, Any]]:
    """Generate CRUD endpoint variants from a list or item path.

    For list paths (ending in resource collection):
      POST   /path           — create
      GET    /path/{name}    — get by name
      PUT    /path/{name}    — replace
      DELETE /path/{name}    — delete

    For item paths (ending in {name}):
      PUT    /path           — replace
      PATCH  /path           — partial update
      DELETE /path           — delete
    """
    variants: list[dict[str, Any]] = []

    if is_list_endpoint(path):
        item_path = path + "/{name}"
        variants.append({"method": "POST", "path": path, "operation_id": "", "parameters": [], "responses": {}})
        variants.append({"method": "GET", "path": item_path, "operation_id": "", "parameters": [], "responses": {}})
        variants.append({"method": "PUT", "path": item_path, "operation_id": "", "parameters": [], "responses": {}})
        variants.append({"method": "DELETE", "path": item_path, "operation_id": "", "parameters": [], "responses": {}})
    else:
        variants.append({"method": "PUT", "path": path, "operation_id": "", "parameters": [], "responses": {}})
        variants.append({"method": "PATCH", "path": path, "operation_id": "", "parameters": [], "responses": {}})
        variants.append({"method": "DELETE", "path": path, "operation_id": "", "parameters": [], "responses": {}})

    return variants
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
cd /workspace/api-specs-enriched
python -m pytest tests/test_discover_crud.py -v
```

Expected: all 7 tests pass.

- [ ] **Step 1.5: Update get_default_config to enable all CRUD methods**

In `get_default_config()` (around line 57), change:

```python
# Before:
"methods": ["GET", "OPTIONS"],

# After:
"methods": ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
```

- [ ] **Step 1.6: Add CRUD inference to run_discovery**

In `run_discovery()`, after the line `endpoints = extract_endpoints_from_specs(specs_dir)` (around line 461), add CRUD expansion:

```python
# Expand GET list endpoints into full CRUD variants
crud_additions: list[dict[str, Any]] = []
existing_keys = {(e["method"], e["path"]) for e in endpoints}
for ep in list(endpoints):
    if ep["method"] == "GET":
        for variant in generate_crud_variants(ep["path"]):
            key = (variant["method"], variant["path"])
            if key not in existing_keys:
                crud_additions.append(variant)
                existing_keys.add(key)
endpoints = endpoints + crud_additions
console.print(f"[blue]After CRUD expansion: {len(endpoints)} endpoints[/blue]")
```

- [ ] **Step 1.7: Add namespace auto-discovery**

Replace the hardcoded `namespaces` logic in `run_discovery()`. Currently session uses:
```python
namespaces=[namespace] if namespace else config.get("exploration", {}).get("namespaces", ["system"]),
```

Add a function above `run_discovery` to fetch namespaces from the live API:

```python
async def fetch_namespaces(client: httpx.AsyncClient, base_url: str) -> list[str]:
    """Fetch available namespaces from the F5XC API."""
    try:
        response = await client.get(f"{base_url.rstrip('/')}/api/web/namespaces", timeout=10)
        if response.status_code == 200:
            data = response.json()
            items = data.get("items", [])
            names = [item.get("name") for item in items if item.get("name")]
            if names:
                console.print(f"[green]Auto-discovered {len(names)} namespaces: {', '.join(names[:5])}{'...' if len(names) > 5 else ''}[/green]")
                return names
    except Exception as e:
        console.print(f"[yellow]Namespace auto-discovery failed: {e} — using config defaults[/yellow]")
    return []
```

Then in `run_discovery()`, after the client is created (inside the `async with httpx.AsyncClient` block), add before the discovery loop:

```python
# Auto-discover namespaces if not specified
if not namespace:
    auto_namespaces = await fetch_namespaces(client, session.api_url)
    if auto_namespaces:
        session.namespaces = auto_namespaces
```

- [ ] **Step 1.8: Write tests for namespace auto-discovery**

Add to `tests/test_discover_crud.py`:

```python
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from scripts.discover import fetch_namespaces


@pytest.mark.asyncio
async def test_fetch_namespaces_success():
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "items": [{"name": "default"}, {"name": "production"}, {"name": "staging"}]
    }
    mock_client = AsyncMock()
    mock_client.get.return_value = mock_response

    result = await fetch_namespaces(mock_client, "https://example.f5xc.com")
    assert result == ["default", "production", "staging"]


@pytest.mark.asyncio
async def test_fetch_namespaces_failure_returns_empty():
    mock_client = AsyncMock()
    mock_client.get.side_effect = Exception("network error")

    result = await fetch_namespaces(mock_client, "https://example.f5xc.com")
    assert result == []
```

- [ ] **Step 1.9: Run all discover tests**

```bash
cd /workspace/api-specs-enriched
python -m pytest tests/test_discover_crud.py -v
```

Expected: all 9 tests pass.

- [ ] **Step 1.10: Commit**

```bash
cd /workspace/api-specs-enriched
git add scripts/discover.py tests/test_discover_crud.py
git commit -m "feat(discover): add CRUD method support and endpoint inference

- Enable POST/PUT/PATCH/DELETE in default config
- generate_crud_variants() expands list endpoints into full CRUD set
- run_discovery() auto-expands discovered GET endpoints
- fetch_namespaces() auto-discovers tenants from live API"
```

---

## Task 2: Catalog Compiler

**Repo:** api-specs-enriched
**Files:**
- Create: `scripts/compile_catalog.py`
- Create: `tests/test_compile_catalog.py`

The compiler transforms `specs/discovered/openapi.json` into xcsh's `api-catalog.json` format. It must be deterministic: same input always produces the same output.

- [ ] **Step 2.1: Write failing tests for the compiler**

Create `tests/test_compile_catalog.py`:

```python
# tests/test_compile_catalog.py
import json
import pytest
from scripts.compile_catalog import (
    assign_danger_level,
    extract_category_name,
    generate_operation_name,
    extract_parameters,
    compile_catalog,
    group_paths_by_resource,
)


def test_assign_danger_level_get():
    assert assign_danger_level("GET") == "low"


def test_assign_danger_level_options():
    assert assign_danger_level("OPTIONS") == "low"


def test_assign_danger_level_post():
    assert assign_danger_level("POST") == "medium"


def test_assign_danger_level_put():
    assert assign_danger_level("PUT") == "medium"


def test_assign_danger_level_patch():
    assert assign_danger_level("PATCH") == "medium"


def test_assign_danger_level_delete():
    assert assign_danger_level("DELETE") == "high"


def test_extract_category_name_namespace_path():
    path = "/api/config/namespaces/{namespace}/http_loadbalancers"
    assert extract_category_name(path) == "http-loadbalancers"


def test_extract_category_name_web_path():
    path = "/api/web/namespaces"
    assert extract_category_name(path) == "namespaces"


def test_extract_category_name_item_path():
    path = "/api/config/namespaces/{namespace}/http_loadbalancers/{name}"
    assert extract_category_name(path) == "http-loadbalancers"


def test_generate_operation_name_list():
    assert generate_operation_name("GET", "/api/config/namespaces/{namespace}/http_loadbalancers") == "list_http_loadbalancers"


def test_generate_operation_name_get_item():
    assert generate_operation_name("GET", "/api/config/namespaces/{namespace}/http_loadbalancers/{name}") == "get_http_loadbalancer"


def test_generate_operation_name_post():
    assert generate_operation_name("POST", "/api/config/namespaces/{namespace}/http_loadbalancers") == "create_http_loadbalancer"


def test_generate_operation_name_put():
    assert generate_operation_name("PUT", "/api/config/namespaces/{namespace}/http_loadbalancers/{name}") == "replace_http_loadbalancer"


def test_generate_operation_name_patch():
    assert generate_operation_name("PATCH", "/api/config/namespaces/{namespace}/http_loadbalancers/{name}") == "update_http_loadbalancer"


def test_generate_operation_name_delete():
    assert generate_operation_name("DELETE", "/api/config/namespaces/{namespace}/http_loadbalancers/{name}") == "delete_http_loadbalancer"


def test_extract_parameters_path_params():
    path = "/api/config/namespaces/{namespace}/http_loadbalancers/{name}"
    params = extract_parameters(path, {})
    assert any(p["name"] == "namespace" and p["in"] == "path" and p["required"] is True for p in params)
    assert any(p["name"] == "name" and p["in"] == "path" and p["required"] is True for p in params)


def test_extract_parameters_namespace_gets_default():
    path = "/api/config/namespaces/{namespace}/http_loadbalancers"
    params = extract_parameters(path, {})
    ns_param = next(p for p in params if p["name"] == "namespace")
    assert ns_param["default"] == "$F5XC_NAMESPACE"


def test_group_paths_by_resource():
    paths = {
        "/api/config/namespaces/{namespace}/http_loadbalancers": {"get": {}},
        "/api/config/namespaces/{namespace}/http_loadbalancers/{name}": {"delete": {}},
        "/api/config/namespaces/{namespace}/origin_pools": {"get": {}},
    }
    groups = group_paths_by_resource(paths)
    assert "http-loadbalancers" in groups
    assert "origin-pools" in groups
    assert len(groups["http-loadbalancers"]) == 2


def test_compile_catalog_structure():
    openapi = {
        "openapi": "3.0.3",
        "paths": {
            "/api/config/namespaces/{namespace}/http_loadbalancers": {
                "get": {"operationId": "list_lbs", "responses": {}}
            },
            "/api/config/namespaces/{namespace}/http_loadbalancers/{name}": {
                "delete": {"operationId": "delete_lb", "responses": {}}
            },
        }
    }
    catalog = compile_catalog(openapi)
    assert catalog["service"] == "f5xc"
    assert catalog["auth"]["type"] == "api_token"
    assert catalog["auth"]["headerTemplate"] == "APIToken {token}"
    assert len(catalog["categories"]) >= 1
    cat = next(c for c in catalog["categories"] if c["name"] == "http-loadbalancers")
    op_names = [op["name"] for op in cat["operations"]]
    assert "list_http_loadbalancers" in op_names
    assert "delete_http_loadbalancer" in op_names


def test_compile_catalog_operation_fields():
    openapi = {
        "openapi": "3.0.3",
        "paths": {
            "/api/config/namespaces/{namespace}/http_loadbalancers/{name}": {
                "delete": {"operationId": "delete_lb", "responses": {}}
            },
        }
    }
    catalog = compile_catalog(openapi)
    cat = catalog["categories"][0]
    op = cat["operations"][0]
    assert op["method"] == "DELETE"
    assert op["dangerLevel"] == "high"
    assert op["path"] == "/api/config/namespaces/{namespace}/http_loadbalancers/{name}"
    assert any(p["name"] == "namespace" for p in op["parameters"])
    assert any(p["name"] == "name" for p in op["parameters"])


def test_compile_catalog_deterministic():
    openapi = {
        "openapi": "3.0.3",
        "paths": {
            "/api/config/namespaces/{namespace}/http_loadbalancers": {"get": {"responses": {}}},
            "/api/config/namespaces/{namespace}/origin_pools": {"get": {"responses": {}}},
        }
    }
    result1 = compile_catalog(openapi)
    result2 = compile_catalog(openapi)
    assert result1 == result2
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
cd /workspace/api-specs-enriched
python -m pytest tests/test_compile_catalog.py -v
```

Expected: `ModuleNotFoundError` — `scripts.compile_catalog` not found.

- [ ] **Step 2.3: Create scripts/compile_catalog.py**

```python
#!/usr/bin/env python3
# Copyright (c) 2026 Robin Mordasiewicz. MIT License.

"""Catalog Compiler — transforms F5XC OpenAPI specs into xcsh api-catalog.json format.

Usage:
    python -m scripts.compile_catalog                         # Uses specs/discovered/openapi.json
    python -m scripts.compile_catalog --input path/to/spec.json
    python -m scripts.compile_catalog --output release/api-catalog.json
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

DEFAULT_INPUT = Path("specs/discovered/openapi.json")
DEFAULT_OUTPUT = Path("release/api-catalog.json")

F5XC_AUTH = {
    "type": "api_token",
    "headerName": "Authorization",
    "headerTemplate": "APIToken {token}",
    "tokenSource": "F5XC_API_TOKEN",
    "baseUrlSource": "F5XC_API_URL",
}

F5XC_DEFAULTS = {
    "namespace": {"source": "F5XC_NAMESPACE"}
}

_DANGER_MAP: dict[str, str] = {
    "GET": "low",
    "OPTIONS": "low",
    "POST": "medium",
    "PUT": "medium",
    "PATCH": "medium",
    "DELETE": "high",
}


def assign_danger_level(method: str) -> str:
    """Map HTTP method to danger level."""
    return _DANGER_MAP.get(method.upper(), "medium")


def extract_category_name(path: str) -> str:
    """Derive kebab-case category name from an API path.

    Examples:
        /api/config/namespaces/{namespace}/http_loadbalancers       → http-loadbalancers
        /api/config/namespaces/{namespace}/http_loadbalancers/{name} → http-loadbalancers
        /api/web/namespaces                                          → namespaces
    """
    segments = [s for s in path.split("/") if s and not s.startswith("{")]
    # Strip known prefix segments
    prefix = {"api", "config", "web", "ml", "data"}
    filtered = [s for s in segments if s not in prefix]
    # The resource segment is the first non-"namespaces" segment after filtering
    # (skip the literal "namespaces" that precedes namespace parameter)
    resource_segments = []
    skip_next = False
    for seg in filtered:
        if seg == "namespaces":
            skip_next = True
            continue
        if skip_next:
            skip_next = False
            continue
        resource_segments.append(seg)
    resource = resource_segments[0] if resource_segments else filtered[-1] if filtered else "unknown"
    return resource.replace("_", "-")


def generate_operation_name(method: str, path: str) -> str:
    """Generate a snake_case operation name from HTTP method and path.

    Rules:
        GET  /resources        → list_resources
        GET  /resources/{name} → get_resource   (singular)
        POST /resources        → create_resource (singular)
        PUT  /resources/{name} → replace_resource (singular)
        PATCH /resources/{name}→ update_resource (singular)
        DELETE /resources/{name}→ delete_resource (singular)
    """
    category = extract_category_name(path)
    # Convert kebab to snake
    resource_snake = category.replace("-", "_")
    # Singular: strip trailing 's' if present (simple heuristic)
    singular = resource_snake.rstrip("s") if resource_snake.endswith("s") else resource_snake

    segments = path.rstrip("/").split("/")
    last_segment = segments[-1] if segments else ""
    is_item = last_segment.startswith("{") and last_segment.endswith("}")

    method = method.upper()
    if method == "GET" and not is_item:
        return f"list_{resource_snake}"
    elif method == "GET" and is_item:
        return f"get_{singular}"
    elif method == "POST":
        return f"create_{singular}"
    elif method == "PUT":
        return f"replace_{singular}"
    elif method == "PATCH":
        return f"update_{singular}"
    elif method == "DELETE":
        return f"delete_{singular}"
    else:
        return f"{method.lower()}_{singular}"


def extract_parameters(path: str, operation: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract parameters from path template and OpenAPI operation definition."""
    params: list[dict[str, Any]] = []

    # Path parameters from {placeholder} in path
    for match in re.finditer(r"\{([^}]+)\}", path):
        name = match.group(1)
        param: dict[str, Any] = {
            "name": name,
            "in": "path",
            "required": True,
            "type": "string",
        }
        if name == "namespace":
            param["default"] = "$F5XC_NAMESPACE"
        params.append(param)

    # Query parameters from OpenAPI spec
    for op_param in operation.get("parameters", []):
        if op_param.get("in") == "query":
            params.append({
                "name": op_param["name"],
                "in": "query",
                "required": op_param.get("required", False),
                "type": op_param.get("schema", {}).get("type", "string"),
            })

    return params


def group_paths_by_resource(paths: dict[str, Any]) -> dict[str, list[tuple[str, str, dict]]]:
    """Group (path, method, operation) tuples by category name.

    Returns dict mapping category_name → list of (path, method, operation_dict).
    """
    groups: dict[str, list[tuple[str, str, dict]]] = {}
    for path, path_item in sorted(paths.items()):
        if not isinstance(path_item, dict):
            continue
        category = extract_category_name(path)
        if category not in groups:
            groups[category] = []
        for method, operation in path_item.items():
            if method.lower() in ("get", "post", "put", "patch", "delete", "options"):
                groups[category].append((path, method.upper(), operation or {}))
    return groups


def compile_catalog(openapi: dict[str, Any]) -> dict[str, Any]:
    """Transform an OpenAPI 3.0 spec dict into xcsh api-catalog.json format."""
    paths = openapi.get("paths", {})
    groups = group_paths_by_resource(paths)

    categories = []
    for category_name in sorted(groups.keys()):
        entries = groups[category_name]
        operations = []
        seen_op_names: set[str] = set()
        for path, method, operation in sorted(entries, key=lambda e: (e[0], e[1])):
            op_name = generate_operation_name(method, path)
            if op_name in seen_op_names:
                continue
            seen_op_names.add(op_name)
            op: dict[str, Any] = {
                "name": op_name,
                "description": operation.get("summary") or operation.get("description") or f"{method} {path}",
                "method": method,
                "path": path,
                "dangerLevel": assign_danger_level(method),
                "parameters": extract_parameters(path, operation),
            }
            # Include body schema if present
            body_schema = (
                operation.get("requestBody", {})
                .get("content", {})
                .get("application/json", {})
                .get("schema")
            )
            if body_schema:
                op["bodySchema"] = body_schema
            operations.append(op)

        if operations:
            display_name = category_name.replace("-", " ").title()
            categories.append({
                "name": category_name,
                "displayName": display_name,
                "operations": operations,
            })

    return {
        "service": "f5xc",
        "displayName": "F5 Distributed Cloud",
        "version": "1.0.0",
        "specSource": "f5xc-salesdemos/api-specs-enriched",
        "auth": F5XC_AUTH,
        "defaults": F5XC_DEFAULTS,
        "categories": categories,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile F5XC OpenAPI spec to xcsh catalog JSON")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="OpenAPI spec input file")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output api-catalog.json path")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"Error: input file not found: {args.input}", file=sys.stderr)
        return 1

    with args.input.open() as f:
        openapi = json.load(f)

    catalog = compile_catalog(openapi)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w") as f:
        json.dump(catalog, f, indent=2)
        f.write("\n")

    total_ops = sum(len(c["operations"]) for c in catalog["categories"])
    print(f"Compiled {total_ops} operations across {len(catalog['categories'])} categories → {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
cd /workspace/api-specs-enriched
python -m pytest tests/test_compile_catalog.py -v
```

Expected: all 18 tests pass.

- [ ] **Step 2.5: Run compiler against existing spec to validate output**

```bash
cd /workspace/api-specs-enriched
python -m scripts.compile_catalog --input specs/discovered/openapi.json --output /tmp/test-catalog.json
node -e "
const c = require('/tmp/test-catalog.json');
const ops = c.categories.reduce((n,cat) => n + cat.operations.length, 0);
console.log('Service:', c.service);
console.log('Categories:', c.categories.length);
console.log('Operations:', ops);
console.log('Auth type:', c.auth.type);
console.log('Auth header template:', c.auth.headerTemplate);
"
```

Expected output (approximate, will vary with 80-op spec):
```
Service: f5xc
Categories: 15
Operations: 80
Auth type: api_token
Auth header template: APIToken {token}
```

- [ ] **Step 2.6: Create CI workflow**

Create `.github/workflows/compile-catalog.yml`:

```yaml
name: Compile API Catalog

on:
  push:
    branches: [main]
    paths:
      - 'specs/discovered/openapi.json'
  workflow_dispatch:

jobs:
  compile:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: pip

      - name: Install dependencies
        run: pip install -r requirements.txt

      - name: Compile catalog
        run: python -m scripts.compile_catalog

      - name: Verify output
        run: |
          python3 -c "
          import json
          c = json.load(open('release/api-catalog.json'))
          ops = sum(len(cat['operations']) for cat in c['categories'])
          print(f'Compiled {ops} operations across {len(c[\"categories\"])} categories')
          assert c['service'] == 'f5xc', 'Wrong service name'
          assert c['auth']['type'] == 'api_token', 'Wrong auth type'
          "

      - name: Create release artifact
        uses: softprops/action-gh-release@v2
        if: github.ref == 'refs/heads/main'
        with:
          tag_name: catalog-${{ github.run_number }}
          name: F5XC API Catalog ${{ github.run_number }}
          files: release/api-catalog.json
          generate_release_notes: false
          body: |
            Auto-generated F5XC API catalog from discovered OpenAPI spec.
            Commit: ${{ github.sha }}
```

- [ ] **Step 2.7: Commit**

```bash
cd /workspace/api-specs-enriched
git add scripts/compile_catalog.py tests/test_compile_catalog.py .github/workflows/compile-catalog.yml
git commit -m "feat: add catalog compiler and CI workflow

compile_catalog.py transforms OpenAPI spec → xcsh api-catalog.json.
CI compiles on every push to main that touches openapi.json and
publishes as a GitHub release artifact."
```

---

## Task 3: Indexed Operation Lookups

**Repo:** xcsh
**Files:**
- Modify: `packages/coding-agent/src/services/api-catalog.ts`
- Modify: `packages/coding-agent/test/api-catalog.test.ts`

Replace O(n) linear scans with indexed maps built at catalog load time.

- [ ] **Step 3.1: Write failing tests for indexed lookups**

Add the following to the end of `packages/coding-agent/test/api-catalog.test.ts`:

```typescript
describe("ApiCatalogService — indexed lookups", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-index-"));
    const catalog = {
      service: "test",
      displayName: "Test",
      version: "1.0.0",
      auth: { type: "bearer", headerName: "Authorization", headerTemplate: "Bearer {token}", tokenSource: "TOKEN", baseUrlSource: "BASE_URL" },
      categories: [
        {
          name: "widgets",
          displayName: "Widgets",
          operations: [
            { name: "list_widgets", description: "List all widgets", method: "GET", path: "/widgets", dangerLevel: "low", parameters: [] },
            { name: "get_widget", description: "Get a widget by name", method: "GET", path: "/widgets/{name}", dangerLevel: "low", parameters: [] },
            { name: "delete_widget", description: "Remove a widget", method: "DELETE", path: "/widgets/{name}", dangerLevel: "high", parameters: [] },
          ],
        },
        {
          name: "gadgets",
          displayName: "Gadgets",
          operations: [
            { name: "list_gadgets", description: "List all gadgets", method: "GET", path: "/gadgets", dangerLevel: "low", parameters: [] },
          ],
        },
      ],
    };
    await Bun.write(path.join(dir, "api-catalog.json"), JSON.stringify(catalog));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true });
  });

  test("getOperation returns correct operation without linear scan", async () => {
    const svc = new ApiCatalogService([dir]);
    const op = await svc.getOperation("test", "delete_widget");
    expect(op).not.toBeNull();
    expect(op?.method).toBe("DELETE");
    expect(op?.dangerLevel).toBe("high");
  });

  test("getOperation returns null for unknown operation name", async () => {
    const svc = new ApiCatalogService([dir]);
    const op = await svc.getOperation("test", "nonexistent_op");
    expect(op).toBeNull();
  });

  test("getOperations with category filter uses category index", async () => {
    const svc = new ApiCatalogService([dir]);
    const ops = await svc.getOperations("test", "gadgets");
    expect(ops).toHaveLength(1);
    expect(ops[0].name).toBe("list_gadgets");
  });

  test("search uses keyword index", async () => {
    const svc = new ApiCatalogService([dir]);
    const results = await svc.search("test", "widget");
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.every(r => r.name.includes("widget") || r.description.toLowerCase().includes("widget"))).toBe(true);
  });

  test("search returns empty for no match", async () => {
    const svc = new ApiCatalogService([dir]);
    const results = await svc.search("test", "zzznomatch");
    expect(results).toHaveLength(0);
  });
});
```

- [ ] **Step 3.2: Run tests to verify the new tests fail (or pass via current impl)**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test packages/coding-agent/test/api-catalog.test.ts 2>&1 | tail -15
```

Existing tests should still pass. New indexed tests will pass via the existing linear implementation — that's fine. The index is a performance optimization, not a behavioral change. All 5 new tests must pass before proceeding.

- [ ] **Step 3.3: Add indexes to ApiCatalogService**

Replace the current `ApiCatalogService` implementation in `packages/coding-agent/src/services/api-catalog.ts`:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@f5xc-salesdemos/pi-utils";
import type { ApiCatalog, ApiCatalogMeta, ApiCategory, ApiOperation } from "./api-types";

interface CatalogIndex {
  operationsByName: Map<string, ApiOperation>;
  categoriesByName: Map<string, ApiCategory>;
  keywordIndex: Map<string, Set<string>>; // keyword → set of operation names
}

export class ApiCatalogService {
  #catalogs = new Map<string, ApiCatalog>();
  #indexes = new Map<string, CatalogIndex>();
  #meta = new Map<string, ApiCatalogMeta>();
  #searchPaths: string[];
  #scanned = false;

  constructor(searchPaths: string[]) {
    this.#searchPaths = searchPaths;
  }

  async getServices(): Promise<ApiCatalogMeta[]> {
    if (!this.#scanned) await this.#scan();
    return [...this.#meta.values()];
  }

  async getCatalog(service: string): Promise<ApiCatalog | null> {
    if (!this.#scanned) await this.#scan();
    if (this.#catalogs.has(service)) return this.#catalogs.get(service)!;
    const meta = this.#meta.get(service);
    if (!meta) return null;
    const catalog = await this.#load(meta.filePath);
    if (catalog) {
      this.#catalogs.set(service, catalog);
      this.#buildIndex(service, catalog);
    }
    return catalog;
  }

  async getOperations(service: string, category?: string): Promise<ApiOperation[]> {
    const catalog = await this.getCatalog(service);
    if (!catalog) return [];
    if (!category) return [...this.#indexes.get(service)!.operationsByName.values()];
    const cat = this.#indexes.get(service)?.categoriesByName.get(category);
    return cat ? [...cat.operations] : [];
  }

  async getOperation(service: string, operationName: string): Promise<ApiOperation | null> {
    await this.getCatalog(service);
    return this.#indexes.get(service)?.operationsByName.get(operationName) ?? null;
  }

  async search(service: string, query: string): Promise<ApiOperation[]> {
    await this.getCatalog(service);
    const index = this.#indexes.get(service);
    if (!index) return [];
    const q = query.toLowerCase();
    const matchingOpNames = new Set<string>();
    for (const [keyword, opNames] of index.keywordIndex) {
      if (keyword.includes(q)) {
        for (const name of opNames) matchingOpNames.add(name);
      }
    }
    return [...matchingOpNames].map(name => index.operationsByName.get(name)!).filter(Boolean);
  }

  #buildIndex(service: string, catalog: ApiCatalog): void {
    const operationsByName = new Map<string, ApiOperation>();
    const categoriesByName = new Map<string, ApiCategory>();
    const keywordIndex = new Map<string, Set<string>>();

    const addKeyword = (keyword: string, opName: string) => {
      if (!keywordIndex.has(keyword)) keywordIndex.set(keyword, new Set());
      keywordIndex.get(keyword)!.add(opName);
    };

    for (const category of catalog.categories) {
      categoriesByName.set(category.name, category);
      for (const op of category.operations) {
        operationsByName.set(op.name, op);
        // Index operation name tokens
        for (const token of op.name.split("_")) addKeyword(token, op.name);
        // Index description words
        for (const word of op.description.toLowerCase().split(/\s+/)) {
          if (word.length > 2) addKeyword(word, op.name);
        }
        // Index category name
        addKeyword(category.name, op.name);
      }
    }

    this.#indexes.set(service, { operationsByName, categoriesByName, keywordIndex });
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
        this.#catalogs.set(catalog.service, catalog);
        this.#buildIndex(catalog.service, catalog);
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
      return (await Bun.file(filePath).json()) as ApiCatalog;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 3.4: Run all catalog tests**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test packages/coding-agent/test/api-catalog.test.ts 2>&1 | tail -10
```

Expected: all tests pass (including pre-existing 11 tests + 5 new).

- [ ] **Step 3.5: Commit**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
git add packages/coding-agent/src/services/api-catalog.ts packages/coding-agent/test/api-catalog.test.ts
git commit -m "perf(coding-agent): add indexed lookups to ApiCatalogService

O(1) getOperation(), category index, keyword search index.
Built at catalog load time — no change to public interface."
```

---

## Task 4: Response Caching in ApiExecutor

**Repo:** xcsh
**Files:**
- Modify: `packages/coding-agent/src/services/api-executor.ts`
- Modify: `packages/coding-agent/test/api-executor.test.ts`

Add an LRU response cache to `ApiExecutor` with 60s TTL for GET responses and write-through invalidation.

- [ ] **Step 4.1: Write failing cache tests**

Add the following to `packages/coding-agent/test/api-executor.test.ts`:

```typescript
describe("ApiExecutor — response caching", () => {
  const auth: ResolvedAuth = { headers: { Authorization: "APIToken test" }, baseUrl: "https://api.example.com" };
  const getOp: ApiOperation = {
    name: "list_widgets", description: "List widgets", method: "GET",
    path: "/api/widgets", dangerLevel: "low", parameters: [],
  };
  const deleteOp: ApiOperation = {
    name: "delete_widget", description: "Delete a widget", method: "DELETE",
    path: "/api/widgets/{name}", dangerLevel: "high", parameters: [
      { name: "name", in: "path", required: true, type: "string" },
    ],
  };

  afterEach(() => {
    fetchMock.restore();
  });

  test("GET response is cached on second call", async () => {
    fetchMock.mock("https://api.example.com/api/widgets", { status: 200, body: JSON.stringify({ items: [1, 2] }) });
    const executor = new ApiExecutor();
    await executor.execute(auth, getOp, {});
    await executor.execute(auth, getOp, {});
    expect(fetchMock.calls().length).toBe(1); // second call served from cache
  });

  test("DELETE invalidates cached GET for same resource path", async () => {
    fetchMock.mock("https://api.example.com/api/widgets", { status: 200, body: JSON.stringify({ items: [1] }) });
    fetchMock.mock("https://api.example.com/api/widgets/foo", { status: 200, body: JSON.stringify({}) });
    const executor = new ApiExecutor();
    await executor.execute(auth, getOp, {});           // cached
    await executor.execute(auth, deleteOp, { name: "foo" }); // invalidates cache
    await executor.execute(auth, getOp, {});           // must re-fetch
    expect(fetchMock.calls().length).toBe(3);
  });

  test("clearCache() forces re-fetch on next GET", async () => {
    fetchMock.mock("https://api.example.com/api/widgets", { status: 200, body: JSON.stringify({ items: [] }) });
    const executor = new ApiExecutor();
    await executor.execute(auth, getOp, {});
    executor.clearCache();
    await executor.execute(auth, getOp, {});
    expect(fetchMock.calls().length).toBe(2);
  });

  test("POST response is never cached", async () => {
    const postOp: ApiOperation = {
      name: "create_widget", description: "Create a widget", method: "POST",
      path: "/api/widgets", dangerLevel: "medium", parameters: [],
    };
    fetchMock.mock("https://api.example.com/api/widgets", { status: 201, body: JSON.stringify({ name: "new" }) }, { method: "POST" });
    const executor = new ApiExecutor();
    await executor.execute(auth, postOp, {}, { name: "new" });
    await executor.execute(auth, postOp, {}, { name: "new" });
    expect(fetchMock.calls().length).toBe(2);
  });
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test packages/coding-agent/test/api-executor.test.ts 2>&1 | tail -15
```

Expected: new cache tests fail — `clearCache is not a function` or cache not working.

- [ ] **Step 4.3: Add LRU cache to ApiExecutor**

Replace `api-executor.ts` with the following (adds cache, keeps all existing logic):

```typescript
import { logger } from "@f5xc-salesdemos/pi-utils";
import type { ApiAuthConfig, ApiOperation, ResolvedAuth } from "./api-types";

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 100;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

export class ApiExecutor {
  #cache = new Map<string, CacheEntry>();
  #lruOrder: string[] = [];

  clearCache(): void {
    this.#cache.clear();
    this.#lruOrder = [];
  }

  resolveAuth(auth: ApiAuthConfig): ResolvedAuth {
    const baseUrl = this.#requireEnv(auth.baseUrlSource);
    const headers: Record<string, string> = {};

    if (auth.type === "api_token" || auth.type === "bearer") {
      const token = this.#requireEnv(auth.tokenSource!);
      const defaultTemplate = auth.type === "bearer" ? "Bearer {token}" : "{token}";
      const headerValue = (auth.headerTemplate ?? defaultTemplate).replace("{token}", token);
      headers[auth.headerName ?? "Authorization"] = headerValue;
    } else if (auth.type === "basic") {
      const username = this.#requireEnv(auth.usernameSource!);
      const password = this.#requireEnv(auth.passwordSource!);
      headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`;
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
        const envValue = process.env[param.default.slice(1)];
        if (envValue) resolved[param.name] = envValue;
      } else {
        resolved[param.name] = param.default;
      }
    }

    return resolved;
  }

  resolveUrl(
    baseUrl: string,
    pathTemplate: string,
    pathParams: Record<string, string>,
    queryParams?: Record<string, string>,
  ): string {
    let resolved = pathTemplate;
    for (const [key, value] of Object.entries(pathParams)) {
      resolved = resolved.replace(`{${key}}`, encodeURIComponent(value));
    }
    const url = baseUrl.replace(/\/$/, "") + resolved;
    if (queryParams && Object.keys(queryParams).length > 0) {
      return `${url}?${new URLSearchParams(queryParams).toString()}`;
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
    const pathParams: Record<string, string> = {};
    const queryParams: Record<string, string> = {};

    for (const param of op.parameters ?? []) {
      const value = resolvedParams[param.name];
      if (value === undefined) continue;
      if (param.in === "path") pathParams[param.name] = value;
      else if (param.in === "query") queryParams[param.name] = value;
    }

    const url = this.resolveUrl(auth.baseUrl, op.path, pathParams, queryParams);

    // Serve GET from cache if valid
    if (op.method === "GET") {
      const cached = this.#getCached(url);
      if (cached !== undefined) {
        logger.debug("ApiExecutor: cache hit", { url });
        return { ok: true, data: cached };
      }
    }

    // Invalidate cache for write operations on the same resource base path
    if (WRITE_METHODS.has(op.method)) {
      this.#invalidateByPrefix(auth.baseUrl + op.path.replace(/\/\{[^}]+\}$/, ""));
    }

    const headers: Record<string, string> = { "Content-Type": "application/json", ...auth.headers };
    const init: RequestInit = { method: op.method, headers, signal };

    if (body && ["POST", "PUT", "PATCH"].includes(op.method)) {
      init.body = JSON.stringify(body);
    }

    logger.debug("ApiExecutor: executing request", { method: op.method, url });

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      return { ok: false, status: 0, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
    }

    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!response.ok) {
      const errMsg =
        typeof data === "object" && data !== null && "message" in data
          ? (data as { message: string }).message
          : text;
      logger.debug("ApiExecutor: request failed", { status: response.status, url });
      return { ok: false, status: response.status, error: `HTTP ${response.status}: ${errMsg}` };
    }

    // Cache successful GET responses
    if (op.method === "GET") {
      this.#setCache(url, data);
    }

    return { ok: true, data };
  }

  #getCached(url: string): unknown | undefined {
    const entry = this.#cache.get(url);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.#cache.delete(url);
      this.#lruOrder = this.#lruOrder.filter(k => k !== url);
      return undefined;
    }
    // Move to end of LRU order
    this.#lruOrder = this.#lruOrder.filter(k => k !== url);
    this.#lruOrder.push(url);
    return entry.data;
  }

  #setCache(url: string, data: unknown): void {
    if (this.#cache.size >= CACHE_MAX_SIZE) {
      const oldest = this.#lruOrder.shift();
      if (oldest) this.#cache.delete(oldest);
    }
    this.#cache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    this.#lruOrder = this.#lruOrder.filter(k => k !== url);
    this.#lruOrder.push(url);
  }

  #invalidateByPrefix(prefix: string): void {
    for (const key of this.#cache.keys()) {
      if (key.startsWith(prefix)) {
        this.#cache.delete(key);
        this.#lruOrder = this.#lruOrder.filter(k => k !== key);
      }
    }
  }

  #requireEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  }
}
```

- [ ] **Step 4.4: Run all executor tests**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test packages/coding-agent/test/api-executor.test.ts 2>&1 | tail -10
```

Expected: all tests pass (existing + 4 new cache tests).

- [ ] **Step 4.5: Commit**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
git add packages/coding-agent/src/services/api-executor.ts packages/coding-agent/test/api-executor.test.ts
git commit -m "perf(coding-agent): add LRU response cache to ApiExecutor

60s TTL for GET responses, 100-entry LRU eviction.
Write operations auto-invalidate same-prefix GET cache entries.
clearCache() for manual invalidation."
```

---

## Task 5: api_batch Tool

**Repo:** xcsh
**Files:**
- Modify: `packages/coding-agent/src/tools/api-tool.ts`
- Modify: `packages/coding-agent/src/tools/index.ts`
- Modify: `packages/coding-agent/test/api-tool.test.ts`

Add a fifth tool `api_batch` that executes multiple operations sequentially.

- [ ] **Step 5.1: Write failing batch tool tests**

Add to the end of `packages/coding-agent/test/api-tool.test.ts`:

```typescript
describe("ApiBatchTool", () => {
  let catalog: ApiCatalogService;
  let executor: ApiExecutor;
  let dir: string;

  beforeEach(async () => {
    Settings.reset();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-tool-"));
    const catalogJson = {
      service: "svc",
      displayName: "Service",
      version: "1.0.0",
      auth: { type: "bearer", headerTemplate: "Bearer {token}", tokenSource: "TEST_TOKEN", baseUrlSource: "TEST_BASE_URL" },
      categories: [{
        name: "widgets",
        displayName: "Widgets",
        operations: [
          { name: "list_widgets", description: "List", method: "GET", path: "/widgets", dangerLevel: "low", parameters: [] },
          { name: "list_gadgets", description: "List gadgets", method: "GET", path: "/gadgets", dangerLevel: "low", parameters: [] },
          { name: "delete_widget", description: "Delete", method: "DELETE", path: "/widgets/{name}", dangerLevel: "high", parameters: [{ name: "name", in: "path", required: true, type: "string" }] },
        ],
      }],
    };
    await Bun.write(path.join(dir, "api-catalog.json"), JSON.stringify(catalogJson));
    catalog = new ApiCatalogService([dir]);
    executor = new ApiExecutor();
    process.env["TEST_TOKEN"] = "tok";
    process.env["TEST_BASE_URL"] = "https://api.example.com";
  });

  afterEach(async () => {
    fetchMock.restore();
    delete process.env["TEST_TOKEN"];
    delete process.env["TEST_BASE_URL"];
    await fs.rm(dir, { recursive: true });
  });

  test("executes multiple operations and returns aggregated results", async () => {
    fetchMock.mock("https://api.example.com/widgets", { status: 200, body: JSON.stringify({ items: [1] }) });
    fetchMock.mock("https://api.example.com/gadgets", { status: 200, body: JSON.stringify({ items: [2] }) });
    const tool = new ApiBatchTool(catalog, executor);
    const result = await tool.execute("id", {
      service: "svc",
      operations: [{ operation: "list_widgets" }, { operation: "list_gadgets" }],
    });
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("list_widgets");
    expect(text).toContain("list_gadgets");
  });

  test("continues on failure in best-effort mode (default)", async () => {
    fetchMock.mock("https://api.example.com/widgets", { status: 500, body: "error" });
    fetchMock.mock("https://api.example.com/gadgets", { status: 200, body: JSON.stringify({ items: [] }) });
    const tool = new ApiBatchTool(catalog, executor);
    const result = await tool.execute("id", {
      service: "svc",
      operations: [{ operation: "list_widgets" }, { operation: "list_gadgets" }],
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("list_gadgets");
  });

  test("returns error for unknown service", async () => {
    const tool = new ApiBatchTool(catalog, executor);
    const result = await tool.execute("id", {
      service: "unknown",
      operations: [{ operation: "list_widgets" }],
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("not found");
  });

  test("returns error for unknown operation name", async () => {
    const tool = new ApiBatchTool(catalog, executor);
    const result = await tool.execute("id", {
      service: "svc",
      operations: [{ operation: "nonexistent_op" }],
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("not found");
  });
});
```

- [ ] **Step 5.2: Run tests to verify they fail**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test packages/coding-agent/test/api-tool.test.ts 2>&1 | tail -15
```

Expected: `ApiBatchTool is not defined`.

- [ ] **Step 5.3: Add ApiBatchTool to api-tool.ts**

Add the following after the existing `ApiCallTool` class (end of file):

```typescript
// ─── api_batch ────────────────────────────────────────────────────────────────

const batchSchema = Type.Object({
  service: Type.String({ description: "Vendor service name (e.g., 'f5xc')" }),
  operations: Type.Array(
    Type.Object({
      operation: Type.String({ description: "Operation name to execute" }),
      params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Path and query parameters" })),
      body: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Request body for POST/PUT/PATCH" })),
    }),
    { description: "List of operations to execute sequentially" },
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("best-effort"), Type.Literal("strict")], {
      description: "Error mode: 'best-effort' continues on failure, 'strict' stops on first error (default: best-effort)",
    }),
  ),
});

export class ApiBatchTool implements AgentTool<typeof batchSchema> {
  readonly name = "api_batch";
  readonly label = "Execute Batch API Operations";
  readonly description =
    "Execute multiple vendor API operations sequentially and return aggregated results. Useful for workflows that require multiple API calls (e.g., list resources, then get details for each).";
  readonly parameters = batchSchema;

  #catalog: ApiCatalogService;
  #executor: ApiExecutor;

  constructor(catalog: ApiCatalogService, executor: ApiExecutor) {
    this.#catalog = catalog;
    this.#executor = executor;
  }

  async execute(
    _toolCallId: string,
    { service, operations, mode = "best-effort" }: Static<typeof batchSchema>,
    _signal?: AbortSignal,
  ): Promise<AgentToolResult> {
    const services = await this.#catalog.getServices();
    if (!services.some(s => s.service === service)) {
      const names = services.map(s => s.service).join(", ") || "none";
      return { content: [{ type: "text", text: `Service '${service}' not found. Available: ${names}` }] };
    }

    const catalog = await this.#catalog.getCatalog(service);
    if (!catalog) {
      return { content: [{ type: "text", text: `Failed to load catalog for '${service}'` }] };
    }

    const auth = this.#executor.resolveAuth(catalog.auth);
    const results: Array<{ operation: string; ok: boolean; data?: unknown; error?: string }> = [];

    for (const item of operations) {
      const op = await this.#catalog.getOperation(service, item.operation);
      if (!op) {
        const err = { operation: item.operation, ok: false, error: `Operation '${item.operation}' not found in service '${service}'` };
        results.push(err);
        if (mode === "strict") break;
        continue;
      }

      const userParams = (item.params as Record<string, unknown>) ?? {};
      const resolvedParams = this.#executor.resolveParams(op, userParams);
      const missing = (op.parameters ?? []).filter(p => p.required && resolvedParams[p.name] === undefined);
      if (missing.length > 0) {
        const err = { operation: item.operation, ok: false, error: `Missing required parameters: ${missing.map(p => p.name).join(", ")}` };
        results.push(err);
        if (mode === "strict") break;
        continue;
      }

      const result = await this.#executor.execute(auth, op, resolvedParams, item.body as Record<string, unknown> | undefined);
      results.push({ operation: item.operation, ok: result.ok, ...(result.ok ? { data: result.data } : { error: result.error }) });

      if (!result.ok && mode === "strict") break;

      // Small delay between operations to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    const lines = results.map(r =>
      r.ok
        ? `✓ **${r.operation}**: ${JSON.stringify(r.data).slice(0, 200)}`
        : `✗ **${r.operation}**: ${r.error}`,
    );

    const summary = `Batch complete: ${results.filter(r => r.ok).length}/${results.length} succeeded`;
    return { content: [{ type: "text", text: `${summary}\n\n${lines.join("\n")}` }] };
  }
}
```

- [ ] **Step 5.4: Export ApiBatchTool from api-tool.ts barrel**

The `ApiBatchTool` is already in `api-tool.ts` — verify `packages/coding-agent/src/tools/index.ts` exports it by checking line 75:

```typescript
export * from "./api-tool";
```

This wildcard export already covers `ApiBatchTool`. No change needed.

- [ ] **Step 5.5: Register api_batch in index.ts BUILTIN_TOOLS**

In `packages/coding-agent/src/tools/index.ts`, after the `api_call` entry in `BUILTIN_TOOLS`, add:

```typescript
api_batch: async s => {
  const installed = await getEnabledPlugins(s.cwd).catch(() => []);
  const catalog = new ApiCatalogService([
    path.join(os.homedir(), ".claude", "plugins"),
    path.join(os.homedir(), ".xcsh", "plugins", "cache", "plugins"),
    ...installed.map(p => p.path),
  ]);
  const executor = new ApiExecutor();
  return new ApiBatchTool(catalog, executor);
},
```

Also add the import at the top of index.ts:

```typescript
import { ApiCallTool, ApiDescribeTool, ApiDiscoverTool, ApiServicesTool, ApiBatchTool } from "./api-tool";
```

- [ ] **Step 5.6: Run all tool tests**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test packages/coding-agent/test/api-tool.test.ts 2>&1 | tail -10
```

Expected: all tests pass (existing + 4 new batch tests).

- [ ] **Step 5.7: Commit**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
git add packages/coding-agent/src/tools/api-tool.ts packages/coding-agent/src/tools/index.ts packages/coding-agent/test/api-tool.test.ts
git commit -m "feat(coding-agent): add api_batch tool and fix plugin discovery paths

api_batch executes multiple operations sequentially with aggregated
results and configurable error mode (best-effort | strict).
Adds marketplace plugin cache to catalog search paths."
```

---

## Task 6: Fix Plugin Discovery Paths for Remaining Tools

**Repo:** xcsh
**Files:**
- Modify: `packages/coding-agent/src/tools/index.ts`

The `api_services`, `api_discover`, `api_describe`, and `api_call` tool factories in `BUILTIN_TOOLS` only search `~/.claude/plugins`. They need to also search the marketplace plugin cache at `~/.xcsh/plugins/cache/plugins/`.

- [ ] **Step 6.1: Update all four tool factories**

In `packages/coding-agent/src/tools/index.ts`, update the four existing API tool entries to include the marketplace cache path. Replace:

```typescript
api_services: async s => {
  const installed = await getEnabledPlugins(s.cwd).catch(() => []);
  const catalog = new ApiCatalogService([
    path.join(os.homedir(), ".claude", "plugins"),
    ...installed.map(p => p.path),
  ]);
  return new ApiServicesTool(catalog);
},
api_discover: async s => {
  const installed = await getEnabledPlugins(s.cwd).catch(() => []);
  const catalog = new ApiCatalogService([
    path.join(os.homedir(), ".claude", "plugins"),
    ...installed.map(p => p.path),
  ]);
  return new ApiDiscoverTool(catalog);
},
api_describe: async s => {
  const installed = await getEnabledPlugins(s.cwd).catch(() => []);
  const catalog = new ApiCatalogService([
    path.join(os.homedir(), ".claude", "plugins"),
    ...installed.map(p => p.path),
  ]);
  return new ApiDescribeTool(catalog);
},
api_call: async s => {
  const installed = await getEnabledPlugins(s.cwd).catch(() => []);
  const catalog = new ApiCatalogService([
    path.join(os.homedir(), ".claude", "plugins"),
    ...installed.map(p => p.path),
  ]);
  const executor = new ApiExecutor();
  return new ApiCallTool(catalog, executor, s);
},
```

With:

```typescript
api_services: async s => {
  const installed = await getEnabledPlugins(s.cwd).catch(() => []);
  const catalog = new ApiCatalogService([
    path.join(os.homedir(), ".claude", "plugins"),
    path.join(os.homedir(), ".xcsh", "plugins", "cache", "plugins"),
    ...installed.map(p => p.path),
  ]);
  return new ApiServicesTool(catalog);
},
api_discover: async s => {
  const installed = await getEnabledPlugins(s.cwd).catch(() => []);
  const catalog = new ApiCatalogService([
    path.join(os.homedir(), ".claude", "plugins"),
    path.join(os.homedir(), ".xcsh", "plugins", "cache", "plugins"),
    ...installed.map(p => p.path),
  ]);
  return new ApiDiscoverTool(catalog);
},
api_describe: async s => {
  const installed = await getEnabledPlugins(s.cwd).catch(() => []);
  const catalog = new ApiCatalogService([
    path.join(os.homedir(), ".claude", "plugins"),
    path.join(os.homedir(), ".xcsh", "plugins", "cache", "plugins"),
    ...installed.map(p => p.path),
  ]);
  return new ApiDescribeTool(catalog);
},
api_call: async s => {
  const installed = await getEnabledPlugins(s.cwd).catch(() => []);
  const catalog = new ApiCatalogService([
    path.join(os.homedir(), ".claude", "plugins"),
    path.join(os.homedir(), ".xcsh", "plugins", "cache", "plugins"),
    ...installed.map(p => p.path),
  ]);
  const executor = new ApiExecutor();
  return new ApiCallTool(catalog, executor, s);
},
```

- [ ] **Step 6.2: Write a plugin path test**

Add to `packages/coding-agent/test/api-tool.test.ts`:

```typescript
describe("Plugin discovery path fix", () => {
  test("ApiCatalogService accepts marketplace cache path without error", async () => {
    const home = os.homedir();
    // Path doesn't need to exist — catalog service handles ENOENT gracefully
    const svc = new ApiCatalogService([
      path.join(home, ".claude", "plugins"),
      path.join(home, ".xcsh", "plugins", "cache", "plugins"),
    ]);
    // Should not throw even if directories don't exist
    const services = await svc.getServices();
    expect(Array.isArray(services)).toBe(true);
  });
});
```

- [ ] **Step 6.3: Run tests**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test packages/coding-agent/test/api-tool.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6.4: Run type check**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun run check:ts 2>&1 | tail -10
```

Expected: zero TypeScript errors.

- [ ] **Step 6.5: Commit**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
git add packages/coding-agent/src/tools/index.ts packages/coding-agent/test/api-tool.test.ts
git commit -m "fix(coding-agent): include marketplace plugin cache in catalog search paths

api_services/discover/describe/call/batch now scan
~/.xcsh/plugins/cache/plugins/ so marketplace-installed plugin
catalogs are discoverable."
```

---

## Task 7: sync-catalog.ts Integration Script

**Repo:** xcsh
**Files:**
- Create: `marketplace/plugins/f5xc-platform/scripts/sync-catalog.ts`

Downloads the latest `api-catalog.json` from the api-specs-enriched GitHub releases and places it at `marketplace/plugins/f5xc-platform/api-catalog.json`.

- [ ] **Step 7.1: Create the directory**

```bash
mkdir -p /workspace/xcsh/.worktrees/feature/function-calls/marketplace/plugins/f5xc-platform/scripts
```

- [ ] **Step 7.2: Create sync-catalog.ts**

```typescript
#!/usr/bin/env bun
// Downloads the latest F5XC API catalog from api-specs-enriched GitHub releases.
//
// Usage:
//   bun run marketplace/plugins/f5xc-platform/scripts/sync-catalog.ts
//
// Env vars (optional):
//   GITHUB_TOKEN — for authenticated requests (higher rate limit)
//   CATALOG_RELEASE_REPO — override repo (default: f5xc-salesdemos/api-specs-enriched)

import * as fs from "node:fs/promises";
import * as path from "node:path";

const REPO = process.env["CATALOG_RELEASE_REPO"] ?? "f5xc-salesdemos/api-specs-enriched";
const ASSET_NAME = "api-catalog.json";
const OUTPUT_PATH = path.join(import.meta.dir, "..", ASSET_NAME);

async function fetchJson(url: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const headers: Record<string, string> = { Accept: "application/octet-stream" };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Download error: ${res.status} ${res.statusText} — ${url}`);
  return res.arrayBuffer();
}

function validateCatalog(catalog: unknown): void {
  if (typeof catalog !== "object" || catalog === null) {
    throw new Error("Catalog is not an object");
  }
  const c = catalog as Record<string, unknown>;
  if (c["service"] !== "f5xc") throw new Error(`Expected service 'f5xc', got '${c["service"]}'`);
  if (c["auth"] === undefined) throw new Error("Catalog missing 'auth' field");
  if (!Array.isArray(c["categories"])) throw new Error("Catalog missing 'categories' array");
  const totalOps = (c["categories"] as Array<{ operations: unknown[] }>)
    .reduce((n, cat) => n + (cat.operations?.length ?? 0), 0);
  if (totalOps === 0) throw new Error("Catalog has 0 operations — this seems wrong");
  console.log(`Validated: ${totalOps} operations across ${(c["categories"] as unknown[]).length} categories`);
}

async function main(): Promise<void> {
  console.log(`Fetching latest release from ${REPO}...`);

  const latestUrl = `https://api.github.com/repos/${REPO}/releases/latest`;
  const release = (await fetchJson(latestUrl)) as { tag_name: string; assets: Array<{ name: string; url: string }> };

  console.log(`Found release: ${release.tag_name}`);

  const asset = release.assets.find(a => a.name === ASSET_NAME);
  if (!asset) {
    const names = release.assets.map(a => a.name).join(", ");
    throw new Error(`Asset '${ASSET_NAME}' not found in release. Available: ${names}`);
  }

  console.log(`Downloading ${ASSET_NAME}...`);
  const bytes = await fetchBytes(asset.url);
  const text = new TextDecoder().decode(bytes);

  let catalog: unknown;
  try {
    catalog = JSON.parse(text);
  } catch {
    throw new Error("Downloaded file is not valid JSON");
  }

  validateCatalog(catalog);

  await fs.writeFile(OUTPUT_PATH, text, "utf8");
  console.log(`Saved to ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error("sync-catalog failed:", err.message);
  process.exit(1);
});
```

- [ ] **Step 7.3: Verify the script parses cleanly**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun --check marketplace/plugins/f5xc-platform/scripts/sync-catalog.ts
```

Expected: no type errors.

- [ ] **Step 7.4: Run type check across the project**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun run check:ts 2>&1 | tail -10
```

Expected: zero errors.

- [ ] **Step 7.5: Verify the existing catalog passes validation**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
node -e "
const catalog = require('./marketplace/plugins/f5xc-platform/api-catalog.json');
if (catalog.service !== 'f5xc') throw new Error('wrong service');
if (!catalog.auth) throw new Error('missing auth');
if (!Array.isArray(catalog.categories)) throw new Error('missing categories');
const ops = catalog.categories.reduce((n,c) => n + c.operations.length, 0);
console.log('Validation passed:', ops, 'operations,', catalog.categories.length, 'categories');
"
```

Expected:
```
Validation passed: 17 operations, 6 categories
```

- [ ] **Step 7.6: Run full test suite for the API framework**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test packages/coding-agent/test/api-catalog.test.ts packages/coding-agent/test/api-executor.test.ts packages/coding-agent/test/api-tool.test.ts 2>&1 | tail -10
```

Expected: all tests pass, 0 failures.

- [ ] **Step 7.7: Commit**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
git add marketplace/plugins/f5xc-platform/scripts/sync-catalog.ts
git commit -m "feat(f5xc): add sync-catalog.ts to download generated catalog from GH releases

Downloads api-catalog.json from api-specs-enriched latest release,
validates schema, and places it in the f5xc-platform plugin directory.
Run with: bun run marketplace/plugins/f5xc-platform/scripts/sync-catalog.ts"
```

---

## Task 8: End-to-End Phase 2 Verification

- [ ] **Step 8.1: Run all API framework tests**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun test packages/coding-agent/test/api-catalog.test.ts \
         packages/coding-agent/test/api-executor.test.ts \
         packages/coding-agent/test/api-tool.test.ts 2>&1 | tail -10
```

Expected: all pass, 0 fail.

- [ ] **Step 8.2: Run type check**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
bun run check:ts 2>&1 | tail -5
```

Expected: `Exited with code 0`

- [ ] **Step 8.3: Run compiler against current spec**

```bash
cd /workspace/api-specs-enriched
python -m scripts.compile_catalog
node -e "
const c = require('./release/api-catalog.json');
const ops = c.categories.reduce((n,cat) => n + cat.operations.length, 0);
console.log('Service:', c.service);
console.log('Categories:', c.categories.length);
console.log('Total ops:', ops);
c.categories.forEach(cat => console.log(' -', cat.name + ':', cat.operations.length, 'ops'));
"
```

Expected: catalog compiles without errors, categories listed.

- [ ] **Step 8.4: Run all Python tests**

```bash
cd /workspace/api-specs-enriched
python -m pytest tests/test_discover_crud.py tests/test_compile_catalog.py -v 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 8.5: Tag Phase 2 completion**

```bash
cd /workspace/xcsh/.worktrees/feature/function-calls
git tag feature/function-calls-phase2
```
