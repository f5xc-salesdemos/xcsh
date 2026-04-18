# Handoff: feature/function-calls

**Date:** 2026-04-18
**Branch:** `feature/function-calls`
**PR:** [#102](https://github.com/f5xc-salesdemos/xcsh/pull/102) (OPEN)
**Closes:** Issue #101
**Base:** `main-work` (rebased and current as of 2026-04-18)

---

## What This Branch Does

Adds an API function calls framework to the coding-agent, enabling the LLM to make deterministic F5 XC API calls from vendor-supplied operation catalogs. This is a major feature spanning 38 commits across 3 development phases.

### Five New Tools

| Tool | Purpose |
|------|---------|
| `api_services` | List loaded API services and their operation counts |
| `api_discover` | Search operations by keyword/category with scored fuzzy matching |
| `api_describe` | Get full operation schema (params, body, response) for a specific operation |
| `api_call` | Execute a single API operation with auth resolution and parameter validation |
| `api_batch` | Execute multiple API calls with abort signal and strict error mode |

### Two New Services

| File | Purpose |
|------|---------|
| `packages/coding-agent/src/services/api-catalog.ts` | Catalog loading from plugin directories, indexed lookups, scored fuzzy search, collision handling |
| `packages/coding-agent/src/services/api-executor.ts` | Auth resolution (api_token/bearer/basic/custom), required param validation, LRU response cache, resolve confirmation for dangerous ops |

### Type Definitions

- `packages/coding-agent/src/services/api-types.ts` — `ApiCatalog`, `ApiOperation`, `ApiService`, `AuthConfig`, `ResponseSchema`

### Plugin Catalog

- `marketplace/plugins/f5xc-platform/api-catalog.json` — Full compiled F5 XC catalog (127K lines, ~17 namespace operations across 6 categories)
- `marketplace/plugins/f5xc-platform/scripts/sync-catalog.ts` — Script to re-download catalog from GitHub releases

### Tool Registration

- `packages/coding-agent/src/tools/index.ts` — Modified to register `api_services`, `api_discover`, `api_describe`, `api_call` in `BUILTIN_TOOLS` and `api_batch` in `HIDDEN_TOOLS`
- `packages/coding-agent/src/tools/api-tool.ts` — All five tool classes with schemas, argument normalization, and result formatting

---

## Current State

### Test Results (2026-04-18)

```
95 pass, 0 fail, 157 expect() calls across 3 files [1.72s]
```

Test files:
- `packages/coding-agent/test/api-catalog.test.ts` — Catalog loading, indexing, fuzzy search, collision handling, rescan
- `packages/coding-agent/test/api-executor.test.ts` — Auth resolution, cache TTL/LRU, POST bypass, parameter validation
- `packages/coding-agent/test/api-tool.test.ts` — Tool schemas, discover/describe/call/batch integration, resolve gating, batch abort/strict

### Type Check / Lint

Clean as of last check. Run `bun run check:ts` to verify.

### CI

PR #102 CI has not been re-run after the rebase. A force-push is needed to update the remote branch and trigger CI.

---

## Development Phases Completed

### Phase 1: Core Framework (commits 1-17)
- Type definitions, catalog service, executor, tool registration
- TDD throughout: tests written before implementation
- Bug fixes for barrel exports, fetch mocks, test isolation

### Phase 2: Performance and Scale (commits 18-26)
- LRU response cache on executor
- Indexed lookups in catalog service
- Full compiled catalog replacing hand-crafted 17-op version
- Plugin directory scanning for catalog discovery

### Phase 3: Fuzzy Search and Validation (commits 27-38)
- Scored fuzzy search replacing keyword-index
- Response schema validation (advisory)
- Catalog deduplication and path normalization
- Capped discover results, batch auth error handling

---

## Design Documents

All in `docs/superpowers/` on this branch:

| Document | Path |
|----------|------|
| Phase 1 Design Spec | `specs/2026-04-16-api-function-calls-design.md` |
| Phase 1 Implementation Plan | `plans/2026-04-16-api-function-calls.md` |
| Phase 2 Design Spec | `specs/2026-04-16-api-function-calls-phase2-design.md` |
| Phase 2 Implementation Plan | `plans/2026-04-16-api-function-calls-phase2.md` |
| Phase 3 Design Spec | `specs/2026-04-16-api-function-calls-phase3-design.md` |
| Phase 3 Implementation Plan | `plans/2026-04-16-api-function-calls-phase3.md` |
| TDD Gap-Fill Spec | `specs/2026-04-16-api-framework-tdd-completeness-design.md` |
| TDD Gap-Fill Plan | `plans/2026-04-16-api-framework-tdd-completeness.md` |

---

## Resume Instructions

On a fresh container, run these commands to restore the working state:

```bash
cd /workspace/xcsh

# Fetch the branch from origin
git fetch origin feature/function-calls

# Create a worktree for the branch
git worktree add .worktrees/feature/function-calls feature/function-calls
cd .worktrees/feature/function-calls

# Install dependencies
bun install

# Verify tests still pass
bun test --cwd packages/coding-agent --filter "api-" --max-concurrency 2

# Verify types
bun run check:ts
```

---

## What Remains To Do

1. **Force-push the rebased branch** to update PR #102 on GitHub:
   ```bash
   cd /workspace/xcsh/.worktrees/feature/function-calls
   git push --force-with-lease origin feature/function-calls
   ```

2. **Wait for CI** to pass on the updated PR.

3. **Manual testing** — The PR checklist has two unchecked items:
   - [ ] CI checks pass
   - [ ] Manual verification of API tool discovery and execution

4. **Merge PR #102** once CI is green and manual testing is confirmed.

---

## Key Files Quick Reference

```
packages/coding-agent/src/services/api-types.ts      # Type definitions
packages/coding-agent/src/services/api-catalog.ts     # Catalog service
packages/coding-agent/src/services/api-executor.ts    # Executor with auth/cache
packages/coding-agent/src/tools/api-tool.ts           # 5 tool classes
packages/coding-agent/src/tools/index.ts              # Tool registration (modified)
packages/coding-agent/test/api-catalog.test.ts        # Catalog tests
packages/coding-agent/test/api-executor.test.ts       # Executor tests
packages/coding-agent/test/api-tool.test.ts           # Tool integration tests
marketplace/plugins/f5xc-platform/api-catalog.json    # F5 XC operation catalog
marketplace/plugins/f5xc-platform/scripts/sync-catalog.ts  # Catalog sync script
```
