#!/usr/bin/env bash
#
# collapse-history.sh — Collapse fork commits into domain-grouped squash commits
# for a clean rebase onto upstream.
#
# Usage:
#   ./scripts/collapse-history.sh analyze   — classify files and report
#   ./scripts/collapse-history.sh build     — create rebase-ready branch
#   ./scripts/collapse-history.sh preview   — dry-run rebase to predict conflicts
#   ./scripts/collapse-history.sh all       — run analyze + build + preview
#
set -eo pipefail

UPSTREAM_URL="https://github.com/can1357/oh-my-pi.git"
UPSTREAM_REMOTE="upstream"
UPSTREAM_BRANCH="main"
REBASE_BRANCH="rebase-ready"
ORIGINAL_HEAD=""
MERGE_BASE=""
WORK_DIR=""

# ─── Colors ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { printf "${BLUE}[info]${RESET}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${RESET}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[warn]${RESET}  %s\n" "$*"; }
err()   { printf "${RED}[error]${RESET} %s\n" "$*" >&2; }
header(){ printf "\n${BOLD}${CYAN}═══ %s ═══${RESET}\n\n" "$*"; }

# ─── Group definitions ────────────────────────────────────────────────────────

# Groups in commit order (index = priority)
# Each group has: name, label, commit message
NUM_GROUPS=6

group_name()    { echo "${GROUP_NAMES[$1]}"; }
group_label()   { echo "${GROUP_LABELS[$1]}"; }
group_message() { echo "${GROUP_MESSAGES[$1]}"; }
group_file()    { echo "${WORK_DIR}/group-$(group_name "$1").txt"; }

GROUP_NAMES=(
  "build-ci"
  "core"
  "ai-providers"
  "auth-profiles"
  "ui-theme"
  "docs"
)

GROUP_LABELS=(
  "Build & CI (codesigning, release, Actions)"
  "Core & Rebrand (scope rename, session, native, tests)"
  "AI Providers (LiteLLM, Ollama, OpenAI)"
  "Auth & Profiles (F5 XC auth, secrets)"
  "UI: Status Line & Theme (powerline, gutter, welcome)"
  "Docs (DEVELOPERS.md, CONTRIBUTING.md, specs)"
)

GROUP_MESSAGES=(
  "feat(collapse): build-ci — Apple codesigning, release pipeline, CI fixes"
  "feat(collapse): core — rebrand to xcsh, session fixes, system prompt, native addons"
  "feat(collapse): ai-providers — LiteLLM proxy, Ollama migration, OpenAI image provider"
  "feat(collapse): auth-profiles — F5 XC multi-profile auth, secret masking, profile env"
  "feat(collapse): ui-theme — powerline status bar, xcsh themes, gutter system, welcome screen"
  "feat(collapse): docs — DEVELOPERS.md, CONTRIBUTING.md, design specs, porting guide"
)

# ─── File classification ─────────────────────────────────────────────────────

classify_file() {
  local file="$1"

  # Docs group
  case "$file" in
    DEVELOPERS.md|CONTRIBUTING.md|AGENTS.md|STAGES.md) echo "docs"; return ;;
    AUTHENTICATION-*)            echo "docs"; return ;;
    docs/*|*/DEVELOPMENT.md)     echo "docs"; return ;;
    *CHANGELOG.md)               echo "docs"; return ;;
  esac

  # Build & CI group
  case "$file" in
    .github/*|.githooks/*)       echo "build-ci"; return ;;
    scripts/*)                   echo "build-ci"; return ;;
    *codesign*|*notary*)         echo "build-ci"; return ;;
    rust-toolchain.toml|rustfmt.toml) echo "build-ci"; return ;;
  esac

  # Auth & Profiles group
  case "$file" in
    *f5xc-*|*f5xc_*)            echo "auth-profiles"; return ;;
    */secrets/*|*/secrets.ts|*/obfuscator*) echo "auth-profiles"; return ;;
    */oauth/litellm*|*/oauth/index*) echo "auth-profiles"; return ;;
    *agent-session-obfuscator*)  echo "auth-profiles"; return ;;
  esac

  # UI & Theme group
  case "$file" in
    */status-line/*|*/status-line.ts|*status-bar*) echo "ui-theme"; return ;;
    */theme/*|*/theme.ts)        echo "ui-theme"; return ;;
    */gutter-*|*gutter-block*)   echo "ui-theme"; return ;;
    */welcome*|*welcome-*)       echo "ui-theme"; return ;;
  esac

  # AI Providers group
  case "$file" in
    */providers/ollama*|*/providers/*image*) echo "ai-providers"; return ;;
    */auto-config*|*/model-registry*) echo "ai-providers"; return ;;
    */oauth-litellm*|*litellm*)  echo "ai-providers"; return ;;
  esac

  # Core & Misc (default)
  echo "core"
}

