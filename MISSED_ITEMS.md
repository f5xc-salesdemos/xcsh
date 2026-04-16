# Rebase Regression Audit — Missed Items

Items found during line-by-line audit of pre-rebase fork (`1b3e09823`) vs current main.

## Status

| # | Item | Severity | Status |
|---|------|----------|--------|
| 1 | MCP startup message visible | CRITICAL | PENDING |
| 2 | F5 XC profile auto-load removed | CRITICAL | PENDING |
| 3 | LiteLLM discovery auto-wait removed | HIGH | PENDING |
| 4 | SearchDb native integration removed | HIGH | ACCEPTED (upstream removed type) |
| 5 | Python executor lifecycle features | HIGH | PENDING |
| 6 | Bash async job integration (partial) | MEDIUM | PENDING VERIFICATION |
| 7 | turbo.json removed | MEDIUM | ACCEPTED (upstream change) |
| 8 | CI affected-only test paths | MEDIUM | ACCEPTED (upstream change) |
| 9 | GitHub Copilot model definitions | LOW | ACCEPTED (upstream change) |
| 10 | Prompt template changes | LOW | ACCEPTED (upstream improvements) |

## Previously Restored (PRs #94, #95)

- Theme defaults (xcsh-dark, xcsh-light, nerd, xcsh preset, powerline)
- Feature flag defaults (memories, STT, GitHub, calc, Mermaid, etc.)
- ProfileService obfuscator integration (sdk.ts)
- SECRET_ENV_PATTERNS masking (bash.ts)
- LiteLLM login handler (selector-controller.ts)
- LiteLLM auto-config probe (model-registry.ts)
- GutterBlock unwrapping (selector-controller.ts)
- Preset-separator sync (selector-controller.ts)
- Upstream PR #721 (anthropic litellm passthrough)
- Vim throttle fix (ex-command onUpdate)
