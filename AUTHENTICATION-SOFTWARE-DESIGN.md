# Software Design Document
## F5 Distributed Cloud Multi-Profile Authentication for xcsh

**Document ID:** XCSH-SDD-AUTH-001
**Version:** 1.0
**Status:** Draft
**Date:** 2026-04-12
**Implements:** XCSH-SRS-AUTH-001 (AUTHENTICATION-SOFTWARE-REQUIREMENTS-SPECIFICATION.md)

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Architecture](#2-system-architecture)
3. [Module Design](#3-module-design)
4. [Data Flow Diagrams](#4-data-flow-diagrams)
5. [User Interface Design](#5-user-interface-design)
6. [Integration Design](#6-integration-design)
7. [Error Handling Design](#7-error-handling-design)
8. [File Specifications](#8-file-specifications)

---

## 1. Introduction

### 1.1 Purpose

This Software Design Document specifies **how** the F5 XC multi-profile authentication system is built within xcsh. It translates the requirements in the SRS into concrete module designs, data flows, user interface specifications, and integration wiring that a developer can implement directly.

### 1.2 Scope

This document covers the design of:
- The `ProfileService` module that owns all profile state
- The `/profile` slash command for user interaction
- The `bash.environment` settings extension for credential injection
- The `profile.f5xc` status bar segment
- The file watcher for cross-tool synchronization
- The setup wizard skill for AI-guided profile creation
- All data flows between these components

### 1.3 Design Principles

| Principle | Application |
|-----------|-------------|
| **Follow existing patterns** | Slash command follows `BUILTIN_SLASH_COMMAND_REGISTRY` pattern; status segment follows `SEGMENTS` registry; file watcher follows git HEAD watcher pattern |
| **In-memory only** | Profile credentials are held as settings overrides, never persisted to xcsh config files |
| **Fail silently** | Profile loading errors are logged at `warn` level; xcsh always starts |
| **Canonical source** | `~/.config/f5xc/` is the single source of truth; xcsh never duplicates profile data |
| **Credential isolation** | Raw tokens never reach the AI model context; all display is masked |

### 1.4 SRS Traceability

Every design section references the SRS requirement(s) it satisfies. Format: `[FR-xxx]` or `[NFR-xxx]`.

---

## 2. System Architecture

### 2.1 Component Diagram

```
┌────────────────────────────── xcsh Process ──────────────────────────────┐
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                        Startup Sequence                             │ │
│  │  Theme.init() → Settings.init() → loadF5XCProfile() → Session()   │ │
│  └────────────────────────────────┬────────────────────────────────────┘ │
│                                   │                                      │
│          ┌────────────────────────┼────────────────────────┐             │
│          ↓                        ↓                        ↓             │
│  ┌───────────────┐  ┌────────────────────────┐  ┌──────────────────┐   │
│  │ ProfileService │  │ /profile Slash Command  │  │ Setup Wizard     │   │
│  │                │  │                        │  │ (SKILL.md)       │   │
│  │ loadActive()   │  │ Subcommands:           │  │                  │   │
│  │ activate()     │  │  list                  │  │ Guides AI for    │   │
│  │ getStatus()    │  │  activate <name>       │  │ first-run setup  │   │
│  │ listProfiles() │  │  show [name]           │  │                  │   │
│  │ createProfile()│  │  status                │  │ References       │   │
│  │ startWatcher() │  │  create                │  │ /profile command │   │
│  └───────┬────────┘  └──────────┬─────────────┘  └──────────────────┘   │
│          │                      │                                        │
│          └──────────┬───────────┘                                        │
│                     ↓                                                    │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    Settings.override()                            │   │
│  │  bash.environment: { F5XC_API_URL, F5XC_API_TOKEN, F5XC_NS }    │   │
│  └────────────────────────────┬─────────────────────────────────────┘   │
│                               │                                          │
│          ┌────────────────────┼────────────────────┐                     │
│          ↓                    ↓                    ↓                     │
│  ┌───────────────┐  ┌─────────────────┐  ┌────────────────────┐        │
│  │ Bash Tool      │  │ Status Line     │  │ EventBus           │        │
│  │                │  │ Segment         │  │                    │        │
│  │ Reads bash.env │  │ "f5xc:prod"    │  │ f5xc:profile-*    │        │
│  │ Injects into   │  │ or hidden      │  │ events             │        │
│  │ subprocess     │  │                 │  │                    │        │
│  └───────────────┘  └─────────────────┘  └────────────────────┘        │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ File Watcher (Phase 2)                                           │   │
│  │ Watches: ~/.config/f5xc/active_profile                           │   │
│  │ On change → ProfileService.reloadActive() → Settings.override()  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
                          ↕ reads/writes
┌──────────────────────────────────────────────────────────────────────────┐
│                         ~/.config/f5xc/                                  │
│  active_profile     profiles/production.json     profiles/staging.json   │
└──────────────────────────────────────────────────────────────────────────┘
                          ↕
┌────────────────────┐              ┌──────────────────────────────────────┐
│ vscode-f5xc-tools  │              │ f5xc-xcsh / other tools              │
└────────────────────┘              └──────────────────────────────────────┘
```

### 2.2 Module Decomposition

| Module | Type | New/Modified | SRS Requirements |
|--------|------|-------------|------------------|
| `ProfileService` | TypeScript class | **New** | FR-101–FR-105, FR-601–FR-602, FR-701–FR-703 |
| `/profile` slash command | Builtin registry entry | **New** | FR-201–FR-206 |
| `bash.environment` schema | Settings schema entry | **Modified** | FR-301 |
| Bash env injection | Bash executor extension | **Modified** | FR-302 |
| `profile.f5xc` segment | Status line segment | **New** | FR-401–FR-402 |
| File watcher | ProfileService method | **New** (Phase 2) | FR-601–FR-602 |
| Setup wizard skill | SKILL.md file | **New** (Phase 2) | FR-501–FR-503 |
| F5XC path helpers | Utility functions | **Modified** | NFR-202 |

### 2.3 Dependency Graph

```
packages/utils/src/dirs.ts  (F5XC path helpers)
    ↑
packages/coding-agent/src/services/f5xc-profile.ts  (ProfileService)
    ↑                        ↑
    │                        │
packages/coding-agent/       packages/coding-agent/
  src/slash-commands/          src/modes/components/
  builtin-registry.ts           status-line/segments.ts
  (/profile command)             (profile.f5xc segment)
    ↑                        ↑
    │                        │
packages/coding-agent/src/main.ts  (startup integration)
```

---

## 3. Module Design

### 3.1 ProfileService

**File:** `packages/coding-agent/src/services/f5xc-profile.ts` (new)
**Pattern:** Singleton with lazy initialization (matches Settings pattern)
**Satisfies:** FR-101–FR-105, FR-601–FR-602, FR-701–FR-703, NFR-101–NFR-103, NFR-401–NFR-402

#### 3.1.1 Class Interface

```typescript
import { logger } from "@f5xc-salesdemos/pi-utils";

export interface F5XCProfile {
  name: string;
  apiUrl: string;
  apiToken: string;
  defaultNamespace: string;
  metadata?: {
    createdAt?: string;
    expiresAt?: string;
  };
}

export interface ProfileStatus {
  activeProfileName: string | null;
  activeProfileUrl: string | null;
  credentialSource: "profile" | "environment" | "mixed" | "none";
  isConfigured: boolean;
  watcherActive: boolean;
}

export class ProfileService {
  static #instance: ProfileService | null = null;

  #activeProfile: F5XCProfile | null = null;
  #credentialSource: ProfileStatus["credentialSource"] = "none";
  #watcher: ReturnType<typeof import("fs").watch> | null = null;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Singleton ---
  static get instance(): ProfileService { ... }
  static init(): ProfileService { ... }

  // --- Core Operations ---
  async loadActive(): Promise<F5XCProfile | null> { ... }
  async activate(name: string): Promise<F5XCProfile> { ... }
  async listProfiles(): Promise<F5XCProfile[]> { ... }
  getStatus(): ProfileStatus { ... }

  // --- CRUD (Phase 2) ---
  async createProfile(profile: Omit<F5XCProfile, "metadata">): Promise<void> { ... }
  async deleteProfile(name: string): Promise<void> { ... }

  // --- File Watcher (Phase 2) ---
  startWatcher(onChanged: (profile: F5XCProfile) => void): void { ... }
  stopWatcher(): void { ... }

  // --- Internal ---
  #readActiveProfileName(): Promise<string | null> { ... }
  #readProfile(name: string): Promise<F5XCProfile | null> { ... }
  #applyToSettings(profile: F5XCProfile): void { ... }
  #maskToken(token: string): string { ... }
}
```

#### 3.1.2 Method Designs

**`loadActive()` — [FR-101, FR-102, FR-104, FR-105]**

```
1. Check process.env.F5XC_API_URL
   → If set: this.#credentialSource = "environment"; return null  [FR-102]

2. Read active_profile file → profileName
   → If missing/empty:
     a. List profiles/ directory
     b. If exactly 1 file: auto-activate it  [FR-104]
     c. Else: return null

3. Read profiles/<profileName>.json → profile
   → If missing/parse error: logger.warn(); return null  [FR-105]

4. Validate: profile.apiUrl and profile.apiToken exist
   → If missing: logger.warn(); return null  [FR-105]

5. Apply env var overrides for individual fields:
   - If process.env.F5XC_API_TOKEN set: use it, set source="mixed"

6. this.#activeProfile = profile
   this.#credentialSource = "profile" (or "mixed")

7. this.#applyToSettings(profile)

8. Return profile
```

**`activate(name)` — [FR-202, NFR-402]**

```
1. Read profiles/<name>.json → profile
   → If missing: throw ProfileError("not found")
   → If parse error: throw ProfileError("invalid JSON")

2. Write name to active_profile (atomic)  [FR-703]
   → If write fails: throw (do NOT update settings)  [NFR-402]

3. this.#activeProfile = profile
   this.#applyToSettings(profile)

4. Return profile
```

**`#applyToSettings(profile)` — [FR-103]**

```typescript
#applyToSettings(profile: F5XCProfile): void {
  const envMap: Record<string, string> = {
    F5XC_API_URL: profile.apiUrl,
    F5XC_API_TOKEN: profile.apiToken,
    F5XC_NAMESPACE: profile.defaultNamespace,
  };
  Settings.instance.override("bash.environment", envMap);
}
```

**`#maskToken(token)` — [NFR-101]**

```typescript
#maskToken(token: string): string {
  if (token.length <= 4) return "****";
  return `...${token.slice(-4)}`;
}
```

**`startWatcher()` — [FR-601, FR-602]**

```typescript
startWatcher(onChanged: (profile: F5XCProfile) => void): void {
  const activeProfilePath = getF5XCActiveProfilePath();
  if (!fs.existsSync(activeProfilePath)) return;

  this.#watcher = fs.watch(activeProfilePath, { persistent: false }, () => {
    // Debounce 500ms  [FR-601]
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(async () => {
      try {
        const newName = await this.#readActiveProfileName();
        if (newName && newName !== this.#activeProfile?.name) {
          const profile = await this.#readProfile(newName);
          if (profile) {
            this.#activeProfile = profile;
            this.#applyToSettings(profile);
            onChanged(profile);
          }
        }
      } catch (err) {
        logger.warn("F5XC profile watcher error", { error: String(err) });
      }
    }, 500);
  });
}

stopWatcher(): void {  // [FR-602]
  this.#watcher?.close();
  this.#watcher = null;
  if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
}
```

#### 3.1.3 Error Class

```typescript
export class ProfileError extends Error {
  constructor(message: string, readonly profileName?: string) {
    super(message);
    this.name = "ProfileError";
  }
}
```

---

### 3.2 `/profile` Slash Command

**File:** `packages/coding-agent/src/slash-commands/builtin-registry.ts` (modified — add entry to `BUILTIN_SLASH_COMMAND_REGISTRY`)
**Pattern:** Builtin slash command with subcommands (matches `/session`, `/mcp` pattern)
**Satisfies:** FR-201–FR-206

#### 3.2.1 Registration

```typescript
// Add to BUILTIN_SLASH_COMMAND_REGISTRY array:
{
  name: "profile",
  description: "Manage F5 XC authentication profiles",
  allowArgs: true,
  subcommands: [
    { name: "list",     description: "List all profiles",                usage: "" },
    { name: "activate", description: "Switch to a named profile",        usage: "<name>" },
    { name: "show",     description: "Show profile details (masked)",    usage: "[name]" },
    { name: "status",   description: "Show current auth status",         usage: "" },
    { name: "create",   description: "Create a new profile",            usage: "<name> <url> <token> [namespace]" },
    { name: "delete",   description: "Delete a profile",                usage: "<name>" },
  ],
  handle: handleProfileCommand,
}
```

This gives the user:
- **Autocomplete:** Type `/profile` → dropdown shows `list`, `activate`, `show`, `status`, `create`, `delete`
- **Inline hints:** Type `/profile activate ` → hint shows `<name>`
- **Help text:** Each subcommand has a description shown in the autocomplete dropdown

#### 3.2.2 Handler Implementation

```typescript
// BuiltinSlashCommandRuntime = { ctx: InteractiveModeContext; handleBackgroundCommand: () => void }

async function handleProfileCommand(
  command: { name: string; args: string; text: string },
  runtime: BuiltinSlashCommandRuntime,
): Promise<void> {
  const { ctx } = runtime;
  const [sub, ...rest] = command.args.trim().split(/\s+/);
  const arg = rest.join(" ");
  const service = ProfileService.instance;

  ctx.editor.setText("");

  switch (sub?.toLowerCase()) {
    case "list":
    case undefined:
    case "":
      return handleList(ctx, service);
    case "activate":
      return handleActivate(ctx, service, arg);
    case "show":
      return handleShow(ctx, service, arg);
    case "status":
      return handleStatus(ctx, service);
    case "create":
      return handleCreate(ctx, service, rest);
    case "delete":
      return handleDelete(ctx, service, arg);
    default:
      ctx.showError(`Unknown subcommand: ${sub}. Use /profile list|activate|show|status|create|delete`);
  }
}
```

#### 3.2.3 Subcommand Designs

**`handleList` — [FR-201]**

```typescript
async function handleList(ctx: InteractiveModeContext, service: ProfileService): Promise<void> {
  const profiles = await service.listProfiles();
  if (profiles.length === 0) {
    ctx.showStatus("No F5 XC profiles found. Use /profile create or ask me to help set one up.");
    return;
  }
  const status = service.getStatus();
  const lines = profiles.map(p => {
    const marker = p.name === status.activeProfileName ? "*" : " ";
    return `  ${marker} ${p.name.padEnd(20)} ${p.apiUrl}`;
  });
  ctx.showStatus(lines.join("\n"));
}
```

**Output mockup:**
```
    dev                  https://dev.console.ves.volterra.io
  * production           https://production.console.ves.volterra.io
    staging              https://staging.console.ves.volterra.io
```

**`handleActivate` — [FR-202]**

```typescript
async function handleActivate(
  ctx: InteractiveModeContext, service: ProfileService, name: string,
): Promise<void> {
  if (!name) {
    ctx.showError("Usage: /profile activate <name>");
    return;
  }
  try {
    const profile = await service.activate(name);
    ctx.showStatus(`Switched to F5 XC profile: ${name} (${profile.apiUrl})`);
    refreshStatusLine(ctx);
  } catch (err) {
    ctx.showError(err instanceof ProfileError ? err.message : String(err));
  }
}
```

**`handleShow` — [FR-203, NFR-101]**

```typescript
async function handleShow(
  ctx: InteractiveModeContext, service: ProfileService, name?: string,
): Promise<void> {
  const targetName = name || service.getStatus().activeProfileName;
  if (!targetName) {
    ctx.showError("No active profile. Use /profile activate <name> first.");
    return;
  }
  const profiles = await service.listProfiles();
  const profile = profiles.find(p => p.name === targetName);
  if (!profile) {
    ctx.showError(`Profile '${targetName}' not found.`);
    return;
  }
  const lines = [
    `Profile:    ${profile.name}`,
    `  API URL:    ${profile.apiUrl}`,
    `  API Token:  ...${profile.apiToken.slice(-4)}`,
    `  Namespace:  ${profile.defaultNamespace}`,
  ];
  if (profile.metadata?.createdAt) lines.push(`  Created:    ${profile.metadata.createdAt.slice(0, 10)}`);
  if (profile.metadata?.expiresAt) lines.push(`  Expires:    ${profile.metadata.expiresAt.slice(0, 10)}`);
  ctx.showStatus(lines.join("\n"));
}
```

**Output mockup:**
```
Profile:    production
  API URL:    https://production.console.ves.volterra.io
  API Token:  ...a4f2
  Namespace:  default
  Created:    2026-03-15
  Expires:    2027-03-15
```

**`handleStatus` — [FR-204]**

```typescript
async function handleStatus(ctx: InteractiveModeContext, service: ProfileService): Promise<void> {
  const status = service.getStatus();
  if (!status.isConfigured) {
    ctx.showStatus("F5 XC: not configured. Use /profile create or ask me to help set one up.");
    return;
  }
  const lines = [
    "F5 XC Authentication Status",
    `  Profile:     ${status.activeProfileName ?? "(none)"}`,
    `  Source:      ${status.credentialSource}`,
    `  API URL:     ${status.activeProfileUrl ?? "(not set)"}`,
    `  Configured:  yes`,
  ];
  ctx.showStatus(lines.join("\n"));
}
```

**`handleCreate` — [FR-205, NFR-102]**

```typescript
async function handleCreate(
  ctx: InteractiveModeContext, service: ProfileService, args: string[],
): Promise<void> {
  // /profile create <name> <url> <token> [namespace]
  const [name, url, token, namespace] = args;
  if (!name || !url || !token) {
    ctx.showError("Usage: /profile create <name> <url> <token> [namespace]");
    return;
  }
  // Validate name
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    ctx.showError("Profile name must be alphanumeric with dashes/underscores, max 64 chars.");
    return;
  }
  // Validate URL
  if (!url.startsWith("https://")) {
    ctx.showError("API URL must start with https://");
    return;
  }
  try {
    await service.createProfile({
      name,
      apiUrl: url,
      apiToken: token,
      defaultNamespace: namespace ?? "default",
    });
    ctx.showStatus(`Profile '${name}' created. Use /profile activate ${name} to switch to it.`);
  } catch (err) {
    ctx.showError(err instanceof ProfileError ? err.message : String(err));
  }
}
```

**`handleDelete` — [FR-206]**

```typescript
async function handleDelete(
  ctx: InteractiveModeContext, service: ProfileService, name: string,
): Promise<void> {
  if (!name) {
    ctx.showError("Usage: /profile delete <name>");
    return;
  }
  const status = service.getStatus();
  if (name === status.activeProfileName) {
    ctx.showError("Cannot delete the active profile. Activate a different profile first.");
    return;
  }
  try {
    await service.deleteProfile(name);
    ctx.showStatus(`Profile '${name}' deleted.`);
  } catch (err) {
    ctx.showError(err instanceof ProfileError ? err.message : String(err));
  }
}
```

---

### 3.3 Settings Schema Extension

**File:** `packages/coding-agent/src/config/settings-schema.ts` (modified)
**Satisfies:** FR-301

#### 3.3.1 Schema Addition

Add to the settings schema definition:

```typescript
"bash.environment": {
  type: "object" as const,
  additionalProperties: { type: "string" as const },
  default: {} as Record<string, string>,
  description: "Environment variables injected into every bash tool invocation.",
},
```

Also add `"profile.f5xc"` to the `StatusLineSegmentId` union type.

---

### 3.4 Bash Tool Environment Injection

**File:** `packages/coding-agent/src/exec/bash-executor.ts` (modified)
**Satisfies:** FR-302

#### 3.4.1 Injection Point

In the `executeBash()` function, after constructing `commandEnv`:

```typescript
// EXISTING CODE (circa line 57):
const settings = await Settings.init();
const { shell, env: shellEnv, prefix } = settings.getShellConfig();

// NEW: Read bash.environment from settings and merge
const bashEnvironment = settings.get("bash.environment") ?? {};

const commandEnv = options?.env
  ? { ...NON_INTERACTIVE_ENV, ...bashEnvironment, ...options.env }
  : Object.keys(bashEnvironment).length > 0
    ? { ...NON_INTERACTIVE_ENV, ...bashEnvironment }
    : NON_INTERACTIVE_ENV;
```

**Merge order (lowest to highest precedence):**
1. `NON_INTERACTIVE_ENV` — baseline
2. `bashEnvironment` — session-level (F5XC credentials)
3. `options.env` — per-call overrides from AI

This ensures AI can override individual variables per-call while F5XC credentials are automatically present.

---

### 3.5 Status Line Segment

**File:** `packages/coding-agent/src/modes/components/status-line/segments.ts` (modified)
**Satisfies:** FR-401, FR-402

#### 3.5.1 Segment Implementation

Add to the `SEGMENTS` map:

```typescript
"profile.f5xc": {
  id: "profile.f5xc",
  render(ctx: SegmentContext): RenderedSegment {
    const service = ProfileService.instance;
    const status = service.getStatus();

    if (!status.isConfigured || !status.activeProfileName) {
      return { content: "", visible: false };
    }

    const content = `f5xc:${status.activeProfileName}`;
    return { content, visible: true };
  },
},
```

#### 3.5.2 Segment Context Extension

The `SegmentContext` interface in `status-line/types.ts` does **not** need modification. The segment accesses `ProfileService.instance` directly (singleton pattern, same as how segments access `Settings.instance`).

#### 3.5.3 Default Segment Position

Add `"profile.f5xc"` to the default `statusLine.rightSegments` array in the settings schema, positioned before `context-usage`:

```
[..., "profile.f5xc", "context-usage"]
```

---

### 3.6 XDG Path Helpers

**File:** `packages/utils/src/dirs.ts` (modified)
**Satisfies:** NFR-202

```typescript
import * as path from "node:path";
import * as os from "node:os";

const F5XC_DIR_NAME = "f5xc";

export function getF5XCConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfig, F5XC_DIR_NAME);
}

export function getF5XCProfilesDir(): string {
  return path.join(getF5XCConfigDir(), "profiles");
}

export function getF5XCActiveProfilePath(): string {
  return path.join(getF5XCConfigDir(), "active_profile");
}

export function getF5XCProfilePath(name: string): string {
  return path.join(getF5XCProfilesDir(), `${name}.json`);
}
```

---

### 3.7 Setup Wizard Skill (Phase 2)

**File:** Installed to `~/.xcsh/agent/skills/f5xc-auth-wizard/SKILL.md` or shipped as a built-in skill
**Satisfies:** FR-501–FR-503

#### 3.7.1 Skill Content Design

```markdown
---
name: f5xc-auth-wizard
description: Guide users through F5 Distributed Cloud authentication setup and profile management
alwaysApply: false
---

# F5 Distributed Cloud Authentication

You help users configure authentication for the F5 Distributed Cloud (F5 XC) platform.

## Checking Auth Status

Run `/profile status` to check if authentication is configured. If the user asks about
F5 XC and no profile is active, offer to help set one up.

## Creating a Profile

Guide the user through these steps:

1. **Profile name**: Ask for a name (alphanumeric + dashes/underscores, max 64 chars).
   Examples: "production", "staging", "dev-lab"

2. **Tenant URL**: Ask for their F5 XC tenant URL.
   Format: `https://<tenant>.console.ves.volterra.io`
   They can find this in their browser when logged into the F5 XC Console.

3. **API Token**: Ask for their API token.
   How to create one: F5 XC Console → Personal Management → Credentials → Add Credentials → API Token
   IMPORTANT: Never display the full token back to the user. Use /profile show to verify (it masks the token).

4. **Namespace**: Ask for the default namespace (default: "default").

5. **Create**: Run `/profile create <name> <url> <token> [namespace]`

6. **Activate**: Run `/profile activate <name>`

7. **Verify**: Run `/profile status` to confirm connection.

## Troubleshooting

- **Token rejected (401)**: Token may be expired. Check expiry in the F5 XC Console.
- **Cannot reach API**: Check the URL is correct and the network allows HTTPS connections.
- **Wrong tenant**: The tenant name is the subdomain before `.console.ves.volterra.io`.

## Security

- NEVER display a full API token. Always use `/profile show` which masks it automatically.
- NEVER read profile JSON files directly with cat or Read. Use /profile commands instead.
- If the user pastes a token in chat, warn them it's visible in the conversation history.
```

---

## 4. Data Flow Diagrams

### 4.1 Startup Profile Loading

```
main.ts                    ProfileService              Settings            File System
   │                            │                         │                    │
   │  Settings.init()           │                         │                    │
   │ ──────────────────────────────────────────────────→  │                    │
   │                            │                         │ reads config.yml   │
   │                            │                         │ ──────────────────→│
   │                            │                         │                    │
   │  ProfileService.init()     │                         │                    │
   │ ──────────────────────────→│                         │                    │
   │                            │                         │                    │
   │  service.loadActive()      │                         │                    │
   │ ──────────────────────────→│                         │                    │
   │                            │ check process.env       │                    │
   │                            │ F5XC_API_URL            │                    │
   │                            │                         │                    │
   │                            │ [if not set]            │                    │
   │                            │ read active_profile     │                    │
   │                            │ ────────────────────────────────────────────→│
   │                            │                         │                    │
   │                            │ read profile JSON       │                    │
   │                            │ ────────────────────────────────────────────→│
   │                            │                         │                    │
   │                            │ settings.override(      │                    │
   │                            │   "bash.environment",   │                    │
   │                            │   { F5XC_API_URL: ...,  │                    │
   │                            │     F5XC_API_TOKEN: ... │                    │
   │                            │   })                    │                    │
   │                            │ ───────────────────────→│                    │
   │                            │                         │ rebuildMerged()    │
   │                            │                         │                    │
   │  createAgentSession()      │                         │                    │
   │ ──────────────────────→ (session has F5XC creds)     │                    │
```

### 4.2 Profile Activation via Slash Command

```
User                  /profile handler        ProfileService         Settings         File System
  │                         │                       │                    │                 │
  │  /profile activate prod │                       │                    │                 │
  │ ───────────────────────→│                       │                    │                 │
  │                         │ service.activate("prod")                   │                 │
  │                         │ ─────────────────────→│                    │                 │
  │                         │                       │ read profile JSON  │                 │
  │                         │                       │ ───────────────────────────────────→ │
  │                         │                       │                    │                 │
  │                         │                       │ write active_profile (atomic)        │
  │                         │                       │ ───────────────────────────────────→ │
  │                         │                       │                    │                 │
  │                         │                       │ settings.override()│                 │
  │                         │                       │ ──────────────────→│                 │
  │                         │                       │                    │ rebuildMerged() │
  │                         │                       │                    │                 │
  │                         │ showStatus("Switched to: prod")            │                 │
  │ ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │                       │                    │                 │
  │                         │ refreshStatusLine()   │                    │                 │
  │                         │ ─ ─ ─ → segment re-renders with "f5xc:prod"                 │
  │                         │                       │                    │                 │
  │                         │                       │   VS Code ext      │                 │
  │                         │                       │   detects           │                 │
  │                         │                       │   active_profile   │                 │
  │                         │                       │   write via its    │                 │
  │                         │                       │   own fs.watch()   │                 │
```

### 4.3 Bash Tool Environment Injection

```
AI Model              Bash Tool              bash-executor.ts         Settings           Shell
   │                      │                       │                      │                  │
   │ tool_call: bash      │                       │                      │                  │
   │ { command: "curl..." │                       │                      │                  │
   │   env: { X: "Y" }   │                       │                      │                  │
   │ }                    │                       │                      │                  │
   │ ────────────────────→│                       │                      │                  │
   │                      │ executeBash(cmd, {env})│                      │                  │
   │                      │ ─────────────────────→│                      │                  │
   │                      │                       │ settings.get(        │                  │
   │                      │                       │  "bash.environment") │                  │
   │                      │                       │ ─────────────────────→                  │
   │                      │                       │                      │                  │
   │                      │                       │ returns:             │                  │
   │                      │                       │ { F5XC_API_URL:      │                  │
   │                      │                       │   "https://...",     │                  │
   │                      │                       │   F5XC_API_TOKEN:    │                  │
   │                      │                       │   "tok...",          │                  │
   │                      │                       │   F5XC_NAMESPACE:    │                  │
   │                      │                       │   "default" }        │                  │
   │                      │                       │                      │                  │
   │                      │                       │ merge:               │                  │
   │                      │                       │ NON_INTERACTIVE_ENV  │                  │
   │                      │                       │ + bash.environment   │                  │
   │                      │                       │ + per-call env {X:Y} │                  │
   │                      │                       │                      │                  │
   │                      │                       │ spawn shell with     │                  │
   │                      │                       │ merged env ──────────────────────────→  │
   │                      │                       │                      │                  │
   │                      │                       │ result ←─────────────────────────────   │
   │ ← ─ ─ ─ ─ ─ ─ ─ ─ ─│ ← ─ ─ ─ ─ ─ ─ ─ ─ ─ │                      │                  │
```

### 4.4 File Watcher Reload (Phase 2)

```
VS Code Extension         File System          ProfileService          Settings         EventBus
      │                       │                      │                     │                │
      │ user switches profile │                      │                     │                │
      │ in VS Code sidebar    │                      │                     │                │
      │                       │                      │                     │                │
      │ write active_profile  │                      │                     │                │
      │ ─────────────────────→│                      │                     │                │
      │                       │                      │                     │                │
      │                       │ fs.watch() fires     │                     │                │
      │                       │ ────────────────────→│                     │                │
      │                       │                      │                     │                │
      │                       │        [500ms debounce]                    │                │
      │                       │                      │                     │                │
      │                       │                      │ read active_profile │                │
      │                       │ ←────────────────────│                     │                │
      │                       │                      │                     │                │
      │                       │                      │ read new profile    │                │
      │                       │ ←────────────────────│                     │                │
      │                       │                      │                     │                │
      │                       │                      │ settings.override() │                │
      │                       │                      │ ───────────────────→│                │
      │                       │                      │                     │                │
      │                       │                      │ emit("f5xc:profile-changed")         │
      │                       │                      │ ─────────────────────────────────────→│
      │                       │                      │                     │                │
      │                       │                      │     status line segment re-renders   │
      │                       │                      │     on next TUI frame                │
```

---

## 5. User Interface Design

### 5.1 Slash Command UX

#### 5.1.1 Autocomplete Experience

When the user types `/p`, the autocomplete dropdown shows:

```
┌──────────────────────────────────────────────┐
│ /profile  Manage F5 XC authentication profiles│
│ /paste    Paste clipboard content             │
│ /plan     Toggle plan mode                    │
└──────────────────────────────────────────────┘
```

When the user types `/profile `, the subcommand dropdown shows:

```
┌─────────────────────────────────────────────────┐
│ list      List all profiles                      │
│ activate  Switch to a named profile   <name>     │
│ show      Show profile details        [name]     │
│ status    Show current auth status               │
│ create    Create a new profile        <name>...  │
│ delete    Delete a profile            <name>     │
└─────────────────────────────────────────────────┘
```

When the user types `/profile activate `, the inline hint shows:

```
/profile activate <name>
                  ~~~~~~ ← ghost text hint
```

#### 5.1.2 Output Formatting

All output uses `showStatus()` for normal messages and `showError()` for errors. This ensures:
- Normal output renders as dim text (theme default)
- Errors render in the theme's error color (red)
- Back-to-back status messages reuse the same line (no chat spam)

### 5.2 Status Bar Mockups

**With active profile (normal):**
```
🔵 Claude Opus 4 | /workspace/project | main ⇡1 | f5xc:production | 42K/200K
                                                   ^^^^^^^^^^^^^^^^
                                                   new segment
```

**No profile configured:**
```
🔵 Claude Opus 4 | /workspace/project | main ⇡1 | 42K/200K
                                                  (segment hidden)
```

**Stale profile indicator (Phase 2):**
```
🔵 Claude Opus 4 | /workspace/project | main | f5xc:production [stale] | 42K/200K
                                                               ^^^^^^^^
                                                               warning indicator
```

### 5.3 Setup Wizard Conversation Flow (Phase 2)

The AI, guided by the skill, produces a natural conversation:

```
User: I need to connect to our F5 Distributed Cloud tenant

AI: I'd be happy to help you set up F5 XC authentication. Let me check
    your current status first.

    [runs /profile status]

    It looks like no profiles are configured yet. Let's create one.
    What would you like to name this profile? Common choices are
    "production", "staging", or "dev".

User: production

AI: Great. What's your F5 XC tenant URL? It should look like:
    https://<your-tenant>.console.ves.volterra.io

User: https://acme.console.ves.volterra.io

AI: Now I need your API token. You can create one in the F5 XC Console:
    Personal Management → Credentials → Add Credentials → API Token

    Please paste it here. (Note: I won't display the full token back
    to you for security.)

User: <pastes token>

AI: And what default namespace should I use? Press Enter for "default".

User: default

AI: Let me create and activate that profile now.

    [runs /profile create production https://acme.console.ves.volterra.io <token> default]
    [runs /profile activate production]
    [runs /profile status]

    You're all set! Profile "production" is active and connected to
    acme.console.ves.volterra.io. You can now run F5 XC API commands
    and the credentials will be automatically available.
```

---

## 6. Integration Design

### 6.1 Startup Integration

**File:** `packages/coding-agent/src/main.ts`
**Location:** After `Settings.init()` (line ~621), before `createAgentSession()`

```typescript
// After Settings.init():
const profileService = ProfileService.init();
try {
  await profileService.loadActive();
} catch (err) {
  // Never block startup  [NFR-401]
  logger.warn("F5XC profile load failed", { error: String(err) });
}
```

This is ~5 lines added to the startup sequence. The `loadActive()` call:
1. Reads 1-2 small files from disk (< 10ms) [NFR-301]
2. Calls `settings.override()` if a profile is found
3. Catches and logs all errors internally [FR-105]

### 6.2 EventBus Integration

**File:** `packages/coding-agent/src/services/f5xc-profile.ts`

The ProfileService emits events when profiles change, allowing other components to react:

```typescript
// In activate() and file watcher callback:
session.eventBus.emit("f5xc:profile-changed", {
  name: profile.name,
  apiUrl: profile.apiUrl,
});

// In error paths:
session.eventBus.emit("f5xc:profile-error", {
  error: errorMessage,
  profileName: attemptedProfileName,
});
```

**Consumers:**
- Status line segment: re-renders on next TUI frame (already happens automatically since segment reads from ProfileService singleton)
- Future integrations: any component can subscribe via `session.eventBus.on("f5xc:profile-changed", handler)`

### 6.3 Cross-Tool Signaling

The integration with vscode-f5xc-tools and f5xc-xcsh requires no protocol — it operates entirely through the shared file system:

```
xcsh writes active_profile
    ↓
VS Code extension's fs.watch() fires
    ↓
VS Code clears auth cache, refreshes tree providers
```

```
VS Code writes active_profile
    ↓
xcsh file watcher fires (Phase 2)
    ↓
xcsh reloads profile, updates bash.environment
```

**Contract:** The `active_profile` file contains only the profile name as plain text with no trailing newline. Both tools write atomically (temp file + rename).

### 6.4 Settings API Usage Summary

| Operation | Settings API Call | Persisted? |
|-----------|------------------|-----------|
| Load profile credentials | `settings.override("bash.environment", envMap)` | No (in-memory) |
| Clear credentials on deactivate | `settings.clearOverride("bash.environment")` | No |
| Read credentials in bash tool | `settings.get("bash.environment")` | N/A (read) |
| Add profile.f5xc segment to defaults | Schema change in `settings-schema.ts` | Yes (schema) |

---

## 7. Error Handling Design

### 7.1 Error Taxonomy

| Error Category | Examples | Severity | User Impact |
|---------------|----------|----------|-------------|
| **File not found** | `active_profile` missing, profile JSON missing | Info | Silent skip on startup; error message on explicit command |
| **Parse error** | Invalid JSON in profile file | Warning | Logged warning on startup; error message on command |
| **Validation error** | Missing `apiUrl` or `apiToken` in profile | Warning | Logged warning; profile skipped |
| **Permission error** | Cannot read/write profile files | Error | Error message to user with suggested fix |
| **Write failure** | Cannot write `active_profile` or profile JSON | Error | Activation rolled back [NFR-402]; error message |
| **Watcher failure** | `fs.watch()` dies silently | Warning | Logged; stale indicator appears on status bar |

### 7.2 Error Recovery Strategies

**Startup errors:**
```
try { await profileService.loadActive(); }
catch { logger.warn(...); }  // Always continue startup
```

**Slash command errors:**
```
try { await service.activate(name); }
catch (err) {
  if (err instanceof ProfileError) ctx.showError(err.message);
  else ctx.showError(`Unexpected error: ${String(err)}`);
}
```

**File watcher errors:**
```
// In debounced callback:
try { ... reload ... }
catch (err) {
  logger.warn("F5XC profile watcher error", { error: String(err) });
  // Keep existing credentials — don't clear on error
}
```

### 7.3 User-Facing Error Messages

| Scenario | Message |
|----------|---------|
| Profile not found | `Profile '<name>' not found. Run /profile list to see available profiles.` |
| Invalid profile JSON | `Profile '<name>' contains invalid JSON.` |
| Missing required field | `Profile '<name>' is missing the apiUrl field.` |
| Cannot write active_profile | `Could not switch profiles: permission denied on ~/.config/f5xc/active_profile` |
| Delete active profile | `Cannot delete the active profile. Activate a different profile first.` |
| Invalid profile name | `Profile name must be alphanumeric with dashes/underscores, max 64 chars.` |
| Invalid URL | `API URL must start with https://` |
| No profiles exist | `No F5 XC profiles found. Use /profile create or ask me to help set one up.` |
| No active profile | `No active profile. Use /profile activate <name> first.` |

---

## 8. File Specifications

### 8.1 New Files

| File | Purpose | Phase | Lines (est.) |
|------|---------|-------|-------------|
| `packages/coding-agent/src/services/f5xc-profile.ts` | ProfileService class | 1 | ~250 |
| `skills/f5xc-auth-wizard/SKILL.md` | Setup wizard skill | 2 | ~80 |

### 8.2 Modified Files

| File | Change | Phase | Impact |
|------|--------|-------|--------|
| `packages/utils/src/dirs.ts` | Add 4 F5XC path helper functions | 1 | ~20 lines added |
| `packages/coding-agent/src/config/settings-schema.ts` | Add `bash.environment` schema entry; add `"profile.f5xc"` to `StatusLineSegmentId` | 1 | ~10 lines added |
| `packages/coding-agent/src/exec/bash-executor.ts` | Read `bash.environment` from settings; merge into subprocess env | 1 | ~8 lines added |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | Add `/profile` command entry with handler | 1 | ~120 lines added |
| `packages/coding-agent/src/modes/components/status-line/segments.ts` | Add `profile.f5xc` segment renderer | 1 | ~15 lines added |
| `packages/coding-agent/src/main.ts` | Add ProfileService init + loadActive() call in startup | 1 | ~6 lines added |

### 8.3 Implementation Order

```
Step 1: packages/utils/src/dirs.ts               (path helpers — no dependencies)
Step 2: packages/coding-agent/src/config/settings-schema.ts  (schema — no dependencies)
Step 3: packages/coding-agent/src/exec/bash-executor.ts      (env injection — depends on Step 2)
Step 4: packages/coding-agent/src/services/f5xc-profile.ts   (ProfileService — depends on Steps 1, 2)
Step 5: packages/coding-agent/src/slash-commands/builtin-registry.ts  (slash command — depends on Step 4)
Step 6: packages/coding-agent/src/modes/components/status-line/segments.ts  (segment — depends on Step 4)
Step 7: packages/coding-agent/src/main.ts         (startup wiring — depends on Step 4)
```

Steps 5 and 6 can be done in parallel after Step 4.

### 8.4 SRS Requirement Coverage

| SRS Requirement | SDD Section | Design Module |
|----------------|-------------|---------------|
| FR-101 Startup detection | §3.1.2 loadActive(), §4.1 | ProfileService |
| FR-102 Credential precedence | §3.1.2 loadActive() step 1 | ProfileService |
| FR-103 Environment injection | §3.1.2 #applyToSettings(), §3.4 | ProfileService + bash-executor |
| FR-104 Auto-activate single | §3.1.2 loadActive() step 2b | ProfileService |
| FR-105 Graceful errors | §7.1, §7.2 | ProfileService |
| FR-201 /profile list | §3.2.3 handleList | Slash command |
| FR-202 /profile activate | §3.2.3 handleActivate | Slash command |
| FR-203 /profile show | §3.2.3 handleShow | Slash command |
| FR-204 /profile status | §3.2.3 handleStatus | Slash command |
| FR-205 /profile create | §3.2.3 handleCreate | Slash command |
| FR-206 /profile delete | §3.2.3 handleDelete | Slash command |
| FR-301 bash.environment schema | §3.3 | Settings schema |
| FR-302 Bash tool reads bash.env | §3.4 | bash-executor |
| FR-401 Status bar segment | §3.5 | Status line segment |
| FR-402 Stale warning | §3.5 (Phase 2) | Status line segment |
| FR-501 First-run detection | §3.7 | Setup wizard skill |
| FR-502 Wizard flow | §5.3, §3.7 | Setup wizard skill |
| FR-503 Error recovery guidance | §3.7 troubleshooting section | Setup wizard skill |
| FR-601 File watcher | §3.1.2 startWatcher() | ProfileService |
| FR-602 Watcher lifecycle | §3.1.2 stopWatcher() | ProfileService |
| FR-701 Directory init | §3.1 createProfile() | ProfileService |
| FR-702 Atomic file write | §3.1 createProfile() | ProfileService |
| FR-703 Active profile write | §3.1.2 activate() | ProfileService |
| NFR-101 Token masking | §3.1.2 #maskToken(), §3.2.3 handleShow | ProfileService + Slash command |
| NFR-102 File permissions | §3.1 createProfile() | ProfileService |
| NFR-103 Credential isolation | §3.7 skill security rules | Setup wizard skill |
| NFR-104 Prompt injection | §3.7 skill security rules | Setup wizard skill |
| NFR-201 Cross-tool compat | §6.3 | File system signaling |
| NFR-202 XDG compliance | §3.6 | Path helpers |
| NFR-203 Backward compat | §6.1 (try/catch wrapping) | Startup integration |
| NFR-301 Startup < 10ms | §6.1 (1-2 file reads) | Startup integration |
| NFR-302 Watcher overhead | §3.1.2 (persistent: false, 500ms debounce) | ProfileService |
| NFR-401 Crash isolation | §7.2 | Error handling |
| NFR-402 Atomic transitions | §3.1.2 activate() | ProfileService |

---

*End of Software Design Document*