# ─── Setup ────────────────────────────────────────────────────────────────────

init_work_dir() {
  WORK_DIR=$(mktemp -d /tmp/collapse-history-XXXXXX)
  info "Work directory: $WORK_DIR"
}

cleanup_work_dir() {
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
}

ensure_upstream() {
  if git remote get-url "$UPSTREAM_REMOTE" &>/dev/null; then
    info "Upstream remote already configured"
  else
    info "Adding upstream remote: $UPSTREAM_URL"
    git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
  fi

  info "Fetching upstream..."
  git fetch "$UPSTREAM_REMOTE" --quiet
  ok "Upstream fetched"
}

compute_merge_base() {
  ORIGINAL_HEAD=$(git rev-parse HEAD)
  MERGE_BASE=$(git merge-base HEAD "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")

  if [ -z "$MERGE_BASE" ]; then
    err "Could not find merge base between HEAD and $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
    exit 1
  fi

  info "Original HEAD: $(git rev-parse --short HEAD)"
  info "Merge base:    $(git rev-parse --short "$MERGE_BASE")"
  info "Upstream HEAD: $(git rev-parse --short "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")"
}

# ─── Phase 1: Analyze ────────────────────────────────────────────────────────

do_analyze() {
  header "Phase 1: Analysis"

  ensure_upstream
  compute_merge_base
  init_work_dir

  local our_commits upstream_commits
  our_commits=$(git log --oneline "$MERGE_BASE"..HEAD | wc -l | tr -d ' ')
  upstream_commits=$(git log --oneline HEAD.."$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | wc -l | tr -d ' ')

  info "Our commits since fork:      $our_commits"
  info "Upstream commits we're behind: $upstream_commits"

  # Get file lists
  git diff --name-only "$MERGE_BASE"..HEAD | sort > "$WORK_DIR/our-files.txt"
  git diff --name-only "$MERGE_BASE".."$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | sort > "$WORK_DIR/upstream-files.txt"

  comm -12 "$WORK_DIR/our-files.txt" "$WORK_DIR/upstream-files.txt" > "$WORK_DIR/both-files.txt"
  comm -23 "$WORK_DIR/our-files.txt" "$WORK_DIR/upstream-files.txt" > "$WORK_DIR/our-only-files.txt"

  local our_count upstream_count both_count our_only_count
  our_count=$(wc -l < "$WORK_DIR/our-files.txt" | tr -d ' ')
  upstream_count=$(wc -l < "$WORK_DIR/upstream-files.txt" | tr -d ' ')
  both_count=$(wc -l < "$WORK_DIR/both-files.txt" | tr -d ' ')
  our_only_count=$(wc -l < "$WORK_DIR/our-only-files.txt" | tr -d ' ')

  printf "\n"
  info "Files we changed:              $our_count"
  info "Files upstream changed:        $upstream_count"
  info "Files BOTH changed (conflicts): $both_count"
  info "Files only we changed:         $our_only_count"

  # Initialize group files
  for i in $(seq 0 $((NUM_GROUPS - 1))); do
    : > "$(group_file "$i")"
  done

  # Classify each file
  header "File Classification"

  while IFS= read -r file; do
    [ -z "$file" ] && continue

    local group
    group=$(classify_file "$file")

    # Find group index and append to its file
    for i in $(seq 0 $((NUM_GROUPS - 1))); do
      if [ "$(group_name "$i")" = "$group" ]; then
        echo "$file" >> "$(group_file "$i")"
        break
      fi
    done
  done < "$WORK_DIR/our-files.txt"

  # Print report
  printf "%-40s %8s %10s\n" "Group" "Files" "Conflicts"
  printf "%-40s %8s %10s\n" "----------------------------------------" "--------" "----------"

  for i in $(seq 0 $((NUM_GROUPS - 1))); do
    local gfile
    gfile="$(group_file "$i")"
    local file_count=0
    local conflict_count=0

    if [ -s "$gfile" ]; then
      file_count=$(wc -l < "$gfile" | tr -d ' ')
      conflict_count=$(comm -12 <(sort "$gfile") <(sort "$WORK_DIR/both-files.txt") | wc -l | tr -d ' ')
    fi

    printf "%-40s %8d %10d\n" "$(group_label "$i")" "$file_count" "$conflict_count"
  done

  printf "%-40s %8s %10s\n" "----------------------------------------" "--------" "----------"
  printf "%-40s %8d %10d\n" "TOTAL" "$our_count" "$both_count"

  # Show conflict files
  if [ "$both_count" -gt 0 ]; then
    header "Conflict Zone Files (both sides changed)"
    head -50 "$WORK_DIR/both-files.txt"
    if [ "$both_count" -gt 50 ]; then
      warn "... and $((both_count - 50)) more"
    fi
  fi

  # Copy group files to stable location for build phase
  for i in $(seq 0 $((NUM_GROUPS - 1))); do
    local name
    name=$(group_name "$i")
    local src
    src="$(group_file "$i")"
    local dst="/tmp/collapse-group-${name}.txt"
    cp "$src" "$dst"
    local count=0
    if [ -s "$dst" ]; then
      count=$(wc -l < "$dst" | tr -d ' ')
    fi
    info "Group '${name}': ${count} files -> $dst"
  done

  ok "Analysis complete"
}

# ─── Phase 2: Build branch ───────────────────────────────────────────────────

do_build() {
  header "Phase 2: Build rebase-ready branch"

  ensure_upstream
  compute_merge_base

  # Verify no staged or modified tracked files (untracked files are OK)
  if [ -n "$(git diff --name-only HEAD)" ] || [ -n "$(git diff --cached --name-only)" ]; then
    err "Working tree has staged or modified tracked files. Commit or stash changes first."
    exit 1
  fi

  # Check if classification files exist, run analyze if not
  if [ ! -f "/tmp/collapse-group-core.txt" ]; then
    warn "Classification files not found, running analysis first..."
    do_analyze
  fi

  local original_branch
  original_branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD)

  # Delete existing rebase-ready branch if present
  if git show-ref --verify --quiet "refs/heads/$REBASE_BRANCH"; then
    warn "Deleting existing '$REBASE_BRANCH' branch"
    git branch -D "$REBASE_BRANCH"
  fi

  # Create rebase-ready branch from merge-base
  info "Creating '$REBASE_BRANCH' branch from merge-base $(git rev-parse --short "$MERGE_BASE")"
  git checkout -b "$REBASE_BRANCH" "$MERGE_BASE" --quiet

  for i in $(seq 0 $((NUM_GROUPS - 1))); do
    local name label msg group_file_path
    name=$(group_name "$i")
    label=$(group_label "$i")
    msg=$(group_message "$i")
    group_file_path="/tmp/collapse-group-${name}.txt"

    printf "\n%s[%d/%d] %s%s\n" "$BOLD" "$((i+1))" "$NUM_GROUPS" "$label" "$RESET"

    if [ ! -s "$group_file_path" ]; then
      warn "No files for group '$name', skipping"
      continue
    fi

    local file_count
    file_count=$(wc -l < "$group_file_path" | tr -d ' ')
    info "Processing $file_count files..."

    local applied=0
    local skipped=0

    while IFS= read -r file; do
      [ -z "$file" ] && continue

      local exists_at_head exists_at_base
      exists_at_head=$(git cat-file -t "$ORIGINAL_HEAD:$file" 2>/dev/null || echo "missing")
      exists_at_base=$(git cat-file -t "$MERGE_BASE:$file" 2>/dev/null || echo "missing")

      if [ "$exists_at_head" = "missing" ] && [ "$exists_at_base" != "missing" ]; then
        # File deleted in our fork
        git rm --quiet "$file" 2>/dev/null || true
        applied=$((applied + 1))
      elif [ "$exists_at_base" = "missing" ]; then
        # New file — checkout from HEAD, preserving file mode
        local dir
        dir=$(dirname "$file")
        [ "$dir" != "." ] && mkdir -p "$dir"
        git show "$ORIGINAL_HEAD:$file" > "$file"
        # Preserve executable bit from HEAD
        local mode
        mode=$(git ls-tree "$ORIGINAL_HEAD" -- "$file" | awk '{print $1}')
        if [ "$mode" = "100755" ]; then
          chmod +x "$file"
        fi
        git add "$file"
        applied=$((applied + 1))
      else
        # File exists at both — try applying diff, fallback to checkout
        local diff_output
        diff_output=$(git diff "$MERGE_BASE" "$ORIGINAL_HEAD" -- "$file" 2>/dev/null || true)

        if [ -z "$diff_output" ]; then
          skipped=$((skipped + 1))
          continue
        fi

        if echo "$diff_output" | git apply --quiet 2>/dev/null; then
          git add "$file"
          applied=$((applied + 1))
        else
          # Fallback: checkout the file directly from HEAD
          git show "$ORIGINAL_HEAD:$file" > "$file"
          local fmode
          fmode=$(git ls-tree "$ORIGINAL_HEAD" -- "$file" | awk '{print $1}')
          if [ "$fmode" = "100755" ]; then
            chmod +x "$file"
          fi
          git add "$file"
          applied=$((applied + 1))
        fi
      fi
    done < "$group_file_path"

    if [ "$applied" -gt 0 ]; then
      local body
      body="Squashed from fork commits (merge-base: $(git rev-parse --short "$MERGE_BASE"))."$'\n'
      body+="Files: $applied changed"
      if [ "$skipped" -gt 0 ]; then
        body+=", $skipped unchanged (skipped)"
      fi

      git commit --quiet -m "$msg" -m "$body" || {
        warn "Nothing to commit for group '$name'"
      }
      ok "$applied files committed for '$name'"
    else
      warn "No changes for group '$name'"
    fi
  done

  # Handle renames: delete old paths that were renamed in our fork
  # git diff --name-only doesn't track rename sources, so they persist on the new branch
  info "Checking for renamed files (old paths to delete)..."
  local rename_count=0
  while IFS=$'\t' read -r status old_path new_path; do
    case "$status" in
      R*)
        if git cat-file -t "$REBASE_BRANCH:$old_path" &>/dev/null 2>&1; then
          git rm --quiet "$old_path" 2>/dev/null || true
          rename_count=$((rename_count + 1))
        fi
        ;;
    esac
  done < <(git diff --name-status -M "$MERGE_BASE" "$ORIGINAL_HEAD")

  if [ "$rename_count" -gt 0 ]; then
    git commit --quiet -m "chore(collapse): remove old paths from renamed files" \
      -m "Deleted $rename_count old paths that were renamed during the fork."
    ok "Deleted $rename_count old rename source paths"
  fi

  # Return to original branch
  git checkout "$original_branch" --quiet

  # Verify diff equivalence
  header "Verification"

  local diff_lines
  diff_lines=$(git diff HEAD "$REBASE_BRANCH" --stat | wc -l | tr -d ' ')

  if [ "$diff_lines" -le 1 ]; then
    ok "PASS: rebase-ready branch content matches HEAD (zero diff)"
  else
    warn "DIFF EXISTS between HEAD and rebase-ready:"
    git diff --stat HEAD "$REBASE_BRANCH" | tail -10
    warn "This means some files were not captured. Review the diff above."
  fi

  printf "\n"
  info "Commits on rebase-ready:"
  git log --oneline "$MERGE_BASE".."$REBASE_BRANCH"

  ok "Branch '$REBASE_BRANCH' is ready"
}

