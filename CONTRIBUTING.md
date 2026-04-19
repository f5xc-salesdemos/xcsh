# Contributing to xcsh

Guide for all contributors -- human developers and AI coding agents.
Fork: `@f5xc-salesdemos/xcsh` | Upstream: `can1357/oh-my-pi`

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Project Structure](#project-structure)
3. [Setup](#setup)
4. [Development Workflow](#development-workflow)
5. [Linting and Formatting](#linting-and-formatting)
6. [Testing](#testing)
7. [Commit Conventions](#commit-conventions)
8. [Pull Requests](#pull-requests)
9. [Architecture Overview](#architecture-overview)
10. [Extension Playbooks](#extension-playbooks)

---

## Prerequisites

| Tool  | Minimum Version | Verify                |
|-------|-----------------|-----------------------|
| bun   | 1.3.12          | `bun --version`       |
| git   | 2.x             | `git --version`       |
| gh    | 2.x             | `gh auth status`      |
| cargo | nightly         | `cargo --version`     |

> **Package manager: bun only.** This monorepo uses bun workspaces. Never use `npm`, `yarn`, or `pnpm` — they cannot resolve `workspace:` protocol references and will produce broken `node_modules` in worktrees.

---

## Project Structure

### Monorepo layout

```text
xcsh/
├── packages/
│   ├── coding-agent/    # Main CLI agent (TypeScript)
│   ├── ai/              # AI provider abstractions
│   ├── tui/             # Terminal UI primitives
│   ├── agent/           # Core agent runtime
│   ├── utils/           # Shared utilities
│   ├── natives/         # Native Bun bindings (Rust via napi)
│   ├── stats/           # Usage statistics
│   └── swarm-extension/ # Multi-agent swarm extension
├── crates/              # Rust crates (brush-*, pi-natives, tree-sitter-glimmer)
├── biome.json           # Biome v2 linter/formatter config
├── tsconfig.json        # Root TypeScript config
└── Cargo.toml           # Rust workspace root
```

### Source tree (`packages/coding-agent/src/`)

```text
src/
├── cli.ts, main.ts, index.ts, sdk.ts
├── cli/                 # CLI argument and command adapters
├── commands/            # Command handlers (launch, shell, ssh, ...)
├── modes/               # Interactive, print, RPC runtimes + UI controllers
├── session/             # AgentSession, persistence, storage, compaction
├── tools/               # Built-in tool implementations
├── task/                # Subagent orchestration and parallel execution
├── capability/          # Capability definitions and schemas
├── discovery/           # Provider discovery (native/editor/MCP/etc.)
├── extensibility/       # Extensions, hooks, custom tools, plugins, skills
├── mcp/                 # MCP transport/manager/tool bridge
├── lsp/                 # Language server client integration
├── internal-urls/       # Protocol router (agent://, docs://, rule://, ...)
├── exec/ ipy/ ssh/      # Execution backends (shell, python, ssh)
├── web/                 # Search providers + domain scrapers
├── patch/               # Edit/patch parser + diff utilities
└── config/ utils/ tui/  # Settings, helpers, low-level TUI primitives
```

---

## Setup

### 1. Create a GitHub issue

Every change starts with a GitHub issue. Map work type to commit prefix:

| Work Type     | Prefix     | Label           |
|---------------|------------|-----------------|
| New feature   | `feat`     | `enhancement`   |
| Bug fix       | `fix`      | `bug`           |
| Maintenance   | `chore`    | `chore`         |
| Refactor      | `refactor` | `refactor`      |
| Documentation | `docs`     | `documentation` |

```bash
gh issue create --title "<type>: <imperative description>" --label "<label>"
```

Note the returned issue number **N**.

### 2. Create a development worktree

Never commit directly to `main`. All work happens in worktrees under `.worktrees/`.

**Branch naming:** `<type>/issue-<N>-<short-description>` (lowercase, hyphen-separated, 3-5 words).

Run the following block after setting your branch variable. Every step is required and must succeed before proceeding to the next:

```bash
# Set your branch (from the issue created in step 1)
BRANCH="<type>/issue-<N>-<short-description>"

# Create worktree from latest origin/main
git fetch origin
git worktree add ".worktrees/${BRANCH}" -b "${BRANCH}" origin/main
cd ".worktrees/${BRANCH}"

# Install dependencies (MUST use bun — see Prerequisites)
# Runs the prepare script automatically: configures git hooks + generates docs index
bun install

# Capture test baseline (MUST include --max-concurrency to avoid OOM)
bun test --max-concurrency 2 2>&1 | tee .worktree-test-baseline.txt
```

**Expected result:** ~3500 tests pass, 0 failures. If any tests fail, they are pre-existing — record them and move on. Your work must never increase the failure count beyond this baseline.

**What each step does:**

| Step | Purpose |
|------|---------|
| `bun install` | Resolves `workspace:` package references, installs all deps, runs `prepare` script (git hooks + docs index generation) |
| `bun test --max-concurrency 2` | Runs TypeScript and Rust test suites with bounded concurrency; native Rust modules compile on-demand during the first test run (~2-3 min cold) |

> **OOM warning:** Never run `bun test` without `--max-concurrency`. The default concurrency (20) exhausts container RAM and CPU. Use `--max-concurrency 2` as the safe default. See [Resource-constrained environments](#resource-constrained-environments) for tuning.

#### Worktree troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot find module '@f5xc-salesdemos/pi-*'` | `npm install` was used instead of `bun install` | `rm -rf node_modules && bun install` |
| `Cannot find package 'linkedom'` | Stale `node_modules` from main repo | `rm -rf node_modules && bun install` |
| Tests OOM-killed (SIGKILL) | Concurrency too high | Halve `--max-concurrency` value |
| `check:rs` fails in worktree | Cargo resolves paths relative to repo root | Run `bun run check:rs` from `/workspace/xcsh` instead |
| Flaky test on first run, passes on retry | Native module cold-compile race | Ignore; baseline file captures the stable result |

---

## Development Workflow

### TDD: red-green-refactor

All feature and bug-fix work follows strict TDD:

```bash
# 1. Write a failing test
#    packages/<package>/test/<feature>.test.ts

# 2. Confirm it fails
bun test --cwd packages/<package> --filter <test-file>

# 3. Write minimum implementation to pass

# 4. Confirm it passes
bun test --cwd packages/<package> --filter <test-file>

# 5. Run full package tests
bun test --cwd packages/<package>

# 6. Lint + type-check (see "Linting and Formatting")
bun run check:ts

# 7. Compare against baseline (see "Testing")

# 8. Refactor, repeat from step 5
```

**Rules:**

- Never skip the red step -- if you cannot write a failing test first, you do not understand the requirement.
- One behaviour per cycle. Commit after each green.
- Minimum implementation only; extra code is untested code.

---

## Linting and Formatting

### Biome v2 configuration (`biome.json`)

| Setting          | Value      |
|------------------|------------|
| Indent style     | Tabs       |
| Indent width     | 3          |
| Line width       | 120        |
| Line ending      | LF         |
| Quotes           | Double     |
| Semicolons       | Always     |
| Trailing commas  | All        |
| Arrow parens     | asNeeded   |
| Bracket spacing  | true       |

### Pre-commit hook

A pre-commit hook runs automatically via `bunx lint-staged` (configured in `.githooks/pre-commit`, activated by `git config core.hooksPath .githooks` in the `prepare` script). It checks only staged files.

### Commands

| Command         | Effect                                        |
|-----------------|-----------------------------------------------|
| `bun run check` | Biome check + `tsgo` type-check (read-only)  |
| `bun run lint`  | Biome lint only (read-only)                   |
| `bun run fmt`   | Biome format (writes files)                   |
| `bun run fix`   | Biome check + auto-fix (writes files, unsafe) |

Each command has `:ts` and `:rs` variants (e.g., `bun run check:ts`, `bun run fmt:rs`).

> **Worktree note:** `bun run check:rs` fails inside a worktree because Cargo resolves paths relative to the repo root. Use `bun run check:ts` for TypeScript-only changes in a worktree. Run `check:rs` from `/workspace/xcsh` if needed.

### Rust

Only required when modifying files in `crates/`. Must run from the repository root:

```bash
cd /workspace/xcsh
bun run check:rs
```

---

## Testing

### Runner

Tests use Bun's built-in test runner (`bun test`). The full suite has ~3200 tests.

### Root scripts

| Command        | What it runs                                        |
|----------------|-----------------------------------------------------|
| `bun run test` | `bun run --parallel test:ts test:rs` (all tests)   |
| `bun run test:ts` | `bun run --workspaces --if-present test -- --only-failures` |
| `bun run test:rs` | Rust tests via `scripts/run-rs-task.ts`          |

### Targeted tests (preferred)

```bash
bun test --filter "profile"                           # keyword match
bun test test/f5xc-profile-service.test.ts            # specific file
bun test --cwd packages/coding-agent --filter <name>  # scoped to package
```

### Resource-constrained environments

Bun defaults to 20 concurrent tests, which can spike RAM past 10 GB and OOM-kill
the container (no swap is configured). Always limit concurrency:

```bash
# Recommended defaults by available RAM
bun test --max-concurrency 1    # <= 4 GB RAM (sequential, lowest resource usage)
bun test --max-concurrency 2    # 4-16 GB RAM (safe default)
bun test --max-concurrency 4    # > 16 GB RAM

# Low-memory mode: reduces GC pressure at the cost of throughput
bun --smol test --max-concurrency 2

# Sequential execution: lowest possible resource usage
bun --smol test --max-concurrency 1

# Bail on first failure to avoid wasting resources on a broken run
bun test --max-concurrency 2 --bail 1
```

**Rules for AI agents and CI:**

- Never run `bun test` without `--max-concurrency`. The default of 20 will crash
  containers with less than 16 GB RAM.
- Prefer targeted tests (`--filter` or `--cwd`) over full-suite runs.
- Use `--bail 1` during development to fail fast.
- Use `--smol` when running the full suite in memory-constrained environments.
- If a test run is killed (SIGKILL/OOM), reduce concurrency by half and retry.

### Comparing against baseline

```bash
bun test --max-concurrency 2 2>&1 | tee /tmp/current-test-results.txt

BASELINE_FAILS=$(grep -o '[0-9]* fail' .worktree-test-baseline.txt | grep -o '[0-9]*' || echo 0)
CURRENT_FAILS=$(grep -o '[0-9]* fail' /tmp/current-test-results.txt | grep -o '[0-9]*' || echo 0)

echo "Baseline: ${BASELINE_FAILS} failures"
echo "Current:  ${CURRENT_FAILS} failures"

if [ "${CURRENT_FAILS}" -gt "${BASELINE_FAILS}" ]; then
   echo "BLOCKER: Failure count increased. Fix before committing."
else
   echo "OK: No new failures introduced."
fi
```

### TDD validation loop (fast, for constrained environments)

```
1. tsgo -p tsconfig.json --noEmit          # Type check (~2s)
2. biome check . --no-errors-on-unmatched  # Lint + format (<1s)
3. bun test --filter "<area>"              # Targeted tests (~3-5s)
4. Full suite runs in CI after push        # ~90s
```

---

## Commit Conventions

The project uses [Conventional Commits](https://www.conventionalcommits.org/).

### Format

```
<type>(<scope>): <imperative description>

<body: explain WHY, not WHAT>

Closes #<N>
```

### Types

| Type       | When                                             |
|------------|--------------------------------------------------|
| `feat`     | New feature or user-visible functionality        |
| `fix`      | Bug fix                                          |
| `chore`    | Maintenance, dependency updates, CI              |
| `refactor` | Code restructuring, no behaviour change          |
| `style`    | Formatting, whitespace, lint fixes only          |
| `test`     | Adding or updating tests only                    |
| `docs`     | Documentation changes only                       |

### Scope

Use the short package directory name:

`ai` | `tui` | `coding-agent` | `agent` | `utils` | `natives` | `stats` | `swarm-extension`

Omit scope for root-level changes (CI, docs, config).

### Footer

Always include `Closes #N` to auto-close the linked issue. Use `Refs #N` if the commit relates to but does not close the issue.

### Examples

```
feat(ai): add F5 XC multi-profile token rotation

Support multiple F5 XC authentication profiles with automatic
token refresh. Profiles are stored in ~/.config/xcsh/profiles/
and selected via the --profile flag.

Closes #42
```

```
fix(tui): prevent null crash when theme file is missing

The theme loader assumed the config directory always existed.
Now it falls back to the built-in dark theme when the file
is not found.

Closes #17
```

### SOP

```bash
git add <specific-files>       # Never use git add -A
git commit -m "<type>(<scope>): <description>

<body>

Closes #<N>"
```

---

## Pull Requests

After all TDD cycles complete, tests pass, and linting is clean:

```bash
git push -u origin "$(git branch --show-current)"

gh pr create \
   --title "<type>(<scope>): <description>" \
   --body "## What

<Brief description>

## Why

<Motivation or link to issue>

Closes #<N>

## Testing

<How was this tested?>

---

- [x] \`bun run check\` passes
- [x] \`bun test\` -- no new failures vs baseline
- [ ] CHANGELOG updated (if user-facing)
- [x] Issue linked via \`Closes #N\`"
```

**Rules:**

- PR title follows conventional commit format.
- PR body must include What, Why, and Testing sections.
- Branch must target `main`.
- Do not check boxes for steps you did not complete.

### Worktree cleanup (after PR merge)

```bash
cd /workspace/xcsh
git worktree remove ".worktrees/<branch-name>"
git branch -d "<branch-name>"
git worktree prune
```

Use `git branch -D` only after confirming the PR was merged (`gh pr status`).

---

## Architecture Overview

### Boot sequence

```text
process argv
   |
   v
src/cli.ts (runCli)          -- normalize subcommand (default: launch)
   |
   v
src/commands/*                -- command handlers
   |
   v
src/main.ts (runRootCommand)  -- init theme/settings/models/session
   |
   v
createAgentSession(...)
   |
   +-- runInteractiveMode(...)   -> InteractiveMode (TUI event loop)
   +-- runPrintMode(...)         -> one-shot batch output
   +-- runRpcMode(...)           -> JSONL stdin/stdout server
```

**Layers:**

1. **Command router** (`cli.ts`) -- argv normalization, subcommand dispatch, Bun runtime guard.
2. **Orchestration** (`main.ts`) -- theme/settings/model init, session creation, mode dispatch.
3. **Mode runtime** (`modes/`) -- interactive TUI, print (text/json), RPC (JSONL protocol).
4. **SDK surface** (`index.ts`) -- barrel exports for programmatic consumers.

### Mode implementations

- **Interactive** (`interactive-mode.ts`) -- Long-lived TUI. Wires `AgentSession` to UI controllers. Manages plan mode, todos, keybindings, shutdown.
- **Print** (`print-mode.ts`) -- Single-shot. JSON mode streams NDJSON events; text mode prints final output. Exits 1 on error.
- **RPC** (`rpc-mode.ts`) -- JSONL protocol server. `{ "type": "ready" }` handshake, `RpcCommand` handling, `AgentEvent` streaming. `RpcClient` wraps for embedding.

### Session lifecycle

- **`AgentSession`** -- Runtime coordinator. Subscribes to agent events, fans out to UI/extensions, persists to `SessionManager`.
- **`SessionManager`** -- Append-only NDJSON with tree-linked entries, branching via leaf pointer. Version 3 with auto-migration.
- **`SessionStorage`** -- File/memory backend abstraction.
- **`HistoryStorage`** -- Prompt recall only (SQLite + FTS5), not conversation state.
- **`Settings`** -- Global + project + override config merge (`config.yml`). Debounced, file-locked persistence.

### Tool system

```text
tool call from agent
   |
   v
createTools(...) -> Tool instance    (tools/index.ts: BUILTIN_TOOLS + HIDDEN_TOOLS)
   |  execute()
   v
executor / implementation
   |  streaming chunks
   v
OutputSink + TailBuffer             (truncation accounting, artifact spill)
   |
   v
ToolResultBuilder + OutputMetaBuilder
   |
   v
wrapToolWithMetaNotice(...)          (appends human/meta notices)
```

- **Tool registry** (`tools/index.ts`) -- `BUILTIN_TOOLS` and `HIDDEN_TOOLS` maps. `createTools(session)` instantiates, gates by settings/feature toggles, wraps with meta notices.
- **Executors** (`exec/`, `ipy/`, `ssh/`) -- Own process/kernel lifecycle and raw output capture via `OutputSink`.
- **Tool adapters** (`tools/bash.ts`, `tools/python.ts`) -- Own schemas, argument normalization, UX updates, error policy. Convert executor results into agent tool responses.

### Capability discovery and extensibility

```text
discovery providers -> capability registry -> loadCapability(...)
                                                |
                           +--------------------+--------------------+
                           v                    v                    v
                    extensions loader      hooks loader        skills loader
                           |                    |                    |
                           +---- runtime registrations ----> AgentSession/modes
```

- **Discovery** (`discovery/index.ts`) -- Side-effect bootstrap importing all providers.
- **Capability registry** (`capability/index.ts`) -- Priority-sorted, first-win dedup, validation.
- **Extensions** (`extensibility/extensions/loader.ts`) -- Dynamic `import()`, factory pattern with `ConcreteExtensionAPI`.
- **Hooks** (`extensibility/hooks/loader.ts`) -- Dynamic `import()`, default-export factory with `HookAPI`.
- **Skills** (`extensibility/skills.ts`) -- Capability-driven, source gating, name filters, non-recursive custom dir scan.

### MCP and LSP

- **MCP** (`mcp/manager.ts`) -- Owns server connections, bridges tools into custom-tool system. Bounded startup with `DeferredMCPTool` cache fallback.
- **LSP** (`lsp/client.ts`) -- JSON-RPC client. Process spawn, handshake, file sync, timeout/abort, idle cleanup.

### Task system (subagent delegation)

```text
TaskTool.execute(...)
   |  validate agent/tasks
   v
discoverAgents + AgentOutputManager
   |
   v
mapWithConcurrencyLimit(...)
   |
   +-- runSubprocess(task A) -> child AgentSession (in-process)
   +-- runSubprocess(task B) -> child AgentSession
   |
   v
submit_result / fallback normalization -> aggregated results
```

Subagents run **in-process** (no `child_process` spawn). Filesystem isolation via `task.isolation.mode` (`none`/`worktree`/`fuse-overlay`/`fuse-projfs`). Merge via `patch` (git apply) or `branch` (cherry-pick). Plan mode restricts children to read-only tools.

### Web I/O

- **Fetch** (`tools/fetch.ts`) -- URL retrieval, site-specific scrapers, HTML-to-markdown (Jina > trafilatura > lynx > native).
- **Browser** (`tools/browser.ts`) -- Stateful Puppeteer: navigate, observe, interact, extract, screenshot.
- **Web search** (`web/search/`) -- Provider chain: `perplexity > brave > jina > kimi > anthropic > gemini > codex > zai > exa > tavily > kagi > synthetic`.

---

## Extension Playbooks

### Add a built-in tool

Primary file: `packages/coding-agent/src/tools/index.ts`.

1. Import tool class and types.
2. Export from this module (barrel pattern).
3. Register factory in `BUILTIN_TOOLS` (or `HIDDEN_TOOLS` for system-only).
4. Wire feature gates in `isToolAllowed(name)` if needed.

Existing hidden tools: `submit_result`, `report_finding`, `exit_plan_mode`, `resolve`.

### Add an RPC command

Primary file: `packages/coding-agent/src/modes/rpc/rpc-types.ts`.

1. Add command shape to `RpcCommand` union with unique `type` literal.
2. Add success response variant to `RpcResponse`.
3. Update `RpcSessionState` if the command changes exposed state.
4. `RpcCommandType` is derived automatically.

### Add a hook event

Primary file: `packages/coding-agent/src/extensibility/hooks/types.ts`.

1. Define event interface with literal `type` field.
2. Add to `HookEvent` union.
3. Add overload to `HookAPI.on(...)`.
4. Add `...Result` interface if handlers can influence execution.
5. Choose context: `HookContext` for events, `HookCommandContext` for slash commands.

Event groups: session lifecycle, agent/turn lifecycle, automation, tool hooks.

## Evidence Standards

All claims about code state must be backed by terminal output:

| Claim               | Required Evidence                                         |
|---------------------|-----------------------------------------------------------|
| "This bug exists"   | Failing test output showing the bug                       |
| "This bug is fixed" | Previously failing test now passes                        |
| "Tests pass"        | `bun test` output at or below baseline failure count      |
| "Linting is clean"  | `bun run check` output showing zero errors                |
| "PR is ready"       | All of the above + PR checklist completed                 |

No assertions without output. No skipping steps. No ignoring new failures.

## Quick Reference

```bash
# --- Setup ---
gh issue create --title "<type>: <desc>" --label "<label>"
BRANCH="<type>/issue-<N>-<desc>"
git fetch origin
git worktree add ".worktrees/${BRANCH}" -b "${BRANCH}" origin/main
cd ".worktrees/${BRANCH}"
bun install
bun test --max-concurrency 2 2>&1 | tee .worktree-test-baseline.txt

# --- TDD Cycle ---
bun test --cwd packages/<pkg> --filter <test>    # red
# ... implement ...
bun test --cwd packages/<pkg> --filter <test>    # green
bun run check:ts                                  # lint + types

# --- Commit ---
bun run fmt && bun run check:ts
git add <files> && git commit -m "<type>(<scope>): <msg>

Closes #<N>"

# --- PR ---
git push -u origin "$(git branch --show-current)"
gh pr create --title "<type>(<scope>): <msg>" --body "..."

# --- Cleanup ---
cd /workspace/xcsh
git worktree remove ".worktrees/${BRANCH}" && git branch -d "${BRANCH}"
```
