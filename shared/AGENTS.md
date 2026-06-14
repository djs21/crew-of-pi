# shared — Cross-Slice Type Contracts

## Purpose

Shared TypeScript interfaces and constants that all slices depend on. This is the ONLY source of truth for cross-slice type contracts.

## Ownership

| Export | Purpose |
|--------|---------|
| `AgentConfig` | Full agent definition loaded from frontmatter |
| `SubagentHandle` | Runtime handle for a spawned subagent process |
| `SpawnConfig` / `SpawnResult` | Spawn tool parameter/result types |
| `ChainConfig` / `ChainHandle` / `ChainStepResult` | Chain workflow types |
| `SubagentMessage` / `BusEntry` | Inter-agent bus types |
| `WidgetState` / `WidgetEntry` | TUI widget state |
| `UsageStats` / `INITIAL_USAGE` | Token/cost tracking |
| `generateId()` | Unique ID generation |
| `MAX_PARALLEL_TASKS` / `MAX_CONCURRENCY` / `PER_TASK_OUTPUT_CAP` | Global limits |

## Local Contracts

1. **No runtime code** — only types, interfaces, constants, and pure utility functions (e.g., `generateId`)
2. **No imports from slices** — this file is a dependency leaf; slices import from here, never the reverse
3. **Breaking changes** require updating all slices that reference the changed type
4. **Slice-private types** belong in each slice's `*.types.ts` file, not in shared

## Work Guidance

- Add new types here only when they cross slice boundaries
- Use JSDoc on all exported interfaces
- Keep constants minimal — only globally-scoped limits go here

## Verification

- Every export must have at least one import from another slice
- No slice import statements pointing to `shared/types.ts` should reference non-existent exports

## Child DOX Index

No child AGENTS.md files.