# ─── Phase 3: Preview rebase ─────────────────────────────────────────────────

do_preview() {
  header "Phase 3: Rebase Preview"

  ensure_upstream
  compute_merge_base

  local original_branch
  original_branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD)

  if ! git show-ref --verify --quiet "refs/heads/$REBASE_BRANCH"; then
    err "Branch '$REBASE_BRANCH' does not exist. Run 'build' first."
    exit 1
  fi

  local temp_branch="rebase-preview-$$"

  info "Creating temporary branch '$temp_branch' for preview..."
  git branch "$temp_branch" "$REBASE_BRANCH"
  git checkout "$temp_branch" --quiet

  info "Attempting rebase onto $UPSTREAM_REMOTE/$UPSTREAM_BRANCH..."

  local rebase_output
  if rebase_output=$(git rebase "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" 2>&1); then
    ok "Rebase completed WITHOUT conflicts"
    git checkout "$original_branch" --quiet
    git branch -D "$temp_branch" --quiet 2>/dev/null || true
  else
    warn "Rebase has conflicts (expected):"
    echo "$rebase_output" | grep -E "CONFLICT|error:|Merge conflict" | head -20

    # Count conflict files
    local conflict_count
    conflict_count=$(git diff --name-only --diff-filter=U 2>/dev/null | wc -l | tr -d ' ')
    info "Conflicting files: $conflict_count"

    if [ "$conflict_count" != "0" ]; then
      printf "\n%sConflict files:%s\n" "$BOLD" "$RESET"
      git diff --name-only --diff-filter=U 2>/dev/null | head -30
    fi

    # Abort rebase and clean up
    git rebase --abort 2>/dev/null || true
    git checkout "$original_branch" --quiet
    git branch -D "$temp_branch" 2>/dev/null || true

    warn "Conflicts are expected — this preview shows what you'll resolve during the real rebase"
  fi

  ok "Preview complete"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

usage() {
  echo "Usage: $0 {analyze|build|preview|all}"
  echo ""
  echo "  analyze  — Classify files into domain groups and report"
  echo "  build    — Create rebase-ready branch with squashed commits"
  echo "  preview  — Dry-run rebase to predict conflicts"
  echo "  all      — Run analyze + build + preview"
  exit 1
}

case "${1:-}" in
  analyze) do_analyze ;;
  build)   do_build ;;
  preview) do_preview ;;
  all)
    do_analyze
    do_build
    do_preview
    ;;
  *) usage ;;
esac
