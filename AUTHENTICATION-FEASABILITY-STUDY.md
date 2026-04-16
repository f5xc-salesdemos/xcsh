# AUTHENTICATION FEASIBILITY STUDY
## xcsh Multi-Profile XDG Integration with F5 Distributed Cloud

**Version:** 0.1 (Discovery Phase)
**Status:** Draft — Not for Implementation
**Scope:** Feasibility analysis only. No code changes are proposed here.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Current Ecosystem Survey](#3-current-ecosystem-survey)
   - 3.1 [f5xc-auth — Common Authentication Library](#31-f5xc-auth--common-authentication-library)
   - 3.2 [vscode-f5xc-tools — VS Code Extension](#32-vscode-f5xc-tools--vs-code-extension)
   - 3.3 [f5xc-xcsh — Prototype CLI](#33-f5xc-xcsh--prototype-cli)
   - 3.4 [xcsh — Current Agent Shell State](#34-xcsh--current-agent-shell-state)
4. [XDG Base Directory Specification Review](#4-xdg-base-directory-specification-review)
5. [F5 Distributed Cloud Authentication Reference](#5-f5-distributed-cloud-authentication-reference)
6. [Profile Activation Architecture Analysis](#6-profile-activation-architecture-analysis)
7. [Cross-Tool Synchronization Mechanisms](#7-cross-tool-synchronization-mechanisms)
8. [Implementation Strategy Options](#8-implementation-strategy-options)
   - 8.1 [Option A: Shell Script Source Injection](#81-option-a-shell-script-source-injection)
   - 8.2 [Option B: xcsh Built-in Profile Command](#82-option-b-xcsh-built-in-profile-command)
   - 8.3 [Option C: Skill-Based Profile Activation](#83-option-c-skill-based-profile-activation)
   - 8.4 [Option D: File Watcher Daemon](#84-option-d-file-watcher-daemon)
   - 8.5 [Option E: Startup-Only Profile Loading](#85-option-e-startup-only-profile-loading)
   - 8.6 [Option F: Hybrid Skill + File Watcher](#86-option-f-hybrid-skill--file-watcher)
9. [Setup Wizard Requirements](#9-setup-wizard-requirements)
10. [Security Analysis](#10-security-analysis)
11. [Compatibility and Integration Matrix](#11-compatibility-and-integration-matrix)
12. [Recommended Architecture](#12-recommended-architecture)
13. [Open Questions and Risks](#13-open-questions-and-risks)
14. [References](#14-references)

---

## 1. Executive Summary

The xcsh project is an AI-powered agent shell designed as a modern replacement for traditional CLI tools. The F5 Distributed Cloud (F5 XC) platform requires authenticated API access via API tokens or P12 certificates, and the organization has established a multi-profile XDG-compliant authentication ecosystem used by at least two other tools: the vscode-f5xc-tools VS Code extension and the f5xc-xcsh prototype CLI.

This feasibility study examines:
- The existing auth ecosystem (shared library, VS Code extension, prototype CLI)
- How xcsh's internal architecture maps to the authentication requirements
- Four distinct profile synchronization strategies with tradeoffs
- The requirements for a profile setup wizard within the AI agent context
- Security considerations unique to an AI agent handling sensitive credentials

**Key Findings:**
1. The XDG auth ecosystem is well-defined. Profiles live at `~/.config/f5xc/profiles/<name>.json`, with the active profile tracked in `~/.config/f5xc/active_profile`.
2. xcsh already has a multi-layered environment variable loading system (`packages/utils/src/env.ts`) and partial XDG support (`packages/utils/src/dirs.ts`) that can be extended.
3. xcsh's skill system (`SKILL.md` files) is the natural integration point for profile management commands, but has important limitations around runtime environment mutation.
4. The critical unsolved problem is **runtime environment variable eviction and reload** — the bash tool executes commands with inherited process environment, and changing that environment mid-session requires explicit subprocess management.
5. A hybrid approach (skill-triggered profile load on startup + file watcher for live switching) appears most feasible with acceptable security tradeoffs.

---

## 2. Problem Statement

### 2.1 Goal

When a user activates a tenant profile in any tool (VS Code extension, CLI, or future tools), the xcsh AI agent should:
1. Detect the active profile
2. Load the correct `F5XC_API_URL`, `F5XC_API_TOKEN`, and related environment variables
3. Expose these variables to all tool invocations (bash commands, API calls)
4. React to profile switches without requiring an agent restart, if possible

### 2.2 Why This Is Non-Trivial

The core difficulty is that xcsh is an **AI agent process** — not a shell that sources configuration files like bash or zsh. Environment variables in an OS process are inherited from the parent at spawn time and are not automatically updated when a file on disk changes.

This creates a fundamental architectural tension:
- The existing ecosystem uses a **file on disk** (`~/.config/f5xc/active_profile`) as the source of truth
- An agent process needs to **inject environment variables into its execution context** at runtime
- The bash tool in xcsh runs subcommands that inherit the agent's environment
- If the environment is wrong (stale tenant), API calls from within the agent will fail silently or against the wrong tenant

### 2.3 Scope Boundary

This study is limited to:
- **Authentication profiles for F5 Distributed Cloud** (API tokens, P12 certs, tenant URLs)
- **Integration with the existing XDG ecosystem** (same file format, same profile directory)
- **xcsh as a consumer**, not a producer, of the auth library

Out of scope for this feasibility study:
- Credential storage encryption at rest beyond filesystem permissions
- OAuth/OIDC federation with F5 XC identity providers
- Multi-user or shared system configurations
- Windows support (Linux and macOS only)

---

## 3. Current Ecosystem Survey

### 3.1 f5xc-auth — Common Authentication Library

**Repository:** https://github.com/robinmordasiewicz/f5xc-auth

The shared TypeScript library that all tools consume. It defines the canonical data model and file locations.

#### Profile Storage Format

Profiles are stored as JSON files with owner-only permissions:

```
~/.config/f5xc/
├── profiles/
│   ├── production.json    (mode: 0o600)
│   ├── staging.json       (mode: 0o600)
│   └── dev.json           (mode: 0o600)
├── active_profile         (plain text: profile name, no newline)
└── config.yaml            (global configuration)

~/.local/state/f5xc/
└── history                (command history)
```

#### Profile Schema

```typescript
interface Profile {
  name: string                  // alphanumeric + dashes/underscores, max 64 chars
  apiUrl: string                // https://<tenant>.console.ves.volterra.io
  apiToken?: string             // API token (alternative to cert)
  p12Bundle?: Buffer            // P12 certificate bundle
  cert?: string                 // PEM certificate
  key?: string                  // PEM key
  defaultNamespace?: string     // F5 XC namespace (default: "default")
  tlsInsecure?: boolean         // Disable TLS verification (dev only)
  caBundle?: string             // Custom CA bundle path
  metadata?: {
    createdAt?: Date
    lastRotatedAt?: Date
    expiresAt?: Date
    rotateAfterDays?: number
  }
}
```

#### Active Profile Mechanism

The active profile is simply the profile name written to `~/.config/f5xc/active_profile`:

```bash
# Activate a profile
echo -n "production" > ~/.config/f5xc/active_profile

# Read the active profile name
cat ~/.config/f5xc/active_profile
```

This is deliberately simple — any tool can write this file to signal a profile switch.

#### Credential Precedence (Library-Enforced)

The `CredentialManager` class enforces a strict priority order:

```
1. Environment variables (F5XC_API_URL, F5XC_API_TOKEN, F5XC_NAMESPACE, ...)
   → Always win; intended for CI/CD and Docker override scenarios
2. Active profile from ~/.config/f5xc/active_profile
   → Normal interactive use
3. Documentation mode (no auth)
   → Fallback when no credentials available
```

#### Key Environment Variables

```bash
F5XC_API_URL         # Full tenant API URL
F5XC_API_TOKEN       # API token for authentication
F5XC_NAMESPACE       # Default namespace
F5XC_PROTOCOL        # http or https (default: https)
F5XC_CA_BUNDLE       # Path to custom CA certificate bundle
F5XC_TLS_INSECURE    # true/false — disable TLS verification
LOG_LEVEL            # debug, info, warn, error
LOG_JSON             # true/false — JSON log output
```

#### HTTP Authentication Header

```
Authorization: APIToken <token_value>
```

#### XDG Path Utilities

```typescript
// src/config/paths.ts
getConfigDir()         → $XDG_CONFIG_HOME/f5xc || ~/.config/f5xc
getStateDir()          → $XDG_STATE_HOME/f5xc  || ~/.local/state/f5xc
getProfilesDir()       → getConfigDir()/profiles
getActiveProfilePath() → getConfigDir()/active_profile
getProfilePath(name)   → getProfilesDir()/<name>.json
```

---

### 3.2 vscode-f5xc-tools — VS Code Extension

**Repository:** https://github.com/robinmordasiewicz/vscode-f5xc-tools

A comprehensive VS Code extension that manages 236 F5 XC resource types. Its profile management implementation provides the clearest reference for the user experience pattern.

#### Profile Wizard Flow

When no profiles exist or the user initiates profile creation:

```
Step 1: Enter profile name
        → Validate: alphanumeric + dashes/underscores, max 64 chars
        → Check uniqueness against existing profiles

Step 2: Enter API URL
        → Validate: must be HTTPS
        → Normalize: strips trailing /api if present
        → Tenant extracted from hostname

Step 3: Select auth method
        → Option A: API Token
        → Option B: P12 Bundle
        → Option C: Cert + Key pair

Step 4: Collect credentials (method-specific)
        → Token: paste/enter token string
        → P12: file path + password
        → Cert/Key: file paths for both

Step 5: Optional default namespace
        → Default: "default"

Step 6: Validate credentials against live API
        → HEAD request to /api/web/namespaces
        → 3-second timeout, no retries (startup mode)
        → Show progress notification during validation
        → Error: specific message (bad token, unreachable, TLS error)

Step 7: Save profile (0o600 permissions)
        → Offer to set as active profile
```

#### Profile Change Signaling

The VS Code extension uses **file watchers** to detect external profile changes:

```typescript
// Watches ~/.config/f5xc/active_profile for changes
// When changed by another tool, clears caches and refreshes UI
const watcher = fs.watch(getActiveProfilePath(), () => {
  clearAuthCache()
  refreshProviders()
})
```

This means if xcsh writes to `active_profile`, the VS Code extension automatically detects it — and vice versa.

#### Client/Auth Cache Management

- Client instances are cached per profile name
- Auth provider caches are invalidated on profile change
- File watchers trigger cache invalidation on external modifications
- `f5xc.clearAuthCache` command available to users for manual cache clearing

---

### 3.3 f5xc-xcsh — Prototype CLI

**Repository:** https://github.com/robinmordasiewicz/f5xc-xcsh

The non-agent prototype demonstrates how a CLI tool participates in the ecosystem.

#### Session Initialization Flow

```
1. Detect active profile from ~/.config/f5xc/active_profile
2. If exactly one profile exists and none active → auto-activate it
3. Load profile credentials (apiUrl, apiToken, etc.)
4. Check API reachability (HEAD request, 3s timeout)
5. Validate token if reachable
6. If token invalid and env vars set → try env var credentials as fallback
7. Fetch user info (non-critical, silent on error)
8. Report status: connected / offline / error / auth_error
```

#### Auth Source Tracking

The prototype tracks which credential source was used:

```typescript
_authSource: "env" | "profile" | "mixed" | "profile-fallback" | "none"
_connectionStatus: "connected" | "offline" | "error" | "unknown"
_fallbackAttempted: boolean
_fallbackReason: string
```

#### Profile Switching Mid-Session

When the user switches profiles within the CLI:

1. Clear auth state
2. Load new profile credentials
3. Recreate API client with new credentials
4. Invalidate namespace cache
5. Re-validate token against API
6. Update status bar/prompt

This is done entirely in-process since the prototype maintains its own `ApiClient` object.

#### Registered Environment Variables

The prototype uses a registry pattern for documenting expected environment variables:

```
API_URL (required)     — F5 XC tenant API endpoint
API_TOKEN (required)   — Authentication token
NAMESPACE              — Default namespace (flag: -ns)
OUTPUT_FORMAT          — Output styling (flag: -o)
LOGO                   — Logo display mode
NO_COLOR               — Disable terminal colors
```

---

### 3.4 xcsh — Current Agent Shell State

**Repository:** /workspace/xcsh (current working directory)

#### Existing Authentication Infrastructure

xcsh already has substantial auth infrastructure, but it is oriented toward **AI model providers** (Anthropic, OpenAI, GitHub Copilot, etc.) rather than F5 XC API authentication.

**Credential Store:**
- SQLite database at `~/.xcsh/agent/agent.db`
- Managed by `AuthCredentialStore` in `packages/ai/src/auth-storage.ts`
- Supports `ApiKeyCredential` and `OAuthCredential` types
- 35+ OAuth providers supported

**Environment Variable Loading (`packages/utils/src/env.ts`):**

Four `.env` files are loaded in priority order:

```
1. $PWD/.env             (project-level, highest priority)
2. ~/.xcsh/agent/.env    (agent home)
3. ~/.env                (home directory)
4. ~/.xcsh/.env          (config root)
```

**Important note:** `XCSH_*` prefixed keys are mirrored to `PI_*` keys during load:
```
XCSH_CONFIG_DIR → PI_CONFIG_DIR
XCSH_API_KEY    → PI_API_KEY
```

This mirroring pattern could be extended for F5 XC variables.

**XDG Support (`packages/utils/src/dirs.ts`):**

xcsh already has XDG support for its own directories:

```typescript
// When XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME are set:
// ~/.xcsh/agent → $XDG_DATA_HOME/xcsh/agent
// requires: xcsh config migrate
```

However, the XDG paths are for xcsh's own data, not `~/.config/f5xc/`.

**Skill System:**

Skills are Markdown files (`SKILL.md`) with YAML frontmatter, loaded from:
```
~/.xcsh/agent/skills/     (user-level)
.xcsh/skills/             (project-level)
~/.claude/                (claude-level)
```

Skills are injected into the system prompt as context for the AI — they do **not** run code directly.

**Bash Tool (`packages/coding-agent/src/tools/bash.ts`):**

```typescript
interface BashInput {
  command: string
  cwd?: string
  env?: Record<string, string>    // Per-command env var overrides
  timeout?: number
}
```

The bash tool can receive per-command environment variable overrides, but these are not persisted across tool calls unless the session is configured to include them.

**Settings (`packages/coding-agent/src/config/settings.ts`):**

Settings support a `bash.environment` key for persistent custom environment variables injected into all bash tool calls. This is the most promising hook for injecting F5 XC credentials.

**Agent Directory Override:**

```typescript
// Single active agent dir per process
PI_CODING_AGENT_DIR   // Environment variable override
setAgentDir(dir)      // Programmatic override
```

This could be used to point different xcsh invocations at different "profiles" of xcsh config, but this is xcsh's own config, not F5 XC profiles.

---

## 4. XDG Base Directory Specification Review

The [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/) defines the following defaults when environment variables are unset:

| Variable           | Default             | Purpose                         |
|--------------------|---------------------|---------------------------------|
| `XDG_CONFIG_HOME`  | `~/.config`         | User-specific configuration     |
| `XDG_DATA_HOME`    | `~/.local/share`    | User-specific data files        |
| `XDG_STATE_HOME`   | `~/.local/state`    | User-specific state (history, etc.) |
| `XDG_CACHE_HOME`   | `~/.cache`          | Non-essential cached data       |
| `XDG_RUNTIME_DIR`  | (platform-specific) | Runtime files (sockets, pipes)  |

### Relevant Conventions

- Subdirectories under `$XDG_CONFIG_HOME` should NOT use dot prefixes
  - Correct: `$XDG_CONFIG_HOME/f5xc/`
  - Wrong: `$XDG_CONFIG_HOME/.f5xc/`
- Files stored in user config directories should use `0o600` permissions
- Directories should use `0o700` permissions
- Applications should never fail if `XDG_RUNTIME_DIR` is unavailable

### f5xc-auth Library Compliance

The library is fully XDG-compliant:
```
~/.config/f5xc/          → $XDG_CONFIG_HOME/f5xc/
~/.local/state/f5xc/     → $XDG_STATE_HOME/f5xc/
```

### xcsh's Current Compliance

xcsh uses `~/.xcsh/` by default (not XDG-compliant) but has opt-in XDG migration via `xcsh config migrate`. The XDG-compliant paths would be:
```
~/.local/share/xcsh/     → for xcsh's own data
~/.config/xcsh/          → for xcsh's own config
```

Note: These are separate from the F5 XC auth paths at `~/.config/f5xc/`.

---

## 5. F5 Distributed Cloud Authentication Reference

### 5.1 Supported Authentication Methods

**Method 1: API Token**
- Created in F5 XC Console → Personal Management → Credentials → Add Credentials → API Token
- Bearer-equivalent header: `Authorization: APIToken <token>`
- Configurable expiry (default: up to 365 days, administrator-configured max)
- Inherits RBAC permissions of creating user
- Best for: development, personal use, automation scripts

**Method 2: P12 Certificate (mTLS)**
- Created in F5 XC Console → Personal Management → Credentials → Add Credentials → API Certificate
- X.509 certificate + private key in PKCS#12 format
- Password protected (`VES_P12_PASSWORD` environment variable)
- More secure than API tokens (mutual authentication)
- Best for: production automation, service accounts

**Method 3: API Certificate (Kubeconfig)**
- Virtual Kubernetes kubeconfig format
- For Kubernetes-style API access

### 5.2 Tenant URL Format

```
https://<tenant_name>.console.ves.volterra.io
```

API endpoint:
```
https://<tenant_name>.console.ves.volterra.io/api
```

Namespace-scoped resource path:
```
https://<tenant>.console.ves.volterra.io/{service_prefix}/namespaces/{namespace}/{kind}
```

### 5.3 Environment Variables (Canonical Set)

These are the variables the ecosystem uses consistently across all tools:

```bash
# Required
F5XC_API_URL          # Full tenant API URL (with /api suffix)
F5XC_API_TOKEN        # Authentication token

# Optional
F5XC_NAMESPACE        # Default namespace (default: "default")
F5XC_PROTOCOL         # http|https (default: https)
F5XC_CA_BUNDLE        # Path to custom CA certificate file
F5XC_TLS_INSECURE     # true|false — disable certificate verification

# Legacy / alternative names
VOLTERRA_TOKEN        # Older API token variable name (some tools)
VES_P12_PASSWORD      # P12 certificate password

# Logging
LOG_LEVEL             # debug|info|warn|error
LOG_JSON              # true|false
```

### 5.4 Token Validation Pattern

All three existing tools use the same lightweight validation:
```
HEAD request → https://<tenant>/api/web/namespaces
3-second timeout
No retries
Success codes: 200-399
Auth failure: 401, 403
Token OK (non-auth error): 404, 500, etc.
```

---

## 6. Profile Activation Architecture Analysis

### 6.1 The Shared State Model

The ecosystem uses a file-on-disk model as shared state:

```
Active Tool       Other Tools
──────────        ─────────────
writes:           reads:
~/.config/f5xc/   ~/.config/f5xc/
active_profile    active_profile
                         ↓
                  load profile JSON
                         ↓
                  apply credentials
```

This is the lowest common denominator — works across languages, runtimes, and tools. No IPC protocol needed.

### 6.2 The xcsh Difference

xcsh has a unique constraint that other tools don't: **it is an interactive AI agent that runs continuously**. The VS Code extension and prototype CLI both re-read the profile on every API call or command. xcsh, however, maintains a running process with an inherited environment.

The critical question is: **when the active profile changes on disk, how does xcsh know, and how does it update its working environment?**

Three sub-problems:
1. **Detection:** How does xcsh know the profile changed?
2. **Eviction:** How are old credential environment variables removed from the session?
3. **Injection:** How are new credential environment variables made available to all subsequent tool calls?

### 6.3 Environment Variable Propagation in xcsh

The bash tool currently supports per-call env var injection:

```typescript
// bash.ts: env vars applied per-command
const envOverrides = { ...sessionEnv, ...input.env }
```

And there's a settings-level persistent injection:
```yaml
# ~/.xcsh/agent/config.yml
bash:
  environment:
    F5XC_API_URL: "https://production.console.ves.volterra.io"
    F5XC_API_TOKEN: "my-token"
```

If xcsh can **programmatically update `bash.environment`** at runtime when a profile switch is detected, this provides the injection mechanism.

The eviction problem (removing old variables when switching) is more subtle — the settings API supports overrides, so a profile switch could set new values that supersede old ones, effectively "evicting" the stale credentials.

---

## 7. Cross-Tool Synchronization Mechanisms

### 7.1 File Watcher (inotify/FSEvents)

**How it works:** A persistent watcher monitors `~/.config/f5xc/active_profile` for write events. When the file changes, xcsh reads the new profile name and updates its credential set.

**Platforms:**
- Linux: inotify (kernel API, `inotifywait` CLI tool available)
- macOS: FSEvents (native, recursive directory watching)
- Cross-platform: Node.js `fs.watch()` wraps both

**In xcsh context:** The `AgentSession` already has an EventBus (`session.eventBus`). A file watcher could emit events onto this bus when the active profile changes.

**Latency:** Essentially zero — file change events are delivered within milliseconds of the write.

**Risk:** Rapid profile switching (multiple changes per second) could cause credential thrashing. Debouncing (e.g., 500ms) is needed.

**Implementation complexity:** Medium. Requires:
1. Importing a file watcher into the session lifecycle
2. Hooking the watcher event to an "update credentials" handler
3. Ensuring the watcher is cleaned up on session exit

### 7.2 Poll-Based Detection

**How it works:** xcsh periodically (e.g., every 5 seconds) reads `~/.config/f5xc/active_profile` and compares to its cached value. If different, reload credentials.

**Advantages:**
- Simpler to implement than file watchers
- No platform-specific code
- Works correctly even if inotify events are missed

**Disadvantages:**
- Latency: up to 5 seconds before profile change is reflected
- Unnecessary disk reads even when nothing changes
- Not suitable for real-time use cases

**Implementation complexity:** Low.

### 7.3 Startup-Only Loading

**How it works:** xcsh reads the active profile once at startup and applies those credentials to the session. No live updates.

**Advantages:**
- Simplest possible implementation
- No ongoing overhead
- Perfectly predictable — credentials don't change under you

**Disadvantages:**
- Requires xcsh restart to switch profiles
- If user activates a new profile in VS Code, xcsh doesn't notice
- Not aligned with "other tools just work" UX expectation

**Mitigations:**
- Display the active profile in xcsh status bar
- Provide a `/reload-profile` or similar command to manually trigger a re-read
- Display a warning if the on-disk active profile differs from the loaded profile

**Implementation complexity:** Very Low.

### 7.4 VS Code IPC Socket

**How it works:** VS Code exposes a Unix domain socket via `VSCODE_IPC_HOOK_CLI` environment variable. Theoretically, the VS Code extension could send xcsh a message when a profile switches.

**Current assessment:** This path is complex and fragile:
- The IPC hook is designed for VS Code's own CLI communication, not arbitrary tool messages
- xcsh would need to listen on its own socket, and the VS Code extension would need to know xcsh's socket path
- Both tools would need to implement a shared protocol

**Verdict:** Too complex for phase 1. Revisit after core profile loading is working.

### 7.5 Environment Variable Delegation

**How it works:** xcsh reads the profile at startup and exports `F5XC_*` variables into the shell session (not the xcsh process env, but the user's shell). When the user next starts xcsh, it inherits the exported variables.

**Problem:** xcsh cannot modify its parent shell's environment variables. This is a fundamental OS constraint — environment variables flow down (parent → child) but not up (child → parent).

**Shell script workaround:** A shell function `xcsh-activate-profile` that sources a generated shell script containing `export F5XC_*=...` and then launches xcsh. This requires the user to use the function, not the bare `xcsh` command.

**Verdict:** Viable as one option, but shifts burden to the user/installer.

---

## 8. Implementation Strategy Options

This section describes six distinct implementation approaches. They are not mutually exclusive — a hybrid may be optimal.

---

### 8.1 Option A: Shell Script Source Injection

**Concept:** Ship a shell function (bash/zsh compatible) that wraps xcsh invocation, sources the active profile's credentials as environment variables, then runs xcsh. The script reads `~/.config/f5xc/active_profile`, loads `~/.config/f5xc/profiles/<name>.json`, translates JSON fields to shell exports, and launches xcsh.

**Implementation:**

```bash
# ~/.config/f5xc/activate.sh (generated or static)
# Meant to be sourced, not executed

function xcsh() {
  local active_profile_file="$HOME/.config/f5xc/active_profile"
  if [[ -f "$active_profile_file" ]]; then
    local profile_name
    profile_name=$(cat "$active_profile_file")
    local profile_file="$HOME/.config/f5xc/profiles/${profile_name}.json"
    if [[ -f "$profile_file" ]]; then
      export F5XC_API_URL=$(jq -r '.apiUrl' "$profile_file")
      export F5XC_API_TOKEN=$(jq -r '.apiToken' "$profile_file")
      export F5XC_NAMESPACE=$(jq -r '.defaultNamespace // "default"' "$profile_file")
    fi
  fi
  command xcsh "$@"
}
```

**Advantages:**
- No changes to xcsh core required for credential loading
- Follows established patterns (AWS Vault, Granted, gcloud)
- Works with any shell (bash, zsh, fish variant)
- Trivially testable

**Disadvantages:**
- Requires user to source the activation script (`~/.bashrc` or `~/.zshrc`)
- Credentials are in environment variables of the shell process — visible via `env` command
- No live switching — profile is locked at xcsh startup
- `jq` dependency (common but not universal)
- Secrets briefly visible in process environment of user's shell

**Feasibility:** High. Can be implemented as an installer step.

**Security note:** Environment variables are readable by any process running as the same user (via `/proc/<pid>/environ` on Linux). This is acceptable for the threat model (single-user workstation) but should be documented.

---

### 8.2 Option B: xcsh Built-in Profile Command

**Concept:** Implement `xcsh profile` as a first-class built-in command (similar to how `xcsh config` works). This command is implemented in TypeScript within xcsh itself and has access to the agent session's internal state.

**Sub-commands:**
```
xcsh profile list                     # List all profiles (with active indicator)
xcsh profile activate <name>          # Switch to named profile
xcsh profile create                   # Interactive wizard
xcsh profile show [name]              # Print profile details (masked token)
xcsh profile delete <name>            # Delete a profile
xcsh profile status                   # Show current auth status
```

**Internal mechanism for `activate`:**
1. Read `~/.config/f5xc/profiles/<name>.json`
2. Update `session.env.F5XC_API_URL = profile.apiUrl`
3. Update `session.env.F5XC_API_TOKEN = profile.apiToken`
4. Update the `bash.environment` settings override (in-memory, not persisted)
5. Write `~/.config/f5xc/active_profile` (so other tools see the change)
6. Validate credentials (optional, with `--validate` flag)
7. Report: "Switched to profile: production"

**In xcsh session model:**

The `AgentSession` object holds the current environment context. A `profileManager` service could be registered in the session that:
- Owns the `F5XC_*` variable set
- Updates bash tool env overrides when profile changes
- Reads active profile at session start

**Advantages:**
- Native xcsh experience — discoverable via `xcsh help`
- Direct access to session internals — clean implementation
- Can implement live validation
- Profile switch is reflected in VS Code (writes `active_profile`)
- Skill integration possible: AI can call `xcsh profile activate production`

**Disadvantages:**
- Requires xcsh TypeScript implementation work
- No automatic reaction to external profile changes (from VS Code)
- Session env mutation needs careful implementation to avoid stale credentials

**Feasibility:** High. This is the most architecturally clean option.

**Key implementation file:** `packages/coding-agent/src/cli/commands/profile.ts` (new file, modeled after `init-xdg.ts`)

---

### 8.3 Option C: Skill-Based Profile Activation

**Concept:** Create a user skill (`SKILL.md` file) that teaches the AI how to manage profiles. The AI agent, when asked about profiles or F5 XC authentication, follows the skill's instructions to read/write profile files and set environment variables via bash commands.

**Example skill structure:**

```markdown
---
name: f5xc-profile-manager
description: Manage F5 Distributed Cloud authentication profiles
---

You help users manage F5 XC authentication profiles stored at
~/.config/f5xc/profiles/.

When asked to activate a profile:
1. Read the profile file: cat ~/.config/f5xc/profiles/<name>.json
2. Extract apiUrl, apiToken, defaultNamespace
3. Update the active profile: echo -n "<name>" > ~/.config/f5xc/active_profile
4. Report the current auth status

When asked to create a profile, guide the user through:
- Profile name (alphanumeric + dashes/underscores)
- API URL (https://<tenant>.console.ves.volterra.io)
- Authentication method (API token or P12 certificate)
- Default namespace

Environment variables to set for F5 XC operations:
- F5XC_API_URL
- F5XC_API_TOKEN
- F5XC_NAMESPACE
```

**Critical limitation:** Skills teach the AI what to do with text, but they cannot directly mutate the xcsh session's environment variables. The AI can run bash commands that set environment variables in a subprocess, but those don't propagate back to the xcsh process or to subsequent bash tool invocations.

**What skills CAN do:**
- Guide the AI to read profile files and include credential information in its responses
- Instruct the AI to pass `--env F5XC_API_URL=... F5XC_API_TOKEN=...` to bash tool calls
- Document the profile structure so the AI understands it
- Implement the wizard experience via conversational guidance

**What skills CANNOT do (without Option B):**
- Persist environment variables across bash tool calls
- Update the `bash.environment` settings key (requires internal API access)
- Guarantee that all bash executions use the correct credentials

**Feasibility as standalone approach:** Medium-Low. Works for ad-hoc use but not reliable for automated workflows.

**Feasibility as complement to Option B:** High. A skill provides AI guidance while Option B provides the mechanical implementation.

---

### 8.4 Option D: File Watcher Daemon

**Concept:** xcsh runs a background file watcher on `~/.config/f5xc/active_profile`. When the file changes (written by VS Code or any other tool), xcsh automatically reloads credentials without user intervention.

**Implementation sketch:**

```typescript
// In AgentSession initialization:
import { watch } from "fs"

const activeProfilePath = getF5XCActiveProfilePath()
const watcher = watch(activeProfilePath, { persistent: false }, async () => {
  const newProfileName = await readFile(activeProfilePath, "utf8")
  if (newProfileName !== this.f5xcProfile) {
    await this.reloadF5XCProfile(newProfileName)
    this.eventBus?.emit("f5xc:profile-changed", newProfileName)
  }
})

// On session exit:
watcher.close()
```

```typescript
// reloadF5XCProfile method:
async reloadF5XCProfile(profileName: string) {
  const profilePath = getF5XCProfilePath(profileName)
  const profile = JSON.parse(await readFile(profilePath, "utf8"))
  
  // Update in-memory env overrides for bash tool
  this.settings.override("bash.environment", {
    F5XC_API_URL: profile.apiUrl,
    F5XC_API_TOKEN: profile.apiToken,
    F5XC_NAMESPACE: profile.defaultNamespace ?? "default",
  })
  
  this.f5xcProfile = profileName
}
```

**Advantages:**
- True live switching — xcsh detects VS Code profile changes automatically
- No user action required to sync xcsh with other tools
- Clean: watcher lifecycle tied to session lifecycle

**Disadvantages:**
- Node.js `fs.watch()` has known edge cases (macOS rename vs change events)
- Adds background overhead to every xcsh session
- Race condition: watcher fires before new profile JSON is fully written
- Requires the `active_profile` file to exist at startup (first-run problem)

**Feasibility:** Medium. Technically sound but operationally fragile without debouncing and defensive error handling.

**Recommended enhancement:** Combine with 500ms debounce and validation of profile file existence before attempting reload.

---

### 8.5 Option E: Startup-Only Profile Loading

**Concept:** At xcsh session start, read `~/.config/f5xc/active_profile` (if it exists), load the named profile, and inject credentials into the session's `bash.environment` overrides. No live updates.

**Startup sequence addition:**

```
Current xcsh startup:
  1. Parse CLI args
  2. Load .env files
  3. Initialize settings
  4. Load skills/capabilities
  5. Create session

Proposed addition:
  1. Parse CLI args
  2. Load .env files
  3. Initialize settings
  3a. → IF active_profile exists AND F5XC_API_URL not already set:
        Read profile → inject F5XC_* into settings bash.environment
  4. Load skills/capabilities
  5. Create session
```

**Condition check (`F5XC_API_URL not already set`):** Preserves the existing ecosystem convention that environment variables override profile credentials.

**Advantages:**
- Minimal implementation risk
- Correct behavior: respects env var override convention
- No background processes, no watchers
- Zero latency at runtime

**Disadvantages:**
- Stale after profile switch in another tool
- User must restart xcsh to pick up profile changes

**UX mitigation:** Display current profile in xcsh status bar. If status bar shows "production" but user is working on staging tenant, the discrepancy is immediately visible.

**Feasibility:** Very High. This is the quickest path to basic integration.

---

### 8.6 Option F: Hybrid Skill + File Watcher

**Concept:** Combine Option B (built-in command), Option C (skill guidance), and Option D (file watcher):

- **Built-in command** (`xcsh profile`) handles all profile CRUD operations
- **File watcher** detects external profile changes (from VS Code)
- **Skill** teaches the AI how to use the built-in command and understand auth status
- **Startup loading** (Option E) as the baseline

**Architecture diagram:**

```
┌─────────────────────────────────────────────────────────────────┐
│                         xcsh Agent Session                      │
│                                                                 │
│  ┌──────────────┐    ┌────────────────┐    ┌────────────────┐  │
│  │  CLI Command │    │  File Watcher  │    │  AI Skill      │  │
│  │  xcsh profile│    │  ~/.config/f5xc│    │  f5xc-profiles │  │
│  │  list/activate│   │  /active_profile│   │  (SKILL.md)    │  │
│  └──────┬───────┘    └───────┬────────┘    └───────┬────────┘  │
│         │                   │                      │            │
│         └─────────────┬─────┘                      │            │
│                       ↓                            │            │
│           ┌───────────────────────┐               │            │
│           │  ProfileService       │               │            │
│           │  - read/write profiles│               │            │
│           │  - update bash.env    │               │            │
│           │  - validate tokens    │               │            │
│           └───────────┬───────────┘               │            │
│                       │                            │            │
│                       ↓                            ↓            │
│           ┌───────────────────────────────────────────────┐    │
│           │  Session Bash Environment                     │    │
│           │  F5XC_API_URL = profile.apiUrl                │    │
│           │  F5XC_API_TOKEN = profile.apiToken            │    │
│           │  F5XC_NAMESPACE = profile.defaultNamespace    │    │
│           └───────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
          ↕ file writes                    ↕ file reads
┌─────────────────────────────────────────────────────────────────┐
│                  ~/.config/f5xc/                                │
│   active_profile    profiles/production.json                    │
│                     profiles/staging.json                       │
└─────────────────────────────────────────────────────────────────┘
          ↕                                        ↕
┌──────────────────┐                    ┌───────────────────────┐
│  VS Code         │                    │  f5xc-xcsh (CLI)      │
│  vscode-f5xc     │                    │  (other tools)        │
│  tools extension │                    │                       │
└──────────────────┘                    └───────────────────────┘
```

**Advantages:**
- Complete integration story
- AI can manage profiles conversationally
- Automatic reaction to external tool changes
- Consistent with ecosystem conventions

**Disadvantages:**
- Most implementation effort of all options
- Multiple moving parts increase failure surface
- File watcher complexity (platform differences, edge cases)

**Feasibility:** High but requires phased implementation.

---

## 9. Setup Wizard Requirements

When xcsh starts with no active profile and no F5 XC credentials in environment, it needs to guide the user through initial setup. This is critical for first-run experience.

### 9.1 Detection Logic

```
On xcsh startup:
  1. Check if F5XC_API_URL is set in environment
     → YES: Proceed (env var credentials take precedence)
  2. Check if ~/.config/f5xc/active_profile exists
     → YES: Load that profile, proceed
  3. Check if ~/.config/f5xc/profiles/ has any profiles
     → YES (one profile): Auto-activate it, prompt to confirm
     → YES (multiple): Ask user to choose
  4. NO profiles found: Enter wizard mode
```

### 9.2 Wizard Flow (AI Conversational Mode)

Since xcsh is an AI agent, the setup wizard can be conversational rather than a traditional TUI wizard. The AI guides the user through the following steps:

```
Step 1: Explain what's happening
  "I don't see any F5 Distributed Cloud authentication profiles configured.
   Let me help you set one up."

Step 2: Collect profile name
  "What would you like to name this profile? (e.g., 'production', 'staging', 'dev')"
  Validate: alphanumeric + dashes/underscores, max 64 chars

Step 3: Collect tenant URL
  "What is your F5 Distributed Cloud tenant URL?
   It should look like: https://<your-tenant>.console.ves.volterra.io"
  Validate: HTTPS, parseable hostname, .console.ves.volterra.io suffix or custom

Step 4: Select auth method
  "How would you like to authenticate?
   1. API Token (simpler, good for development)
   2. P12 Certificate (more secure, recommended for production)"

Step 5a (API Token): Collect token
  "Please paste your API token. You can create one in the F5 XC Console:
   Personal Management → Credentials → Add Credentials → API Token"
  Note: mask token in display after confirmation

Step 5b (P12 Certificate): Collect certificate
  "Please provide the path to your P12 certificate file."
  "Please provide the P12 certificate password."
  Validate: file exists, readable

Step 6: Collect default namespace
  "What is your default namespace? (Press Enter for 'default')"

Step 7: Validate credentials
  "Let me verify these credentials work..."
  [Perform token validation — HEAD to /api/web/namespaces, 3s timeout]
  → Success: "Authentication successful! Your username is <user@example.com>"
  → Failure: "I couldn't validate the credentials: <specific error>
              [Retry / Save anyway / Cancel]"

Step 8: Save and activate
  "Profile '<name>' saved and activated."
  Save to: ~/.config/f5xc/profiles/<name>.json (0o600)
  Write: ~/.config/f5xc/active_profile (echo -n "<name>")
```

### 9.3 Wizard Trigger Points

The wizard (or a simplified version) should also trigger when:
- User explicitly asks "help me set up F5 XC authentication"
- User asks xcsh to perform an F5 XC operation with no credentials configured
- Credentials fail validation (token expired, wrong tenant, etc.)

### 9.4 Wizard as a Skill

The setup wizard is a natural candidate for a skill file. The skill teaches the AI the exact steps, validations, and error messages to use. This separates the wizard logic from the core xcsh TypeScript implementation.

Example skill:
```
~/.xcsh/agent/skills/f5xc-setup-wizard.md
OR
~/.config/xcsh/skills/f5xc-auth-wizard.md  (if xcsh adopts XDG for its own config)
```

---

## 10. Security Analysis

### 10.1 Threat Model

**Actors:**
- Trusted: The user running xcsh on their workstation
- Untrusted: Other users on a shared system, malicious packages/prompts injected into the AI context

**Assets:**
- API tokens (allow tenant admin-level API access)
- P12 certificates (allow mTLS auth)
- Tenant URLs (reveal organization's F5 XC tenant name)

### 10.2 File System Security

The f5xc-auth library enforces `0o600` permissions on profile JSON files and `0o700` on the profiles directory. This is correct for single-user workstations and must be preserved by xcsh when creating or modifying profiles.

**Risk:** xcsh bash tool runs commands as the user. A malicious prompt injection could instruct xcsh to `cat ~/.config/f5xc/profiles/*.json`, exfiltrating credentials.

**Mitigation:**
- The skill/wizard must instruct the AI never to display API tokens in full
- Token masking: show only last 4 characters (aligns with what the ecosystem already does)
- Prompt injection detection (via xcsh's existing hook system) should flag attempts to read credential files

### 10.3 Environment Variable Security

Environment variables containing API tokens are readable by any process running as the same user:
```bash
cat /proc/<xcsh_pid>/environ | tr '\0' '\n' | grep F5XC
```

**Mitigation:** This is the accepted risk for single-user workstations. The threat is no worse than how `AWS_ACCESS_KEY_ID` is handled. Document this clearly.

For shared systems or higher security requirements, credentials should NOT be passed via environment variables. The built-in profile command (Option B) should avoid ever exporting credentials to subprocesses where possible — instead, xcsh's API client (if it directly makes F5 XC API calls) should hold credentials in memory.

### 10.4 Prompt Injection Risks

xcsh is an AI agent and can be manipulated via injected content in files, web pages, or tool outputs. A malicious actor could craft a file that, when read by xcsh, instructs it to exfiltrate credentials.

**Mitigations:**
- Never include raw credential files in xcsh's reading context
- If xcsh reads a profile for display, mask the token immediately
- Consider a dedicated safe-read function that masks sensitive fields before returning to the AI
- The skill system's `alwaysApply: false` default means credential-handling skills don't run unless relevant — limit their exposure

### 10.5 Token Lifecycle

API tokens can expire. The ecosystem tracks expiry via `profile.metadata.expiresAt`. xcsh should:
- Check expiry at startup and warn if token expires within N days
- Provide a clear error when a 401 occurs (token expired vs. wrong token)
- Support token rotation workflow (update profile in place, validate new token)

### 10.6 P12 Certificate Security

P12 certificate passwords (`VES_P12_PASSWORD`) are particularly sensitive. Unlike API tokens, they decrypt a private key.

**Recommendation:** P12 passwords should not be stored in profile JSON files without encryption. Options:
- Use the OS keychain (Keychain on macOS, libsecret/GNOME Keyring on Linux) for password storage
- Store only the P12 bundle path; prompt for password at use time
- This is out of scope for initial implementation but critical for P12 support

---

## 11. Compatibility and Integration Matrix

### 11.1 xcsh vs. Ecosystem Compatibility

| Feature | f5xc-auth | vscode-f5xc-tools | f5xc-xcsh (proto) | xcsh (proposed) |
|---------|-----------|-------------------|-------------------|-----------------|
| XDG profile storage | ✓ canonical | ✓ | ✓ | ○ to implement |
| active_profile file | ✓ defines | ✓ reads/writes | ✓ reads/writes | ○ to implement |
| F5XC_* env vars | ✓ defines | ✓ reads | ✓ reads | ○ to implement |
| Profile wizard | ✗ (library) | ✓ UI | ✓ REPL | ○ conversational |
| Token validation | ✓ HttpClient | ✓ | ✓ ApiClient | ○ via bash tool |
| File watcher | ✗ | ✓ | ✗ | ○ optional |
| Cross-tool signaling | via files | ✓ emits events | via files | ○ via files |
| P12 cert support | ✓ | ✓ | ✓ | ○ phase 2 |
| Namespace support | ✓ | ✓ | ✓ | ○ to implement |

Legend: ✓ implemented, ○ proposed, ✗ not applicable

### 11.2 xcsh Internal Compatibility

| xcsh Component | Integration Touch Points |
|----------------|--------------------------|
| `packages/utils/src/env.ts` | Can extend to load F5XC vars from profile |
| `packages/utils/src/dirs.ts` | Add `getF5XCConfigDir()` etc. |
| `packages/coding-agent/src/config/settings.ts` | `bash.environment` overrides |
| `packages/coding-agent/src/cli/commands/` | New `profile.ts` command |
| `packages/coding-agent/src/session/agent-session.ts` | Session-level credential state |
| `packages/coding-agent/src/tools/bash.ts` | Inherits session env overrides |
| Skill system (`SKILL.md`) | Wizard guidance, profile command docs |

### 11.3 Platform Compatibility

| Feature | Linux | macOS | Windows |
|---------|-------|-------|---------|
| XDG paths | ✓ native | ✓ (via convention) | ✗ (use %APPDATA%) |
| File watchers | inotify | FSEvents | ReadDirectoryChangesW |
| 0o600 permissions | ✓ | ✓ | ✗ (different ACL model) |
| /proc/pid/environ | ✓ | ✗ | ✗ |

**Windows is explicitly out of scope for phase 1** given the F5 XC tooling is primarily used on Linux/macOS developer workstations.

---

## 12. Recommended Architecture

Based on the analysis, the recommended architecture is a phased approach:

### Phase 1: Foundation (Startup Loading + Profile Command)

**Goal:** xcsh can use F5 XC profiles. Basic integration. No live switching.

**Implementation:**

1. **Add XDG path utilities** to `packages/utils/src/dirs.ts`:
   ```typescript
   export function getF5XCConfigDir(): string         // ~/.config/f5xc
   export function getF5XCProfilesDir(): string       // ~/.config/f5xc/profiles
   export function getF5XCActiveProfilePath(): string // ~/.config/f5xc/active_profile
   export function getF5XCProfilePath(name: string): string
   export function readF5XCActiveProfile(): Promise<Profile | null>
   ```

2. **Startup loading** in the session initialization chain:
   - After loading `.env` files, before creating the session
   - Only inject if `F5XC_API_URL` not already set
   - Inject into `bash.environment` settings override

3. **`xcsh profile` built-in command** in `packages/coding-agent/src/cli/commands/profile.ts`:
   - `list`, `activate`, `show`, `status` sub-commands
   - When `activate` runs: updates session env, writes `active_profile`
   - No create/delete in phase 1 (deferred to wizard)

4. **Profile status in xcsh UI**: Display current F5 XC profile name in the xcsh status bar or prompt prefix.

### Phase 2: Wizard + File Watcher

**Goal:** Full integration experience. AI can help set up profiles. Live profile switching works.

5. **Conversational setup wizard** as a skill file:
   - Triggers on first run or missing credentials
   - Guides AI through profile creation steps
   - Validates credentials before saving

6. **File watcher** for live profile switching:
   - Watch `~/.config/f5xc/active_profile`
   - Debounce: 500ms
   - On change: reload profile, update session env
   - Emit event: `f5xc:profile-changed` on session EventBus

### Phase 3: Enhanced Security + P12 Support

**Goal:** Production-grade credential security.

7. **Token masking**: Never display full tokens; always `...{last4chars}`
8. **Expiry warnings**: Check `profile.metadata.expiresAt` at startup
9. **P12 certificate support**: Handle password via OS keychain where available
10. **Prompt injection guard**: Hook that warns if sensitive file reads are attempted

---

## 13. Open Questions and Risks

### 13.1 Architectural Questions

**Q1: Should xcsh import f5xc-auth as a dependency, or re-implement the profile reading logic?**

The f5xc-auth library is a proper npm package. Importing it gives xcsh the full ProfileManager, HttpClient, and credential resolution logic. However, it adds a dependency and couples xcsh to the f5xc ecosystem. Alternatively, xcsh could implement a minimal standalone profile reader (just reads JSON + active_profile file) without the full library dependency.

**Recommendation for study:** Evaluate whether f5xc-auth is published to npm or git-only. If npm-published and stable, import it. If still in active development, re-implement the minimal reader.

**Q2: Should credentials live in xcsh's `bash.environment` settings (persisted to disk) or only in-memory overrides?**

Persisting to `~/.xcsh/agent/config.yml` means credentials survive across xcsh restarts but are now in two places (xcsh config and f5xc profile). In-memory only means each xcsh startup re-reads the active profile. In-memory is cleaner and avoids stale credential synchronization issues.

**Recommendation for study:** In-memory only. xcsh should always read from the canonical f5xc profile location.

**Q3: How should xcsh handle the case where `active_profile` points to a non-existent profile file?**

This can happen if a profile is deleted in one tool while another has it active. xcsh should:
- Warn the user clearly at startup
- Fall back to env vars if available
- Offer to list available profiles

**Q4: Should xcsh create the `~/.config/f5xc/` directory structure if it doesn't exist?**

Yes, on first access, but only the directories — never pre-create profile files or `active_profile`. The directory creation is idempotent and safe.

### 13.2 Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| f5xc-auth library breaking changes to profile JSON schema | Low | High | Re-implement minimal reader; version-pin if imported |
| File watcher not fired on all platforms | Medium | Medium | Poll fallback every 30s; document manual `/reload-profile` |
| AI accidentally outputs full API token | Medium | High | Token masking in all profile display paths |
| Profile file race condition (partial write) | Low | Medium | Atomic writes in producer tools; retry read if parse fails |
| Credential injection into AI context via prompt injection | Medium | High | Never auto-include profile credentials in system prompt |
| F5XC_* env vars conflict with other tools | Low | Low | Namespace is well-established; document any conflicts |
| P12 password management complexity | High | Medium | Phase 2 or 3; warn if P12 profile selected and no password source |

### 13.3 Design Decisions Deferred

These items require further discovery before a decision is warranted:

1. **Whether xcsh should be a "writer" of profiles** (full CRUD) or just a "reader" (consume existing profiles, create new ones only via wizard). The VS Code extension and prototype CLI are the primary profile managers today.

2. **Whether the xcsh skill system can support dynamic context injection** — if a skill could inspect `~/.config/f5xc/active_profile` at skill-load time and inject the active profile name into the system prompt, this would allow the AI to have live awareness of the auth context without any TypeScript changes.

3. **Whether a `XCSH_F5XC_PROFILE` environment variable override** (analogous to `AWS_PROFILE`) should be supported, allowing `XCSH_F5XC_PROFILE=staging xcsh` to force a specific profile without modifying `active_profile`.

4. **CI/CD integration**: In CI environments, `F5XC_API_URL` and `F5XC_API_TOKEN` are typically injected as secrets. xcsh's credential loading should transparently handle this case (already handled by the "env vars override profile" convention, but needs explicit testing).

---

## 14. References

### Internal Repositories

- **xcsh (current)**: `/workspace/xcsh` — AI agent shell being evaluated
  - Auth storage: `packages/ai/src/auth-storage.ts`
  - Env loading: `packages/utils/src/env.ts`
  - Dir utilities: `packages/utils/src/dirs.ts`
  - Settings: `packages/coding-agent/src/config/settings.ts`
  - Bash tool: `packages/coding-agent/src/tools/bash.ts`
  - XDG init command: `packages/coding-agent/src/cli/commands/init-xdg.ts`

- **f5xc-auth**: https://github.com/robinmordasiewicz/f5xc-auth
  - Profile manager: `src/profile/manager.ts`
  - Credential manager: `src/auth/credential-manager.ts`
  - HTTP client: `src/auth/http-client.ts`
  - XDG paths: `src/config/paths.ts`

- **vscode-f5xc-tools**: https://github.com/robinmordasiewicz/vscode-f5xc-tools
  - Profile manager: `src/config/profiles.ts`
  - XDG profiles: `src/config/xdgProfiles.ts`
  - Path config: `src/config/paths.ts`
  - Profile commands: `src/commands/profile.ts`
  - CRUD operations: `src/commands/crud.ts`

- **f5xc-xcsh (prototype)**: https://github.com/robinmordasiewicz/f5xc-xcsh
  - Profile manager: `src/profile/manager.ts`
  - Session manager: `src/repl/session.ts`
  - API client: `src/api/client.ts`
  - Env var registry: `src/config/envvars.ts`
  - Command executor: `src/repl/executor.ts`

### Standards

- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/)
- [XDG Base Directory — ArchWiki](https://wiki.archlinux.org/title/XDG_Base_Directory)

### F5 Distributed Cloud Documentation

- [F5 XC API Authentication](https://docs.cloud.f5.com/docs-v2/api/authentication)
- [F5 XC Credentials Management](https://docs.cloud.f5.com/docs/how-to/user-mgmt/credentials)
- [F5 XC API Token Schema](https://docs.cloud.f5.com/docs-v2/api/token)
- [F5 XC Services APIs Overview](https://docs.cloud.f5.com/docs-v2/platform/how-to/volt-automation/apis)

### Comparable CLI Auth Systems

- [AWS CLI Configuration Files](https://docs.aws.amazon.com/cli/v1/userguide/cli-configure-files.html)
- [AWS CLI Environment Variables](https://docs.aws.amazon.com/cli/v1/userguide/cli-configure-envvars.html)
- [kubectl kubeconfig](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/)
- [gcloud CLI Configurations](https://docs.cloud.google.com/sdk/docs/configurations)
- [GitHub CLI Authentication](https://cli.github.com/manual/gh_auth_login)

### Security References

- [OWASP AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
- [OpenSSF Security Guide for AI Code Assistants](https://best.openssf.org/Security-Focused-Guide-for-AI-Code-Assistant-Instructions.html)
- [NVIDIA: Sandboxing Agentic Workflows](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/)
- [Managing Credential Sprawl Across AI Coding Agents](https://www.knostic.ai/blog/credential-management-coding-agents)

### Cross-Tool Synchronization

- [fswatch — Cross-Platform File Monitor](https://github.com/emcrisostomo/fswatch)
- [inotify — Linux Kernel File Watcher](https://en.wikipedia.org/wiki/Inotify)
- [FSEvents — macOS File System Events](https://en.wikipedia.org/wiki/FSEvents)
- [VS Code IPC Socket Pattern](https://github.com/chvolkmann/code-connect)

---

*End of Feasibility Study — Discovery Phase*
