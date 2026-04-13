# Design: DEVELOPERS.md — xcsh Developer Standard Operating Procedures

**Date:** 2026-04-13
**Status:** Approved
**Author:** Robin Mordasiewicz (via Claude Code brainstorming session)

---

## Problem Statement

The xcsh monorepo lacks a single authoritative document that prescribes:
- How to correctly initialise a git worktree (non-trivial: requires 3 install steps, not just `bun install`)
- How to capture a reproducible test baseline that accounts for pre-existing native module failures
- What the exact TDD workflow is for this project
- How to name GitHub issues, branches, commits, and PRs consistently
- What linting steps must be run before every commit (no husky enforces them automatically)

The absence of this document means these conventions exist only as tribal knowledge, vary between contributors, and are not reliably followed by AI coding agents.

---

## Goals

1. **Authoritative SOP** — one file, always current, at the project root
2. **Dual-purpose** — readable by humans and executable by AI agents (Claude Code, Copilot, etc.)
3. **Tool-agnostic** — no `.claude/` specific instructions; works for any developer or AI tool
4. **Automated** — prescribes exact ordered command sequences, not vague guidance
5. **Evidence-based** — mandates proof of correctness (test output, lint output) before claiming work done

---

## Non-Goals

- Does not replace architecture docs in `docs/`
- Does not add new scripts (orchestrates existing `package.json` scripts only)
- Does not enforce husky or commitlint (documents the manual steps instead)
- Does not create per-package SOPs (single document covers all packages)

---

## Document Structure

### Section 1: Overview
Brief prose explaining purpose, audience, and that it applies to all contributors and AI agents equally.

### Section 2: Prerequisites
Required tools (`bun` 1.3.12+, `git`, `gh` CLI, `cargo` Rust nightly) and required auth state (`gh auth login`).

### Section 3: SOP — GitHub Issue Creation
- Must happen before any code changes
- Maps work type to GitHub issue template: feat→feature_request, fix→bug_report, chore→plain issue
- Exact `gh issue create` command
- Issue title must mirror the conventional commit type

### Section 4: SOP — Branch and Worktree Creation
- Branch naming convention: `type/issue-N-short-description`
  - Examples: `feat/issue-42-add-oauth`, `fix/issue-17-null-crash`
  - Never commit to `main`
- Exact ordered worktree creation sequence:
  1. `git fetch origin`
  2. `git worktree add .worktrees/<branch> -b <branch>`
  3. `cd .worktrees/<branch>`
  4. `bun install`
  5. `bun --cwd=packages/coding-agent link`
  6. `bun --cwd=packages/ai link`
  7. `bun run build:ws`

### Section 5: SOP — Test Baseline Capture
- Run immediately after worktree setup, before writing any code
- Command: `bun test 2>&1 | tee .worktree-test-baseline.txt`
- File is gitignored (local to worktree only)
- Rule: failing test count must never increase beyond baseline
- Native module failures (missing ARM64 binaries, etc.) are recorded and not attributed to new work, but must still be tracked
- If baseline shows failures from missing native modules: run `bun run build:ws` and re-capture before declaring the baseline

### Section 6: SOP — TDD Workflow
Red-green-refactor cycle:
1. Write failing test
2. Confirm failure: `bun test --filter <test-file>`
3. Write minimum implementation
4. Confirm pass: `bun test --filter <test-file>`
5. Run full package: `bun test` in affected package
6. Run root check: `bun run check` from repo root
7. Compare failure count to baseline — must not increase
8. Refactor; repeat from step 6

### Section 7: SOP — Linting and Formatting
Run before every commit (no hooks enforce this automatically):
- `bun run fmt` — auto-format with Biome
- `bun run check` — Biome lint + TypeScript type check

For Rust changes additionally:
- `bun run check:rs` — `cargo fmt --check && cargo clippy`

### Section 8: SOP — Committing
Conventional commit format:
```
<type>(<scope>): <imperative description>

<body: explain why, not what>

Closes #<issue-number>
```
- Types: `feat`, `fix`, `chore`, `refactor`, `style`, `test`, `docs`
- Scope: package name (`ai`, `tui`, `coding-agent`, etc.)
- Footer always includes `Closes #N` to auto-close the linked issue

### Section 9: SOP — Pull Request Creation
```
gh pr create --title "<type>(<scope>): <description> (#N)" --body "..."
```
PR body follows project template (What / Why / Testing) plus checklist:
- [ ] `bun check` passes
- [ ] `bun test` passes with no new failures vs baseline
- [ ] CHANGELOG updated (if user-facing)
- [ ] Issue linked via `Closes #N`

Branch must not be `main`. PR targets `main`.

### Section 10: SOP — Worktree Cleanup
After PR is merged:
```
cd /workspace/xcsh
git worktree remove .worktrees/<branch>
git branch -d <branch>
```

### Section 11: Evidence Standards
- Bug claims require: captured failing test output
- Fix claims require: captured passing test output showing previously failing test now passes
- PR-ready claims require: clean `bun run check` output + test count at or below baseline

---

## Key Decisions

| Decision | Choice | Reason |
|---|---|---|
| File location | `/DEVELOPERS.md` (root) | Auto-discovered by AI agents; consistent with STAGES.md, AGENTS.md |
| Audience | Dual-purpose (human + AI) | Project is open-source; other tools besides Claude Code used |
| Setup approach | Orchestrate existing scripts | No new scripts; documents what already exists in package.json |
| Test baseline | Snapshot & freeze count | 231 pre-existing ARM64 failures must not block work but must not grow |
| Branch naming | `type/issue-N-description` | Matches conventional commit types; issue number always traceable |
| Commit format | Conventional commits (existing) | Already in use; codifying what's already practiced |
| Husky | Document manual steps | Not installed; adding it is out of scope for this document |

---

## Acceptance Criteria

- [ ] `/DEVELOPERS.md` exists at project root
- [ ] All 10 SOP sections are present with exact command sequences
- [ ] Document is readable by a human developer who has never seen the repo
- [ ] Document can be read by an AI agent and followed mechanically without ambiguity
- [ ] No references to `.claude/` or Claude-specific tooling
- [ ] Committed to `main` with `docs: add DEVELOPERS.md developer SOP`
