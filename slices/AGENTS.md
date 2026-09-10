# slices — Consolidated Vertical Slice Architecture

## Purpose

Feature slices composing crew-of-pi. Consolidated lean architecture with 7 core slice modules and shared persistence/types:
- `slices/agents.ts` — Agent discovery, registry, and `crew_list` tool
- `slices/spawn.ts` — In-process subagent spawning, SDK session lifecycle, `crew_spawn`, `crew_log`, `crew_inject` tools
- `slices/chain.ts` — Sequential chain runner and `crew_chain` tool
- `slices/lifecycle.ts` — `crew_abort`, `crew_respond`, and `crew_done` tools
- `slices/prompt.ts` — System prompt injector for subagent capabilities
- `slices/widget.ts` — TUI status widget, store, and updater
- `slices/config.ts` — `/crew-of-pi` configuration slash command
- `slices/db.ts` — SQLite persistence (`SubagentDb` & `MessageBus`)

## Ownership

- **slices/agents.ts** — Discovers bundled/user/project `.md` agents, handles config overrides, manages registry, and renders `crew_list` tool.
- **slices/spawn.ts** — Manages in-process `AgentSession` spawns via pi SDK, isolates contexts, inherits user extensions with anti-recursion filtering, concurrency gating (max 4), and monitoring tools (`crew_log`, `crew_inject`).
- **slices/chain.ts** — Runs multi-step sequential pipelines with `{previous}` variable interpolation.
- **slices/lifecycle.ts** — Session cleanup and subagent lifecycle management tools (`crew_abort`, `crew_respond`, `crew_done`).
- **slices/prompt.ts** — Injects available crew members, skills, and tools into the main agent's prompt context.
- **slices/widget.ts** — Real-time TUI widget rendering active/settled subagents and token consumption.
- **slices/config.ts** — CLI config manager for model overrides and crew settings.
- **slices/db.ts** — Native SQLite schema and queries for session recovery, turn events, and inter-agent messages.

## Local Contracts

1. **Flat slice layout** — Each concern lives in a single concise file (`slices/{concern}.ts`).
2. **Shared types in `shared/types.ts`** — Central contract for cross-slice interfaces (`AgentConfig`, `SubagentHandle`, `CrewConfig`, etc.).
3. **Singleton access** — Registries, stores, and databases exposed via `get*()` singletons and refreshed/reset on lifecycle events.
4. **Extension inheritance & recursion protection** — Subagents inherit installed extensions, but `crew-of-pi` is filtered out during spawn to prevent recursive loops.
5. **Concurrency limit** — Max 4 concurrent subagent sessions.

## Verification

- `npx -y typescript --noEmit --module esnext --target es2022 --moduleResolution bundler --skipLibCheck index.ts slices/*.ts shared/*.ts` passes with 0 errors.
- Clean shutdown disposing child sessions without orphaned locks.
