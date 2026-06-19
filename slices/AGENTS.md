# slices — Vertical Slice Architecture

## Purpose

Self-contained feature slices that compose crew-of-pi. Each slice owns one capability — agent discovery, subagent spawning, write-blocking, prompt injection, chain workflows, inter-agent communication, lifecycle management, TUI widget, and agent listing.

Slices are designed to be independently developable, testable, and removable by adding/removing one import in `index.ts`.

## Ownership

- **slices/agents/** — Agent discovery, frontmatter parsing, extension resolution, config overrides, and in-memory registry
- **slices/spawn/** — Async subagent process spawning, JSON-line streaming, concurrency tracking, steering delivery
- **slices/blockers/** — Tool-call interceptor blocking `write`/`edit` on main agent
- **slices/prompt/** — System prompt injection making main agent aware of its crew
- **slices/chain/** — Sequential multi-agent workflow with `{previous}` placeholder
- **slices/comms/** — Inter-agent message bus, relay to main, session persistence
- **slices/lifecycle/** — `crew_abort`, `crew_respond`, `crew_done` tools
- **slices/widget/** — TUI status widget renderer, store, and updater
- **slices/crew-list/** — `crew_list` tool listing agents and running subagents
- **slices/config/** — `/crew-of-pi config` slash command: interactive config editor for model, extensions, skills, and main agent tool policy
  - `config.command.ts` — thin orchestrator: handler routing, autocomplete, registration
  - `config.types.ts` — shared interfaces, constants, tool list
  - `config.helpers.ts` — config I/O, discovery, validation
  - `config.wizard.ts` — per-agent wizard (model, extensions, skills)
  - `config.main-agent.ts` — main agent tool toggle wizard

## Local Contracts

1. **No cross-slice runtime imports** — slices communicate through `shared/types.ts` interfaces only. Exception: `widget.updater.ts` is called from other slices via `syncWidgetFromRegistry()`.
2. **Shared types in `shared/types.ts`** — `AgentConfig`, `SubagentHandle`, `UsageStats`, `SpawnConfig`, `ChainConfig`, `SubagentMessage`, `WidgetEntry`. Each slice has its own `*.types.ts` for slice-private types.
3. **Singleton access** — `AgentRegistry`, `MessageBus`, `WidgetStore` are singletons accessed via `get*()` functions. Reset on session shutdown.
4. **Session persistence** — State stored via `pi.appendEntry()` with custom entry types: `crew-subagent-spawn`, `crew-subagent-result`, `crew-bus-message`, `crew-chain-step`.
5. **Extension loading** — Subagents load only extensions listed in their frontmatter, controlled via `extensionsOverride` filter in `DefaultResourceLoader`.
6. **Concurrency limit** — Max `MAX_CONCURRENCY` (4) parallel subagent spawns via `ConcurrencyTracker` semaphore.

## Work Guidance

- When adding a new feature, create a new folder under `slices/` with `*.types.ts`, `*.module.ts`, and a tool file if needed
- Register tools in the slice file, import and mount in `index.ts`
- Keep `index.ts` as a thin assembly — logic belongs in slices
- Use `gitkeep` files for empty slice directories
- Slice files use the naming convention `{slice}.{concern}.ts` (e.g., `agents.registry.ts`, `spawn.manager.ts`)

## Verification

- Entry point `index.ts` must compile with all slice imports
- No dead exports — each exported function must be imported by another slice or registered as a tool
- `typebox` schemas in tool registration must match actual parameter structures
- Singleton state must reset in `session_shutdown`

## Child DOX Index

No child AGENTS.md files. Each slice folder is too granular for its own doc — this file covers all slices collectively.
