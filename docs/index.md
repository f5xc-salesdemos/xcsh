---
title: XCSh Documentation
sidebar:
  order: 0
  label: Overview
---

XCSh is an AI-powered development CLI with a TypeScript coding agent and a
Rust native layer (`pi-natives`). It extends the open-source
[`badlogic/pi-mono`](https://github.com/badlogic/pi-mono) line with a
hardened runtime, long-lived sessions with tree navigation and compaction,
a Python IPython tool, full MCP support, a skills system, and platform
packaging targeting Linux, macOS, and Windows.

## Where to start

- **Configuration** — how xcsh discovers, resolves, and layers configuration.
- **Runtime & Tools** — the bash / notebook / resolve tool runtimes and the
  slash-command surface.
- **Sessions** — append-only entry log, tree navigation, compaction, and the
  autonomous memory system.
- **Natives (Rust)** — architecture of the `pi-natives` N-API addon that
  powers shell / PTY / media / search.
- **MCP** — configuration, protocol internals, runtime lifecycle, and how to
  author servers and tools.
- **Extensions, Skills & Plugins** — authoring, loading, matching rules, the
  marketplace, and the plugin installer.
- **Providers & Models** — model configuration, streaming internals, and the
  Python / IPython runtime.
- **TUI** — theming, the `/tree` command, and integration hooks for
  extensions and custom tools.

## How this doc set is organized

Each top-level group in the sidebar maps to a subsystem of the agent. Within
a group, pages run from "overview" to "internals" so you can stop reading
when you have enough context for the task at hand.
