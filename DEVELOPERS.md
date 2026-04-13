# xcsh Developer Guide

Standard operating procedures for contributing to the xcsh monorepo. This guide applies to all contributors — human developers and AI coding agents alike. Every procedure below includes exact commands that can be followed mechanically without ambiguity.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [GitHub Issue Creation](#1-github-issue-creation)
3. [Branch and Worktree Creation](#2-branch-and-worktree-creation)
4. [Test Baseline Capture](#3-test-baseline-capture)
5. [TDD Workflow](#4-tdd-workflow)
6. [Linting and Formatting](#5-linting-and-formatting)
7. [Committing](#6-committing)
8. [Pull Request Creation](#7-pull-request-creation)
9. [Worktree Cleanup](#8-worktree-cleanup)
10. [Evidence Standards](#9-evidence-standards)

---

## Prerequisites

Before starting any work, ensure these tools are installed and authenticated:

| Tool | Minimum Version | Verify With |
|------|----------------|-------------|
| bun | 1.3.12 | `bun --version` |
| git | 2.x | `git --version` |
| gh | 2.x | `gh --version` |
| cargo | nightly | `cargo --version` |

Authentication must be valid:

```bash
gh auth status
```

If `gh auth status` fails, run `gh auth login` before proceeding.

---

## 1. GitHub Issue Creation

**Every change starts with a GitHub issue. No exceptions.** Create the issue before writing any code.

Map your work type to the correct issue template:

| Work Type | Commit Prefix | Issue Template | Label |
|-----------|--------------|----------------|-------|
| New feature | `feat` | `feature_request` | `enhancement` |
| Bug fix | `fix` | `bug_report` | `bug` |
| Maintenance | `chore` | _(plain issue)_ | `chore` |
| Refactor | `refactor` | _(plain issue)_ | `refactor` |
| Documentation | `docs` | _(plain issue)_ | `documentation` |

### SOP

```bash
# For a feature:
gh issue create --title "feat: <imperative description>" --label "enhancement"

# For a bug fix:
gh issue create --title "fix: <imperative description>" --label "bug"

# For maintenance:
gh issue create --title "chore: <imperative description>" --label "chore"
```

Note the returned issue number `N`. You will use it in every subsequent step.

---

## 2. Branch and Worktree Creation

**Never commit directly to `main`.** All work happens on a feature branch inside a git worktree.

### Branch Naming Convention

```
<type>/issue-<N>-<short-description>
```

- `type` must match the conventional commit type (`feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `style`)
- `N` is the GitHub issue number
- `short-description` is lowercase, hyphen-separated, 3-5 words max

Examples:
- `feat/issue-42-add-oauth-provider`
- `fix/issue-17-null-crash-on-startup`
- `chore/issue-88-bump-dependencies`

### SOP

Run these commands in exact order from the repository root:

```bash
# 1. Fetch latest from remote
git fetch origin

# 2. Create worktree with a new branch based on origin/main
BRANCH="<type>/issue-<N>-<short-description>"
git worktree add ".worktrees/${BRANCH}" -b "${BRANCH}" origin/main

# 3. Enter the worktree
cd ".worktrees/${BRANCH}"

# 4. Install all workspace dependencies
bun install

# 5. Link the coding-agent package (required — symlinks local workspace deps)
bun --cwd=packages/coding-agent link

# 6. Link the ai package (required — symlinks local workspace deps)
bun --cwd=packages/ai link

# 7. Build all workspace packages including native modules
bun run build:ws
```

**Why the link steps?** The monorepo uses Bun's `workspace:` protocol. `bun install` installs external dependencies but the `coding-agent` and `ai` packages require explicit linking to resolve internal workspace references correctly. Skipping these steps causes missing module errors at runtime and during tests.

**Why build:ws?** Native Rust modules (in `crates/`) must be compiled before tests can load them. Without this step, tests that depend on native bindings will fail with module-not-found errors that look like test failures but are actually build failures.

---

## 3. Test Baseline Capture

**Run immediately after worktree setup, before writing any code.** This captures the state of the test suite at the point you branched.

### SOP

```bash
# From inside the worktree directory:
bun test 2>&1 | tee .worktree-test-baseline.txt
```

This file is gitignored and local to your worktree.

### Reading the Baseline

After capture, record these numbers:

```bash
# Extract pass/fail summary (last lines of bun test output)
tail -5 .worktree-test-baseline.txt
```

Example output:
```
1234 pass
231 fail
12 skip
```

### The Baseline Rule

> **The number of failing tests must never increase beyond the baseline.**

- New test failures introduced by your work are a **blocker** — you must fix them before committing.
- Pre-existing failures (e.g., missing native ARM64 modules) are recorded in the baseline and are not attributed to your work.
- If the baseline shows failures from missing native modules: re-run `bun run build:ws` and capture the baseline again.
- Ideally, your work should _reduce_ the failure count, never increase it.

### Comparing Against Baseline

After any test run during development, compare:

```bash
# Run tests and capture current state
bun test 2>&1 | tee /tmp/current-test-results.txt

# Compare fail counts
BASELINE_FAILS=$(grep -oP '\d+(?= fail)' .worktree-test-baseline.txt || echo 0)
CURRENT_FAILS=$(grep -oP '\d+(?= fail)' /tmp/current-test-results.txt || echo 0)

echo "Baseline: ${BASELINE_FAILS} failures"
echo "Current:  ${CURRENT_FAILS} failures"

if [ "${CURRENT_FAILS}" -gt "${BASELINE_FAILS}" ]; then
  echo "BLOCKER: Failure count increased. Fix before committing."
else
  echo "OK: No new failures introduced."
fi
```

---

## 4. TDD Workflow

All feature and bug-fix work follows strict red-green-refactor test-driven development.

### SOP

```bash
# Step 1: Write a failing test for the new behaviour
# Create or edit: packages/<package>/test/<feature>.test.ts

# Step 2: Confirm the test fails
bun test --filter <test-file-name>
# Expected: at least one FAIL for your new test

# Step 3: Write the minimum implementation to make the test pass
# Edit: packages/<package>/src/<module>.ts

# Step 4: Confirm the test passes
bun test --filter <test-file-name>
# Expected: PASS for your new test

# Step 5: Run the full test suite for the affected package
cd packages/<package>
bun test
cd -

# Step 6: Run the full project check from the repo root
bun run check

# Step 7: Compare failure count against baseline
# (use the comparison script from Section 3)

# Step 8: Refactor if needed, then repeat from Step 5
```

### Rules

- **Never skip the red step.** If you cannot write a failing test first, you do not yet understand the requirement well enough to implement it.
- **Minimum implementation.** Do not write more code than the test requires. Extra code is untested code.
- **One behaviour per cycle.** Each red-green-refactor cycle should cover exactly one unit of behaviour.
- **Commit after each green.** Small, frequent commits are better than large, infrequent ones.

---

## 5. Linting and Formatting

There are no pre-commit hooks (`husky` is not installed). **You must run linting manually before every commit.**

### SOP — TypeScript / JavaScript

```bash
# Auto-format all files with Biome
bun run fmt

# Lint and type-check (must pass with zero errors)
bun run check
```

### SOP — Rust

Only required if your changes touch files in `crates/`:

```bash
# Format check + clippy lints
bun run check:rs
```

### Auto-Fix

If `bun run check` reports fixable lint errors:

```bash
bun run fix
```

This runs `biome check --write --unsafe` and resolves most formatting and lint issues automatically. Re-run `bun run check` afterward to confirm zero remaining errors.

### Biome Configuration Reference

The project uses Biome v2 with these settings (defined in `/biome.json`):

| Setting | Value |
|---------|-------|
| Indent style | Tabs |
| Indent width | 3 |
| Line width | 120 |
| Line ending | LF |
| Quotes | Double |
| Semicolons | Always |
| Trailing commas | All |
| Arrow parentheses | Omit when possible |

---

## 6. Committing

The project uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must follow this format.

### Format

```
<type>(<scope>): <imperative description>

<body: explain WHY the change was made, not WHAT changed>

Closes #<issue-number>
```

### Types

| Type | When to Use |
|------|-------------|
| `feat` | New feature or user-visible functionality |
| `fix` | Bug fix |
| `chore` | Maintenance, dependency updates, CI changes |
| `refactor` | Code restructuring with no behaviour change |
| `style` | Formatting, whitespace, lint fixes (no logic change) |
| `test` | Adding or updating tests only |
| `docs` | Documentation changes only |

### Scope

The scope is the package name being modified. Use the short name from the `packages/` directory:

| Scope | Package |
|-------|---------|
| `ai` | `packages/ai` |
| `tui` | `packages/tui` |
| `coding-agent` | `packages/coding-agent` |
| `agent` | `packages/agent` |
| `utils` | `packages/utils` |
| `natives` | `packages/natives` |
| `stats` | `packages/stats` |
| `swarm-extension` | `packages/swarm-extension` |

Omit scope for root-level changes (CI, docs, config).

### Footer

Always include `Closes #N` in the footer to auto-close the linked GitHub issue when the PR is merged. If the commit relates to but does not close the issue, use `Refs #N` instead.

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
# 1. Stage only the files you intend to commit (never use git add -A)
git add <specific-files>

# 2. Commit with conventional message
git commit -m "<type>(<scope>): <description>

<body>

Closes #<N>"
```

---

## 7. Pull Request Creation

After all TDD cycles are complete, tests pass, linting is clean, and commits are made.

### SOP

```bash
# 1. Push your branch to the remote
git push -u origin "$(git branch --show-current)"

# 2. Create the pull request
gh pr create \
  --title "<type>(<scope>): <description>" \
  --body "## What

<Brief description of the change>

## Why

<Motivation, context, or link to issue>

Closes #<N>

## Testing

<How was this tested? Include test output or steps to reproduce>

---

- [x] \`bun run check\` passes
- [x] \`bun test\` passes with no new failures vs baseline
- [ ] CHANGELOG updated (if user-facing)
- [x] Issue linked via \`Closes #N\`"
```

### Rules

- The PR title must follow the same conventional commit format as commit messages
- The PR body must include the `What`, `Why`, and `Testing` sections (matching the project's PR template)
- The `Closes #N` in the body links the PR to the issue
- The checklist must be filled out honestly — do not check boxes for steps you did not complete
- The branch must target `main`

---

## 8. Worktree Cleanup

After the PR is merged, clean up the worktree and branch.

### SOP

```bash
# 1. Return to the repository root
cd /workspace/xcsh

# 2. Remove the worktree directory
git worktree remove ".worktrees/<branch-name>"

# 3. Delete the local branch
git branch -d "<branch-name>"

# 4. Prune any stale worktree references
git worktree prune
```

If `git branch -d` refuses because the branch is not fully merged, verify the PR was actually merged on GitHub first:

```bash
gh pr status
```

Only use `git branch -D` (force delete) if you have confirmed the PR was merged or intentionally abandoned.

---

## 9. Evidence Standards

All claims about the state of the code must be backed by evidence. This applies to both human developers and AI agents.

| Claim | Required Evidence |
|-------|-------------------|
| "This bug exists" | Captured failing test output showing the bug |
| "This bug is fixed" | Captured test output showing the previously failing test now passes |
| "Tests pass" | Full `bun test` output with pass/fail counts at or below baseline |
| "Linting is clean" | Full `bun run check` output showing zero errors |
| "PR is ready" | All of the above, plus PR checklist boxes checked |

### Rules

- **No assertions without output.** "I ran the tests and they pass" is not evidence. The terminal output is evidence.
- **No skipping.** Every step in this guide exists because skipping it has caused problems. Follow the full procedure.
- **No ignoring failures.** A pre-existing failure is tracked via the baseline. A new failure is a blocker. There is no third category.

---

## Quick Reference Card

For fast lookup during development:

```bash
# === Setup ===
gh issue create --title "<type>: <description>" --label "<label>"
BRANCH="<type>/issue-<N>-<description>"
git worktree add ".worktrees/${BRANCH}" -b "${BRANCH}" origin/main
cd ".worktrees/${BRANCH}"
bun install && bun --cwd=packages/coding-agent link && bun --cwd=packages/ai link && bun run build:ws
bun test 2>&1 | tee .worktree-test-baseline.txt

# === TDD Cycle ===
bun test --filter <test>    # red
# ... implement ...
bun test --filter <test>    # green
bun run check               # lint + types

# === Commit ===
bun run fmt && bun run check
git add <files> && git commit -m "<type>(<scope>): <msg>

Closes #<N>"

# === PR ===
git push -u origin "$(git branch --show-current)"
gh pr create --title "<type>(<scope>): <msg>" --body "..."

# === Cleanup ===
cd /workspace/xcsh
git worktree remove ".worktrees/${BRANCH}" && git branch -d "${BRANCH}"
```
