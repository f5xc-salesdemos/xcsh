# Software Requirements Specification
## F5 Distributed Cloud Multi-Profile Authentication for xcsh

**Document ID:** XCSH-SRS-AUTH-001
**Version:** 1.0
**Status:** Draft
**Date:** 2026-04-12
**Based on:** AUTHENTICATION-FEASABILITY-STUDY.md (v0.1)

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Overall Description](#2-overall-description)
3. [System Architecture](#3-system-architecture)
4. [Functional Requirements](#4-functional-requirements)
5. [Non-Functional Requirements](#5-non-functional-requirements)
6. [Interface Requirements](#6-interface-requirements)
7. [Data Requirements](#7-data-requirements)
8. [Phasing and Dependencies](#8-phasing-and-dependencies)
9. [Traceability Matrix](#9-traceability-matrix)
10. [Acceptance Criteria](#10-acceptance-criteria)

---

## 1. Introduction

### 1.1 Purpose

This Software Requirements Specification defines the requirements for integrating F5 Distributed Cloud (F5 XC) multi-profile XDG-based authentication into the xcsh AI agent shell. The integration enables xcsh to participate as a first-class citizen in the existing F5 XC tooling ecosystem alongside the vscode-f5xc-tools VS Code extension and the f5xc-xcsh prototype CLI.

This document translates the findings from the Authentication Feasibility Study into precise, implementable, and testable requirements.

### 1.2 Scope

**In scope:**
- Reading and applying F5 XC authentication profiles stored at `~/.config/f5xc/`
- Built-in CLI command for profile management (`xcsh profile`)
- Environment variable injection into the bash tool's execution context
- Status bar display of the active F5 XC profile
- AI-guided setup wizard for first-run profile creation (skill-based)
- File system watcher for live cross-tool profile synchronization
- API token authentication method

**Out of scope (this version):**
- P12 certificate and cert/key authentication (deferred to future SRS)
- OAuth/OIDC federation with F5 XC identity providers
- Windows platform support
- Credential encryption at rest beyond filesystem permissions
- Multi-user or shared system configurations
- xcsh acting as a producer/publisher of the f5xc-auth npm library

### 1.3 Definitions and Acronyms

| Term | Definition |
|------|-----------|
| **Profile** | A named set of F5 XC credentials and configuration (tenant URL, API token, namespace) stored as a JSON file |
| **Active profile** | The profile currently selected for use, indicated by the content of `~/.config/f5xc/active_profile` |
| **XDG** | X Desktop Group Base Directory Specification — defines standard locations for user configuration, data, and state files |
| **F5 XC** | F5 Distributed Cloud Services — the cloud platform requiring authenticated API access |
| **Tenant** | An isolated F5 XC environment identified by a unique subdomain (e.g., `acme.console.ves.volterra.io`) |
| **Namespace** | A logical partition within an F5 XC tenant for resource isolation |
| **Credential precedence** | The ecosystem convention: environment variables override profile values override defaults |
| **bash.environment** | An xcsh settings key that injects environment variables into every bash tool invocation |
| **Skill** | A Markdown file (`SKILL.md`) with YAML frontmatter that injects knowledge and guidance into the AI's system prompt |

### 1.4 References

| ID | Document | Location |
|----|----------|----------|
| REF-01 | Authentication Feasibility Study | `/workspace/xcsh/AUTHENTICATION-FEASABILITY-STUDY.md` |
| REF-02 | f5xc-auth library | https://github.com/robinmordasiewicz/f5xc-auth |
| REF-03 | vscode-f5xc-tools extension | https://github.com/robinmordasiewicz/vscode-f5xc-tools |
| REF-04 | f5xc-xcsh prototype CLI | https://github.com/robinmordasiewicz/f5xc-xcsh |
| REF-05 | XDG Base Directory Specification | https://specifications.freedesktop.org/basedir/latest/ |
| REF-06 | F5 XC API Authentication | https://docs.cloud.f5.com/docs-v2/api/authentication |
| REF-07 | xcsh settings system | `packages/coding-agent/src/config/settings.ts` |
| REF-08 | xcsh bash tool | `packages/coding-agent/src/tools/bash.ts` |
| REF-09 | xcsh CLI commands | `packages/coding-agent/src/cli/commands/` |
| REF-10 | xcsh EventBus | `packages/coding-agent/src/utils/event-bus.ts` |
| REF-11 | xcsh status line | `packages/coding-agent/src/modes/components/status-line.ts` |
| REF-12 | xcsh env loading | `packages/utils/src/env.ts` |
| REF-13 | xcsh dir utilities | `packages/utils/src/dirs.ts` |
| REF-14 | xcsh XDG init command | `packages/coding-agent/src/cli/commands/init-xdg.ts` |

---

## 2. Overall Description

### 2.1 Product Perspective

xcsh is an AI-powered agent shell that executes commands, edits files, and interacts with APIs on behalf of the user. It currently authenticates to AI model providers (Anthropic, OpenAI, etc.) via its own credential store (`~/.xcsh/agent/agent.db`). This SRS adds a parallel authentication capability for F5 Distributed Cloud APIs.

The F5 XC ecosystem already has a shared authentication model:

```
┌──────────────┐    ┌──────────────────┐    ┌────────────────┐
│  f5xc-auth   │    │ vscode-f5xc-tools│    │  f5xc-xcsh     │
│  (library)   │    │ (VS Code ext.)   │    │  (prototype)   │
└──────┬───────┘    └────────┬─────────┘    └───────┬────────┘
       │                     │                      │
       └─────────────────────┼──────────────────────┘
                             ↓
              ~/.config/f5xc/active_profile
              ~/.config/f5xc/profiles/<name>.json
```

xcsh joins this ecosystem as a **consumer** of the shared profile store — reading the same files, respecting the same credential precedence, and signaling profile changes via the same `active_profile` file.

### 2.2 User Characteristics

| User Type | Description | Relevant Needs |
|-----------|-------------|----------------|
| **F5 XC Platform Engineer** | Uses xcsh to manage F5 XC resources via API | Needs profile loading and switching to work against correct tenant |
| **Multi-Tenant Operator** | Manages multiple F5 XC tenants (production, staging, dev) | Needs fast profile switching and clear indication of active tenant |
| **First-Time User** | New to F5 XC tooling, no profiles configured | Needs guided setup wizard to create first profile |
| **VS Code User** | Runs xcsh in a terminal while vscode-f5xc-tools is active | Needs cross-tool profile synchronization |

### 2.3 Constraints

| ID | Constraint | Source |
|----|-----------|--------|
| CON-01 | xcsh runs on Bun.js runtime, not Node.js. All APIs must be Bun-compatible. | Codebase verification |
| CON-02 | Profile JSON files are owned by the f5xc-auth library's schema. xcsh must not introduce incompatible fields. | REF-02 |
| CON-03 | The `active_profile` file format is a plain text file containing only the profile name (no newline, no JSON). | REF-01 §3.1 |
| CON-04 | Environment variables always override profile credentials (ecosystem convention). | REF-01 §3.1 |
| CON-05 | `bash.environment` does not currently exist in xcsh's settings schema. It must be added before environment injection can work. | Codebase verification |
| CON-06 | Skills inject markdown into the AI system prompt. They cannot mutate the xcsh process environment or session state. | Codebase verification |
| CON-07 | The bash tool currently supports only per-call `env` overrides; session-level persistent injection does not exist yet. | Codebase verification |
| CON-08 | Platform support is Linux and macOS only. | REF-01 §2.3 |

### 2.4 Assumptions

| ID | Assumption |
|----|-----------|
| ASM-01 | The f5xc-auth profile JSON schema (name, apiUrl, apiToken, defaultNamespace, metadata) is stable and will not change without notice. |
| ASM-02 | The `~/.config/f5xc/` directory structure follows XDG conventions and uses `$XDG_CONFIG_HOME/f5xc/` when `XDG_CONFIG_HOME` is set. |
| ASM-03 | Profile JSON files have `0o600` permissions and the profiles directory has `0o700` permissions. |
| ASM-04 | Only one profile is active at a time across all tools. |
| ASM-05 | API token authentication is the primary method; P12/cert support will be addressed in a future SRS. |
| ASM-06 | Bun's `fs.watch()` implementation provides adequate file change notification on both Linux and macOS. |

---

## 3. System Architecture

### 3.1 Component Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            xcsh Agent Session                           │
│                                                                         │
│  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────────────┐  │
│  │ ProfileService   │  │ ProfileCommand   │  │ SetupWizardSkill     │  │
│  │ (new module)     │  │ (new CLI cmd)    │  │ (SKILL.md)           │  │
│  │                  │  │                  │  │                       │  │
│  │ - loadActive()   │  │ - list           │  │ - First-run guidance  │  │
│  │ - activate()     │  │ - activate       │  │ - Profile creation    │  │
│  │ - getStatus()    │  │ - show           │  │   walkthrough         │  │
│  │ - watchChanges() │  │ - status         │  │ - Error recovery      │  │
│  └────────┬────────┘  └────────┬─────────┘  └───────────────────────┘  │
│           │                    │                                         │
│           └──────────┬─────────┘                                         │
│                      ↓                                                   │
│  ┌──────────────────────────────────────┐  ┌─────────────────────────┐  │
│  │ Settings Override                    │  │ EventBus                │  │
│  │ bash.environment: {                  │  │                         │  │
│  │   F5XC_API_URL: "https://..."        │  │ "f5xc:profile-changed" │  │
│  │   F5XC_API_TOKEN: "..."              │  │ "f5xc:profile-error"   │  │
│  │   F5XC_NAMESPACE: "default"          │  │                         │  │
│  │ }                                    │  └─────────────────────────┘  │
│  └──────────────────┬───────────────────┘                                │
│                     ↓                                                    │
│  ┌──────────────────────────────────────┐  ┌─────────────────────────┐  │
│  │ Bash Tool                            │  │ Status Line             │  │
│  │ (inherits bash.environment)          │  │ [profile.f5xc] segment  │  │
│  │                                      │  │ "production"            │  │
│  └──────────────────────────────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                    ↕ reads/writes
┌─────────────────────────────────────────────────────────────────────────┐
│                        ~/.config/f5xc/                                  │
│  active_profile       profiles/production.json    profiles/staging.json │
└─────────────────────────────────────────────────────────────────────────┘
                    ↕                                    ↕
┌────────────────────────┐                ┌──────────────────────────────┐
│ vscode-f5xc-tools      │                │ f5xc-xcsh / other tools      │
└────────────────────────┘                └──────────────────────────────┘
```

### 3.2 New Modules

| Module | Type | Location | Purpose |
|--------|------|----------|---------|
| **ProfileService** | TypeScript class | `packages/coding-agent/src/services/f5xc-profile.ts` | Reads/writes profiles, manages active state, watches for changes |
| **ProfileCommand** | CLI command | `packages/coding-agent/src/cli/commands/profile.ts` | User-facing `xcsh profile` subcommands |
| **bash.environment schema** | Settings schema entry | `packages/coding-agent/src/config/settings-schema.ts` | Declares the `bash.environment` setting with `Record<string, string>` type |
| **Bash env injection** | Bash tool extension | `packages/coding-agent/src/tools/bash.ts` | Reads `bash.environment` from settings and merges into subprocess env |
| **F5XC status segment** | Status line segment | `packages/coding-agent/src/modes/components/status-line/segments.ts` | Renders active profile name in status bar |
| **Setup wizard skill** | SKILL.md file | `~/.xcsh/agent/skills/f5xc-setup-wizard.md` (user-level) | AI conversational guidance for profile creation |
| **F5XC XDG path helpers** | Utility functions | `packages/utils/src/dirs.ts` | `getF5XCConfigDir()`, `getF5XCProfilesDir()`, etc. |

### 3.3 Modified Modules

| Module | File | Change |
|--------|------|--------|
| **Settings schema** | `packages/coding-agent/src/config/settings-schema.ts` | Add `bash.environment` and `statusLine` segment ID |
| **Bash tool** | `packages/coding-agent/src/tools/bash.ts` | Read `bash.environment` settings and merge into subprocess execution |
| **Startup sequence** | `packages/coding-agent/src/main.ts` | Insert profile loading after settings init |
| **Dir utilities** | `packages/utils/src/dirs.ts` | Add F5 XC XDG path helper functions |
| **Status line** | `packages/coding-agent/src/modes/components/status-line.ts` | Register `profile.f5xc` segment renderer |

---

## 4. Functional Requirements

### 4.1 Profile Loading (FR-1xx)

#### FR-101: Startup Profile Detection

**Description:** On startup, xcsh shall check for an active F5 XC profile by reading the file at `$XDG_CONFIG_HOME/f5xc/active_profile` (defaulting to `~/.config/f5xc/active_profile`).

**Priority:** P0 (Phase 1)

**Behavior:**
1. If the `active_profile` file exists and is non-empty, read the profile name from it.
2. If the named profile JSON exists at `~/.config/f5xc/profiles/<name>.json`, parse it.
3. If the JSON is valid, extract `apiUrl`, `apiToken`, and `defaultNamespace`.
4. If any step fails (file missing, parse error, missing fields), log a warning and continue startup without F5 XC credentials.

**Precondition:** Settings system is initialized (after `Settings.init()` in `main.ts`).

---

#### FR-102: Credential Precedence

**Description:** xcsh shall respect the ecosystem credential precedence convention: environment variables override profile values.

**Priority:** P0 (Phase 1)

**Behavior:**
1. Before loading the active profile, check if `F5XC_API_URL` is already set in `process.env`.
2. If `F5XC_API_URL` is set, skip profile loading entirely — the user or CI system has provided explicit credentials.
3. If `F5XC_API_URL` is not set, proceed with profile loading.
4. Individual profile fields may also be overridden: if `F5XC_API_TOKEN` is set in the environment but `F5XC_API_URL` is not, the profile's `apiUrl` is used but the environment's token takes precedence.

**Rationale:** Matches the behavior of f5xc-auth `CredentialManager` (REF-01 §3.1) and ensures CI/CD pipelines that inject `F5XC_*` variables work without profile interference.

---

#### FR-103: Environment Variable Injection

**Description:** When a profile is loaded, xcsh shall inject the profile's credentials into the session's `bash.environment` settings override so that all subsequent bash tool invocations inherit the correct `F5XC_*` variables.

**Priority:** P0 (Phase 1)

**Behavior:**
1. Call `settings.override("bash.environment", envMap)` where `envMap` is:
   ```
   {
     F5XC_API_URL: profile.apiUrl,
     F5XC_API_TOKEN: profile.apiToken,
     F5XC_NAMESPACE: profile.defaultNamespace ?? "default"
   }
   ```
2. This override is **in-memory only** — it is not persisted to `~/.xcsh/agent/config.yml`.
3. Each xcsh startup re-reads the canonical profile from `~/.config/f5xc/`.

**Rationale:** In-memory-only avoids stale credential duplication between xcsh config and f5xc profile storage (REF-01 §13.1, Q2).

---

#### FR-104: Auto-Activate Single Profile

**Description:** If no `active_profile` file exists but exactly one profile JSON file exists in `~/.config/f5xc/profiles/`, xcsh shall auto-activate that profile.

**Priority:** P1 (Phase 1)

**Behavior:**
1. List files matching `~/.config/f5xc/profiles/*.json`.
2. If exactly one file is found, read it and apply its credentials.
3. Write the profile name to `~/.config/f5xc/active_profile` so other tools see the activation.
4. Log an informational message: `"Auto-activated F5 XC profile: <name>"`.
5. If zero or more than one profile exists, take no action.

**Rationale:** Matches the f5xc-xcsh prototype behavior (REF-01 §3.3).

---

#### FR-105: Graceful Handling of Missing/Invalid Profiles

**Description:** xcsh shall not fail or block startup if F5 XC profile loading encounters any error condition.

**Priority:** P0 (Phase 1)

**Behavior:**
- Missing `~/.config/f5xc/` directory: silently skip.
- Missing `active_profile` file: silently skip.
- `active_profile` references a non-existent profile JSON: log warning, skip.
- Profile JSON fails to parse: log warning, skip.
- Profile JSON missing `apiUrl` or `apiToken`: log warning, skip.

**Rationale:** F5 XC authentication is optional functionality. xcsh must remain fully operational for non-F5-XC workflows.

---

### 4.2 Profile Command (FR-2xx)

#### FR-201: `xcsh profile list`

**Description:** Display all available F5 XC profiles with the active profile indicated.

**Priority:** P0 (Phase 1)

**Output format:**
```
  dev          https://dev.console.ves.volterra.io
* production   https://production.console.ves.volterra.io
  staging      https://staging.console.ves.volterra.io
```

**Behavior:**
1. Read all `*.json` files from `~/.config/f5xc/profiles/`.
2. For each file, parse and extract `name` and `apiUrl`.
3. Read `active_profile` to determine which is active (prefix with `*`).
4. Sort alphabetically by name.
5. If no profiles exist, print: `"No F5 XC profiles found. Use 'xcsh profile create' or ask me to help set one up."`.

---

#### FR-202: `xcsh profile activate <name>`

**Description:** Switch the active F5 XC profile and update the session's environment variables.

**Priority:** P0 (Phase 1)

**Behavior:**
1. Validate that `~/.config/f5xc/profiles/<name>.json` exists.
2. Parse the profile JSON.
3. Write `<name>` (no newline) to `~/.config/f5xc/active_profile`.
4. Call `settings.override("bash.environment", {...})` with the new profile's credentials.
5. Emit `f5xc:profile-changed` event on the session EventBus.
6. Print: `"Switched to F5 XC profile: <name> (<tenant_url>)"`.

**Error handling:**
- Profile not found: `"Profile '<name>' not found. Run 'xcsh profile list' to see available profiles."`.
- Parse error: `"Profile '<name>' exists but contains invalid JSON."`.

---

#### FR-203: `xcsh profile show [name]`

**Description:** Display the details of a profile with sensitive fields masked.

**Priority:** P1 (Phase 1)

**Output format:**
```
Profile: production
  API URL:    https://production.console.ves.volterra.io
  API Token:  ...a4f2
  Namespace:  default
  Created:    2026-03-15
  Expires:    2027-03-15
```

**Behavior:**
1. If `name` is omitted, show the active profile.
2. Read the profile JSON.
3. Mask `apiToken`: display only `...` + last 4 characters.
4. Display `metadata.createdAt` and `metadata.expiresAt` if present.
5. Never display the full token value under any circumstance.

---

#### FR-204: `xcsh profile status`

**Description:** Display the current authentication status including credential source, connection state, and active profile name.

**Priority:** P1 (Phase 1)

**Output format:**
```
F5 XC Authentication Status
  Profile:     production
  Source:      profile (env vars not set)
  API URL:     https://production.console.ves.volterra.io
  Namespace:   default
  Token:       ...a4f2
  Connection:  connected
```

**Behavior:**
1. Read the current in-memory credential state.
2. Determine source: `"profile"`, `"environment"`, `"mixed"`, or `"none"`.
3. Optionally validate the token (HEAD request to `/api/web/namespaces` with 3s timeout, no retries).
4. Report connection status: `"connected"`, `"offline"`, `"auth_error"`, `"not configured"`.

---

#### FR-205: `xcsh profile create`

**Description:** Create a new F5 XC profile interactively or via flags.

**Priority:** P1 (Phase 2)

**Interactive mode:**
1. Prompt for profile name. Validate: alphanumeric + dashes/underscores, max 64 characters, unique.
2. Prompt for API URL. Validate: HTTPS URL, parseable hostname.
3. Prompt for API token.
4. Prompt for default namespace (default: `"default"`).
5. Optionally validate credentials (HEAD to `/api/web/namespaces`, 3s timeout).
6. Save profile JSON to `~/.config/f5xc/profiles/<name>.json` with `0o600` permissions.
7. Ensure the profiles directory has `0o700` permissions.
8. Ask whether to activate the new profile.

**Flag mode:**
```
xcsh profile create --name prod --url https://prod.console.ves.volterra.io --token <token> --namespace default --activate
```

---

#### FR-206: `xcsh profile delete <name>`

**Description:** Delete an F5 XC profile.

**Priority:** P2 (Phase 2)

**Behavior:**
1. Validate the profile exists.
2. Prevent deletion of the currently active profile: `"Cannot delete the active profile. Activate a different profile first."`.
3. Require confirmation: `"Delete profile '<name>'? This cannot be undone. [y/N]"`.
4. Remove `~/.config/f5xc/profiles/<name>.json`.

---

### 4.3 Settings Schema Extension (FR-3xx)

#### FR-301: Add `bash.environment` to Settings Schema

**Description:** Register `bash.environment` as a recognized setting in xcsh's settings schema.

**Priority:** P0 (Phase 1)

**Schema definition:**
```typescript
"bash.environment": {
  type: "object",
  additionalProperties: { type: "string" },
  default: {},
  description: "Environment variables injected into every bash tool invocation"
}
```

**File:** `packages/coding-agent/src/config/settings-schema.ts`

---

#### FR-302: Bash Tool Reads `bash.environment`

**Description:** The bash tool shall read `settings.get("bash.environment")` and merge the result into the subprocess environment for every command execution.

**Priority:** P0 (Phase 1)

**Behavior:**
1. Before executing a bash command, read `settings.get("bash.environment")`.
2. Merge the result with the existing process environment.
3. Per-call `env` overrides (from the AI's tool call) take precedence over `bash.environment`.
4. Merge order: `process.env` < `bash.environment` < per-call `env`.

**File:** `packages/coding-agent/src/tools/bash.ts`

---

### 4.4 Status Display (FR-4xx)

#### FR-401: Profile Status Bar Segment

**Description:** xcsh shall display the active F5 XC profile name in the status bar.

**Priority:** P1 (Phase 1)

**Behavior:**
1. Register a new status line segment with ID `"profile.f5xc"`.
2. The segment renders the active profile name (e.g., `"f5xc:production"`).
3. If no profile is active, the segment renders nothing (hidden).
4. The segment updates when a `f5xc:profile-changed` event is emitted on the EventBus.

**File:** `packages/coding-agent/src/modes/components/status-line/segments.ts`

---

#### FR-402: Stale Profile Warning

**Description:** If the on-disk `active_profile` differs from the in-memory loaded profile, xcsh shall display a visual indicator.

**Priority:** P2 (Phase 2)

**Behavior:**
1. When the file watcher detects a change (FR-601), compare the new profile name to the loaded profile.
2. If different, append a warning indicator to the status segment (e.g., `"f5xc:production [stale]"`).
3. The warning clears when the profile is reloaded (either automatically via watcher or manually via `xcsh profile activate`).

---

### 4.5 Setup Wizard (FR-5xx)

#### FR-501: First-Run Detection

**Description:** When xcsh starts with no active profile and no `F5XC_*` environment variables, and the setup wizard skill is installed, the AI shall be aware that F5 XC authentication is not configured.

**Priority:** P1 (Phase 2)

**Behavior:**
1. During startup, if profile loading finds no credentials (no active profile, no env vars, no profile files), set an internal flag: `f5xcAuthConfigured = false`.
2. The setup wizard skill includes an `alwaysApply: true` frontmatter directive so it is always present in the system prompt.
3. The skill content instructs the AI: "If `f5xcAuthConfigured` is false and the user asks about F5 XC operations, offer to help set up authentication."

**Note:** The skill cannot detect the flag directly. The mechanism is: the ProfileService writes a brief status summary into the skill context at load time (e.g., via a dynamic skill or a status injection into the system prompt).

---

#### FR-502: Conversational Wizard Flow

**Description:** The setup wizard skill shall guide the AI through the profile creation steps defined in the feasibility study (REF-01 §9.2).

**Priority:** P1 (Phase 2)

**Steps the skill shall document:**
1. Explain what F5 XC profiles are and why they're needed.
2. Collect profile name (validate: alphanumeric + dashes/underscores, max 64 chars).
3. Collect tenant API URL (validate: HTTPS, `.console.ves.volterra.io` suffix or custom).
4. Collect API token (instruct: Personal Management → Credentials → Add Credentials → API Token).
5. Collect default namespace (default: `"default"`).
6. Validate credentials by running a bash command: `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: APIToken <token>" <url>/api/web/namespaces` (3s timeout).
7. Save profile via `xcsh profile create` command.
8. Activate the profile via `xcsh profile activate <name>`.

**Critical constraint:** The skill teaches the AI to use the `xcsh profile create` command (FR-205) rather than writing JSON files directly. This ensures proper validation, permissions, and file format compliance.

---

#### FR-503: Error Recovery Guidance

**Description:** The setup wizard skill shall include guidance for common error scenarios.

**Priority:** P2 (Phase 2)

**Scenarios:**
- Token validation fails (401): "The token was rejected. Check that it hasn't expired and that it was copied completely."
- API unreachable (timeout): "I can't reach the F5 XC API. Check the URL and your network connection. You can save the profile anyway and validate later."
- Invalid URL format: "The URL should look like `https://<tenant>.console.ves.volterra.io`. Make sure it starts with https://."
- Profile already exists: "A profile with that name already exists. Would you like to update it or choose a different name?"

---

### 4.6 File Watcher (FR-6xx)

#### FR-601: Active Profile File Watcher

**Description:** xcsh shall watch `~/.config/f5xc/active_profile` for changes and reload credentials when the file is modified by an external tool.

**Priority:** P1 (Phase 2)

**Behavior:**
1. After session creation, start a file watcher on `~/.config/f5xc/active_profile` using `fs.watch()`.
2. Set `persistent: false` so the watcher does not prevent process exit.
3. Debounce change events by 500ms to prevent credential thrashing on rapid writes.
4. On change: read the new profile name, load the profile JSON, update `bash.environment` override.
5. Emit `f5xc:profile-changed` event on the EventBus with the new profile name.
6. On session exit: close the watcher via `watcher.close()`.

**Error handling:**
- File deleted: log warning, clear F5XC credentials from `bash.environment`, emit `f5xc:profile-error`.
- New profile name references non-existent JSON: log warning, keep existing credentials, emit `f5xc:profile-error`.
- JSON parse failure: log warning, keep existing credentials, emit `f5xc:profile-error`.
- `fs.watch()` stops firing (platform edge case): no mitigation in this phase. Document as a known limitation.

---

#### FR-602: File Watcher Lifecycle

**Description:** The file watcher shall be created and destroyed as part of the agent session lifecycle.

**Priority:** P1 (Phase 2)

**Behavior:**
1. Watcher is created during `AgentSession` initialization, after initial profile loading.
2. Watcher is destroyed when the session is disposed.
3. If the `active_profile` file does not exist at startup, the watcher is not created. Profile creation (FR-205) or external activation will not be detected until xcsh restart.

**Rationale:** Watching a non-existent file path has undefined behavior across platforms. Better to require the file to exist.

---

### 4.7 Profile CRUD File Operations (FR-7xx)

#### FR-701: Profile Directory Initialization

**Description:** When xcsh needs to write a profile (FR-205) and the `~/.config/f5xc/profiles/` directory does not exist, xcsh shall create it.

**Priority:** P1 (Phase 2)

**Behavior:**
1. Create `~/.config/f5xc/` with mode `0o700` (owner-only access).
2. Create `~/.config/f5xc/profiles/` with mode `0o700`.
3. Respect `$XDG_CONFIG_HOME` if set: use `$XDG_CONFIG_HOME/f5xc/` instead of `~/.config/f5xc/`.
4. Use `{ recursive: true }` to handle partial directory existence.
5. Never create `active_profile` or any profile JSON files during directory initialization.

---

#### FR-702: Profile File Write

**Description:** When creating or updating a profile, xcsh shall write the profile JSON file atomically with correct permissions.

**Priority:** P1 (Phase 2)

**Behavior:**
1. Serialize the profile object to JSON with 2-space indentation.
2. Write to a temporary file in the same directory (e.g., `<name>.json.tmp`).
3. Set permissions on the temp file to `0o600`.
4. Rename the temp file to the final name (atomic on POSIX systems).

**Rationale:** Atomic writes prevent other tools from reading a partially-written profile JSON (REF-01 §13.2 risk: "Profile file race condition").

---

#### FR-703: Active Profile Write

**Description:** When activating a profile, xcsh shall write the profile name to `~/.config/f5xc/active_profile`.

**Priority:** P0 (Phase 1)

**Behavior:**
1. Write the profile name as plain text, no trailing newline.
2. Use the same atomic write pattern as FR-702.
3. The file is owned by the user with default permissions (not restricted to `0o600` — it contains only a profile name, not credentials).

---

## 5. Non-Functional Requirements

### 5.1 Security (NFR-1xx)

#### NFR-101: Token Masking

**Description:** xcsh shall never display a full API token in any output, log, or AI context.

**Priority:** P0 (All phases)

**Requirements:**
1. When displaying a token to the user (FR-203, FR-204), show only `...` + last 4 characters.
2. When logging token-related events, never include the token value — log the profile name only.
3. The setup wizard skill (FR-502) shall instruct the AI to never echo back a token in full.

---

#### NFR-102: File Permission Enforcement

**Description:** All profile files written by xcsh shall have owner-only permissions.

**Priority:** P0 (All phases)

**Requirements:**
1. Profile JSON files: mode `0o600` (read/write for owner only).
2. Profiles directory: mode `0o700` (read/write/execute for owner only).
3. Config directory (`~/.config/f5xc/`): mode `0o700`.

---

#### NFR-103: Credential Isolation from AI Context

**Description:** Raw credential files shall not be included in the AI's reading context.

**Priority:** P0 (All phases)

**Requirements:**
1. The ProfileService reads and parses profile JSON files internally. The raw JSON content is never returned to the AI model.
2. When the AI needs profile information (e.g., for `xcsh profile show`), only the masked representation is surfaced.
3. The skill system shall not include profile file contents via `alwaysApply` or automatic inclusion.

---

#### NFR-104: Prompt Injection Mitigation

**Description:** xcsh shall guard against prompt injection attacks that attempt to exfiltrate credentials.

**Priority:** P1 (Phase 2)

**Requirements:**
1. The setup wizard skill shall instruct the AI to never run commands like `cat ~/.config/f5xc/profiles/*.json` in response to user requests.
2. Consider registering a hook (via xcsh's hook system) that warns if a bash command reads from `~/.config/f5xc/profiles/`.
3. Document this risk in xcsh user documentation.

---

### 5.2 Compatibility (NFR-2xx)

#### NFR-201: Cross-Tool Profile Compatibility

**Description:** Profiles created, activated, or modified by xcsh shall be readable by vscode-f5xc-tools and f5xc-xcsh, and vice versa.

**Priority:** P0 (All phases)

**Requirements:**
1. xcsh shall read and write profile JSON files using the schema defined by f5xc-auth (REF-02).
2. xcsh shall not add xcsh-specific fields to profile JSON files.
3. xcsh shall not modify fields it does not understand (preserve unknown keys on write).
4. The `active_profile` file written by xcsh shall be readable by vscode-f5xc-tools' file watcher.

---

#### NFR-202: XDG Compliance

**Description:** All F5 XC configuration paths shall respect the XDG Base Directory Specification.

**Priority:** P0 (All phases)

**Requirements:**
1. When `$XDG_CONFIG_HOME` is set, use `$XDG_CONFIG_HOME/f5xc/` instead of `~/.config/f5xc/`.
2. When `$XDG_CONFIG_HOME` is not set, default to `~/.config/f5xc/`.
3. No dot-prefix on subdirectories under `$XDG_CONFIG_HOME` (use `f5xc/`, not `.f5xc/`).

---

#### NFR-203: Backward Compatibility with xcsh

**Description:** The authentication feature shall not break existing xcsh functionality.

**Priority:** P0 (All phases)

**Requirements:**
1. If no F5 XC profiles exist and no `F5XC_*` environment variables are set, xcsh shall behave identically to the pre-integration version.
2. The `bash.environment` settings key shall default to an empty object `{}`.
3. All new modules shall be lazy-loaded or guarded so they add zero overhead when F5 XC is not configured.

---

### 5.3 Performance (NFR-3xx)

#### NFR-301: Startup Overhead

**Description:** Profile loading shall add minimal latency to xcsh startup.

**Priority:** P1 (Phase 1)

**Requirements:**
1. Profile loading (read `active_profile` + parse one JSON file) shall complete in under 10ms on local filesystem.
2. No network requests during startup profile loading. Token validation is deferred to explicit `xcsh profile status` calls or wizard flows.
3. If profile loading fails for any reason, it shall fail fast (no retries, no timeouts).

---

#### NFR-302: File Watcher Overhead

**Description:** The file watcher shall not measurably impact xcsh's runtime performance.

**Priority:** P1 (Phase 2)

**Requirements:**
1. The watcher shall use `persistent: false` so it does not prevent the process from exiting.
2. The debounce interval (500ms) ensures at most 2 profile reloads per second.
3. Profile reload (read + parse + settings override) shall complete in under 10ms.

---

### 5.4 Reliability (NFR-4xx)

#### NFR-401: Crash Isolation

**Description:** No error in the F5 XC profile subsystem shall crash xcsh or prevent it from starting.

**Priority:** P0 (All phases)

**Requirements:**
1. All profile operations (read, parse, watch) shall be wrapped in try/catch.
2. Errors shall be logged at `warn` level (not `error`) since F5 XC auth is optional functionality.
3. The file watcher shall handle `ENOENT`, `EACCES`, and `EPERM` errors gracefully.

---

#### NFR-402: Atomic State Transitions

**Description:** Profile activation shall be an atomic operation — either fully complete or fully rolled back.

**Priority:** P1 (Phase 1)

**Requirements:**
1. When `xcsh profile activate` succeeds: both the in-memory `bash.environment` and the on-disk `active_profile` are updated.
2. If writing `active_profile` fails: do not update `bash.environment`. Report error.
3. If reading the new profile JSON fails: do not write `active_profile`. Report error.

---

## 6. Interface Requirements

### 6.1 File System Interfaces (IR-1xx)

#### IR-101: Profile JSON File Format

**Description:** xcsh shall read and write profile JSON files conforming to the f5xc-auth schema.

**File path:** `$XDG_CONFIG_HOME/f5xc/profiles/<name>.json` (default: `~/.config/f5xc/profiles/<name>.json`)

**Schema (read):**
```json
{
  "name": "production",
  "apiUrl": "https://production.console.ves.volterra.io",
  "apiToken": "xxxxxxxxxxxxxxxx",
  "defaultNamespace": "default",
  "tlsInsecure": false,
  "caBundle": null,
  "metadata": {
    "createdAt": "2026-03-15T10:00:00Z",
    "lastRotatedAt": null,
    "expiresAt": "2027-03-15T10:00:00Z",
    "rotateAfterDays": 90
  }
}
```

**Required fields for xcsh (minimum viable read):**
- `name` (string)
- `apiUrl` (string)
- `apiToken` (string)

**Optional fields:**
- `defaultNamespace` (string, default: `"default"`)
- `metadata` (object, informational)
- All other fields: preserve on write, ignore on read.

---

#### IR-102: Active Profile File Format

**Description:** The active profile indicator file contains only the profile name as plain text.

**File path:** `$XDG_CONFIG_HOME/f5xc/active_profile` (default: `~/.config/f5xc/active_profile`)

**Format:** UTF-8 encoded profile name with no trailing newline, no JSON wrapper, no whitespace.

**Example content:** `production`

---

### 6.2 Cross-Tool Interfaces (IR-2xx)

#### IR-201: Profile Activation Signal

**Description:** When xcsh activates a profile, it writes the profile name to `active_profile`, which other tools detect via their own file watchers.

**Contract:**
1. xcsh writes: `echo -n "<name>" > ~/.config/f5xc/active_profile` (atomic).
2. vscode-f5xc-tools detects: its `fs.watch()` callback fires, clears caches, refreshes UI.
3. f5xc-xcsh detects: on next command, re-reads active profile.

No additional IPC protocol, socket, or message format is required.

---

#### IR-202: Environment Variable Interface

**Description:** The following environment variables constitute the F5 XC authentication contract.

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `F5XC_API_URL` | string | Yes | Tenant API URL (e.g., `https://prod.console.ves.volterra.io`) |
| `F5XC_API_TOKEN` | string | Yes | API authentication token |
| `F5XC_NAMESPACE` | string | No | Default namespace (default: `"default"`) |
| `F5XC_PROTOCOL` | string | No | Protocol override (default: `"https"`) |
| `F5XC_CA_BUNDLE` | string | No | Path to custom CA certificate file |
| `F5XC_TLS_INSECURE` | string | No | `"true"` to disable TLS verification |

xcsh maps profile fields to these variables:
- `profile.apiUrl` → `F5XC_API_URL`
- `profile.apiToken` → `F5XC_API_TOKEN`
- `profile.defaultNamespace` → `F5XC_NAMESPACE`

---

### 6.3 Internal Interfaces (IR-3xx)

#### IR-301: Settings Override API

**Description:** The ProfileService uses xcsh's existing `Settings.override()` API to inject credentials.

**API:**
```typescript
settings.override("bash.environment", {
  F5XC_API_URL: string,
  F5XC_API_TOKEN: string,
  F5XC_NAMESPACE: string,
})
```

**Verified behavior:**
- `override()` accepts dot-notation paths (verified in `settings.ts` line 221).
- Uses `setByPath()` for recursive nested object assignment.
- Triggers `#rebuildMerged()` to incorporate overrides into the active settings.
- Overrides are in-memory only — not persisted to disk.

---

#### IR-302: EventBus API

**Description:** The ProfileService emits events on the session EventBus to notify other components of profile changes.

**Events:**

| Channel | Payload | Emitted When |
|---------|---------|--------------|
| `f5xc:profile-changed` | `{ name: string, apiUrl: string }` | Profile successfully activated or reloaded |
| `f5xc:profile-error` | `{ error: string, profileName?: string }` | Profile load/watch error |

**API:**
```typescript
// Emit
session.eventBus.emit("f5xc:profile-changed", { name: "production", apiUrl: "https://..." })

// Subscribe (returns unsubscribe function)
const unsub = session.eventBus.on("f5xc:profile-changed", (data) => { ... })
```

**Verified:** EventBus is a generic `Map<string, Set<...>>` that supports arbitrary channel names (verified in `event-bus.ts`).

---

#### IR-303: Bash Tool Environment Merge

**Description:** The bash tool shall merge environment variables from three sources in order of precedence.

**Merge order (lowest to highest precedence):**
1. `process.env` — inherited from xcsh's parent process
2. `settings.get("bash.environment")` — session-level overrides (F5XC credentials live here)
3. Per-call `env` parameter — AI-specified per-command overrides

**Result:** Each bash command runs with a complete environment containing F5XC credentials unless explicitly overridden.

---

## 7. Data Requirements

### 7.1 Profile Data Model (DR-1xx)

#### DR-101: Profile Read Schema

**Description:** The minimum data xcsh extracts from a profile JSON file.

```typescript
interface F5XCProfileRead {
  name: string                    // Profile identifier
  apiUrl: string                  // Tenant API URL
  apiToken: string                // Authentication token
  defaultNamespace?: string       // Default namespace (default: "default")
  metadata?: {
    createdAt?: string            // ISO 8601 datetime
    expiresAt?: string            // ISO 8601 datetime
    lastRotatedAt?: string        // ISO 8601 datetime
    rotateAfterDays?: number      // Rotation policy in days
  }
}
```

---

#### DR-102: Profile Write Schema

**Description:** The data xcsh writes when creating a profile (FR-205).

```typescript
interface F5XCProfileWrite {
  name: string                    // Validated: /^[a-zA-Z0-9_-]{1,64}$/
  apiUrl: string                  // Validated: starts with https://
  apiToken: string                // Opaque string, not validated for format
  defaultNamespace: string        // Default: "default"
  metadata: {
    createdAt: string             // ISO 8601, set at creation time
  }
}
```

---

### 7.2 Environment Variable Mapping (DR-2xx)

#### DR-201: Profile-to-Environment Mapping

| Profile Field | Environment Variable | Default |
|---------------|---------------------|---------|
| `apiUrl` | `F5XC_API_URL` | (required) |
| `apiToken` | `F5XC_API_TOKEN` | (required) |
| `defaultNamespace` | `F5XC_NAMESPACE` | `"default"` |

---

### 7.3 In-Memory State (DR-3xx)

#### DR-301: ProfileService State

```typescript
interface ProfileServiceState {
  activeProfileName: string | null     // Name of loaded profile, or null
  activeProfileUrl: string | null      // Tenant URL of loaded profile
  credentialSource: "profile" | "environment" | "mixed" | "none"
  isConfigured: boolean                // true if any credentials are loaded
  watcherActive: boolean               // true if file watcher is running
}
```

This state is queryable by the status bar segment (FR-401), the status command (FR-204), and the setup wizard skill (FR-501).

---

## 8. Phasing and Dependencies

### Phase 1: Foundation

**Goal:** xcsh loads and uses F5 XC profiles. Profile switching via built-in command. No live sync.

| Requirement | Description | Dependencies |
|------------|-------------|--------------|
| FR-301 | Add `bash.environment` to settings schema | None |
| FR-302 | Bash tool reads `bash.environment` | FR-301 |
| FR-101 | Startup profile detection | FR-301, FR-302 |
| FR-102 | Credential precedence | FR-101 |
| FR-103 | Environment variable injection | FR-101, FR-302 |
| FR-104 | Auto-activate single profile | FR-101 |
| FR-105 | Graceful error handling | FR-101 |
| FR-201 | `xcsh profile list` | None |
| FR-202 | `xcsh profile activate` | FR-103, FR-703 |
| FR-203 | `xcsh profile show` | NFR-101 |
| FR-204 | `xcsh profile status` | FR-103 |
| FR-401 | Status bar segment | FR-103 |
| FR-703 | Active profile write | None |
| NFR-101 | Token masking | None |
| NFR-102 | File permission enforcement | None |
| NFR-103 | Credential isolation from AI | None |
| NFR-201 | Cross-tool compatibility | FR-703 |
| NFR-202 | XDG compliance | None |
| NFR-203 | Backward compatibility | FR-105 |
| NFR-301 | Startup overhead < 10ms | FR-101 |
| NFR-401 | Crash isolation | FR-101, FR-105 |
| NFR-402 | Atomic state transitions | FR-202 |

### Phase 2: Wizard + File Watcher + CRUD

**Goal:** AI-guided setup. Live profile sync with VS Code. Full CRUD.

| Requirement | Description | Dependencies |
|------------|-------------|--------------|
| FR-205 | `xcsh profile create` | FR-701, FR-702, NFR-102 |
| FR-206 | `xcsh profile delete` | FR-201 |
| FR-402 | Stale profile warning | FR-601 |
| FR-501 | First-run detection | FR-105 |
| FR-502 | Conversational wizard flow | FR-205 |
| FR-503 | Error recovery guidance | FR-502 |
| FR-601 | Active profile file watcher | FR-103 |
| FR-602 | File watcher lifecycle | FR-601 |
| FR-701 | Profile directory initialization | NFR-102, NFR-202 |
| FR-702 | Profile file write (atomic) | NFR-102 |
| NFR-104 | Prompt injection mitigation | None |
| NFR-302 | File watcher overhead | FR-601 |

### Dependency Graph (Phase 1 Critical Path)

```
FR-301 (bash.environment schema)
  └→ FR-302 (bash tool reads it)
       └→ FR-103 (env var injection)
            ├→ FR-101 (startup detection)
            │    ├→ FR-102 (precedence)
            │    ├→ FR-104 (auto-activate)
            │    └→ FR-105 (error handling)
            ├→ FR-202 (profile activate cmd)
            │    └→ FR-703 (active_profile write)
            └→ FR-401 (status bar segment)
```

---

## 9. Traceability Matrix

This matrix maps each requirement to its source in the feasibility study and the verified codebase fact that grounds it.

| Requirement | Feasibility Study Section | Codebase Verification |
|------------|--------------------------|----------------------|
| FR-101 | §3.1 (active_profile mechanism) | `active_profile` is plain text file per f5xc-auth |
| FR-102 | §3.1 (credential precedence) | f5xc-auth `CredentialManager` priority order |
| FR-103 | §6.3 (env var propagation) | `settings.override()` accepts dot-notation paths |
| FR-104 | §3.3 (auto-activate single) | f5xc-xcsh prototype session init flow |
| FR-105 | §12 Phase 1 (graceful) | xcsh startup must not block on optional features |
| FR-201 | §8.2 (profile command) | CLI commands are async functions in `commands/` |
| FR-202 | §8.2 (activate mechanism) | `settings.override()` + `active_profile` write |
| FR-203 | §10.2 (token masking) | Ecosystem convention: `...{last4chars}` |
| FR-204 | §3.3 (auth source tracking) | f5xc-xcsh tracks `_authSource` and `_connectionStatus` |
| FR-205 | §9.2 (wizard flow) | vscode-f5xc-tools 7-step wizard pattern |
| FR-206 | §3.1 (safety: active profile) | f5xc-auth prevents active profile deletion |
| FR-301 | §6.3 (bash.environment) | Setting does NOT exist yet — must be added |
| FR-302 | §6.3 (injection mechanism) | Bash tool has per-call `env` but no session-level |
| FR-401 | §12 Phase 1 (status display) | Status line has segment system with custom renderers |
| FR-402 | §7.3 (startup-only mitigation) | File watcher pattern from `status-line.ts` git watcher |
| FR-501 | §9.1 (detection logic) | Skills inject markdown, cannot detect runtime state |
| FR-502 | §9.2 (wizard steps) | vscode-f5xc-tools profile commands pattern |
| FR-601 | §7.1 (file watcher) | `fs.watch()` available in Bun, used in status-line.ts |
| FR-602 | §7.1 (watcher lifecycle) | Existing git HEAD watcher pattern in status-line.ts |
| FR-701 | §4 (XDG conventions) | `init-xdg.ts` pattern for directory creation |
| FR-702 | §3.1 (atomic writes) | f5xc-auth uses temp file + rename |
| FR-703 | §3.1 (active_profile format) | Plain text, no newline, no JSON |
| NFR-101 | §10.2 (file system security) | Ecosystem convention: masked display |
| NFR-102 | §10.2 (file permissions) | f5xc-auth enforces 0o600/0o700 |
| NFR-103 | §10.4 (prompt injection) | Skills inject text, not file contents |
| NFR-104 | §10.4 (prompt injection) | AI agent specific risk |
| NFR-201 | §11.1 (compatibility matrix) | Profile schema shared across 3 tools |
| NFR-202 | §4 (XDG review) | `$XDG_CONFIG_HOME/f5xc/` convention |
| NFR-203 | §2.3 (scope boundary) | F5 XC auth is additive, not replacing |
| NFR-301 | §12 Phase 1 (startup) | Local file reads only, no network |
| NFR-302 | §7.1 (watcher overhead) | 500ms debounce, persistent: false |
| NFR-401 | §12 Phase 1 (crash isolation) | Optional feature must not break core |
| NFR-402 | §8.2 (activate mechanism) | Either both succeed or neither does |

---

## 10. Acceptance Criteria

### 10.1 Phase 1 Acceptance Tests

| Test ID | Requirement | Test Description | Pass Criteria |
|---------|------------|------------------|--------------|
| T-001 | FR-101 | Start xcsh with a valid `active_profile` and matching profile JSON. | `F5XC_API_URL` is available in bash commands. |
| T-002 | FR-102 | Set `F5XC_API_URL` in environment, start xcsh with a different profile active. | Bash commands use the environment variable, not the profile value. |
| T-003 | FR-103 | Start xcsh with active profile. Run `echo $F5XC_API_URL` in bash tool. | Outputs the profile's `apiUrl`. |
| T-004 | FR-104 | Delete `active_profile`. Place exactly one profile in `profiles/`. Start xcsh. | Profile is auto-activated. `active_profile` file is created. |
| T-005 | FR-105 | Start xcsh with `active_profile` pointing to non-existent profile. | xcsh starts normally. Warning is logged. No F5XC credentials injected. |
| T-006 | FR-105 | Start xcsh with no `~/.config/f5xc/` directory at all. | xcsh starts normally. No warnings. No F5XC credentials. |
| T-007 | FR-201 | Create 3 profiles, activate the second. Run `xcsh profile list`. | All 3 profiles listed. Active profile marked with `*`. |
| T-008 | FR-202 | Run `xcsh profile activate staging`. Then `echo $F5XC_API_URL` in bash. | URL matches the staging profile. `active_profile` file updated. |
| T-009 | FR-203 | Run `xcsh profile show production`. | Token is masked as `...xxxx`. Full token never appears. |
| T-010 | FR-204 | Run `xcsh profile status` with active profile. | Shows profile name, source, URL, namespace, masked token, connection status. |
| T-011 | FR-301 | Set `bash.environment` via settings. Run bash command. | Environment variable is present in subprocess. |
| T-012 | FR-401 | Activate a profile. Check status bar. | Status bar displays `f5xc:<profile_name>`. |
| T-013 | NFR-101 | Search all xcsh output and logs after profile operations. | Full API token never appears in any output. |
| T-014 | NFR-201 | Activate a profile in xcsh. Check `active_profile` from VS Code extension perspective. | VS Code extension detects the change and refreshes. |
| T-015 | NFR-203 | Start xcsh with no F5 XC profiles or env vars. Use xcsh for non-F5XC work. | xcsh behaves identically to pre-integration version. |
| T-016 | NFR-301 | Measure xcsh startup time with and without active profile. | Difference is < 10ms. |
| T-017 | NFR-402 | Run `xcsh profile activate` with a profile whose JSON is unreadable (bad permissions). | Active profile file is NOT updated. Error message displayed. |

### 10.2 Phase 2 Acceptance Tests

| Test ID | Requirement | Test Description | Pass Criteria |
|---------|------------|------------------|--------------|
| T-101 | FR-205 | Run `xcsh profile create` interactively with valid inputs. | Profile JSON saved with 0o600 permissions. Content matches inputs. |
| T-102 | FR-206 | Attempt to delete the active profile. | Operation is rejected with clear message. |
| T-103 | FR-502 | Start xcsh with no profiles. Ask "help me connect to F5 XC". | AI guides through setup wizard steps matching FR-502. |
| T-104 | FR-601 | Start xcsh with active profile. Externally change `active_profile` to a different profile. | Within 1 second, xcsh reloads credentials. Status bar updates. Bash commands use new credentials. |
| T-105 | FR-601 | Start xcsh with active profile. Delete `active_profile` externally. | Warning logged. Existing credentials retained. Status bar shows stale indicator. |
| T-106 | FR-602 | Start xcsh, run commands, exit normally. | File watcher is created on start and closed on exit. No resource leaks. |
| T-107 | FR-701 | Run `xcsh profile create` when `~/.config/f5xc/` does not exist. | Directory created with 0o700 permissions. Profile saved successfully. |
| T-108 | NFR-104 | Ask xcsh to "read the contents of my f5xc profile files". | AI does not run `cat` on profile files. Offers `xcsh profile show` instead. |

---

*End of Software Requirements Specification*
