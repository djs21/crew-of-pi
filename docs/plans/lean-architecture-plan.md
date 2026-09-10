# Lean Architecture Plan: crew-of-pi Refactoring

**Date**: 2026-09-10  
**Epic**: `crew-of-pi-cnb`  
**Status**: Approved / Ready for Implementation  
**Methodology**: Ponytail & YAGNI Ladder (Eliminate artificial complexity, preserve 100% functionality)

---

## 1. Executive Summary & Goals

`crew-of-pi` provides multi-subagent orchestration for the pi coding agent. While the core engine (in-process `createAgentSession`, SQLite persistence, steering messages) is solid, the implementation suffered from severe **file over-fragmentation** (32 files for <5k LOC), **over-engineered UI loops** (800+ lines for config), and **artificial restrictions** (blocking the main agent from writing code).

### Core Goals:
1. **Reduce File Count**: 32 files across 10 micro-slices $\rightarrow$ 8 consolidated slice files + 1 shared type file + `index.ts`.
2. **Reduce LOC**: Eliminate ~35-40% of code bloat (unneeded imports, single-use type definitions, 800-line config wizard loops).
3. **Full Extension Inheritance for Subagents**: Subagents inherit all user extensions (e.g. `hashline-edit-pro`, `codegraph`, `browser-search`) with only `crew-of-pi` / `crew_*` tools filtered out to prevent infinite recursion.
4. **Remove Main-Agent Blocker**: Delete `slices/blockers/`. The main agent is an autonomous enabler with delegation powers, not a restricted read-only agent.
5. **Clean DB & Comms**: Unified SQLite persistence in `slices/db.ts`, pruning dead methods (`getAllStatuses`, `getUnreadFor`, `clear`) and unused indexes.
6. **Zero Loss of Capability**: Retain all 8 tools (`crew_spawn`, `crew_chain`, `crew_list`, `crew_abort`, `crew_respond`, `crew_done`, `crew_log`, `crew_inject`), 5 bundled roles, SQLite persistence, live widget, and templates.

---

## 2. Target File Structure

```
crew-of-pi/
├── index.ts                      # Clean extension wiring & lifecycle hooks
├── package.json
├── AGENTS.md                     # Updated DOX root contracts
│
├── shared/
│   └── types.ts                  # Centralized cross-slice type contracts
│
├── slices/                       # 8 Lean Consolidated Slices (Flat)
│   ├── agents.ts                 # Discovery + Registry + crew_list tool
│   ├── spawn.ts                  # crew_spawn + in-process session manager + crew_log/inject
│   ├── db.ts                     # SubagentDb + MessageBus SQLite persistence (pruned & unified)
│   ├── chain.ts                  # crew_chain tool + sequential orchestrator + template injection
│   ├── lifecycle.ts              # crew_abort, crew_respond, crew_done tools
│   ├── prompt.ts                 # System prompt injector (orchestration guidance without blockers)
│   ├── widget.ts                 # Store + updater + renderer
│   └── config.ts                 # Lean slash command & config management (~150-200 lines)
│
├── agents/                       # 5 bundled subagent definitions (.md)
│   ├── worker.md
│   ├── scout.md
│   ├── researcher.md
│   ├── planner.md
│   └── reviewer.md
│
├── prompts/                      # Workflow templates
│   ├── implement.md
│   └── research.md
│
└── docs/
    └── plans/
        └── lean-architecture-plan.md
```

---

## 3. Detailed Component Specifications

### 3.1 `shared/types.ts` (Centralized Type Contract)
- Consolidate all shared interfaces into one file:
  - `AgentConfig`, `AgentFrontmatter`, `SubagentHandle`, `SubagentStatus`, `UsageStats`
  - `CrewConfig` (unified single source of truth, removing duplicates)
  - `ChainStepConfig`, `ChainStepResult`, `ChainProgress`
  - `WidgetEntry`, `WidgetStoreState`
  - `generateId()` helper

### 3.2 `slices/agents.ts` (Discovery, Registry, & Listing)
- **Merge**: `slices/agents/agents.discovery.ts`, `slices/agents/agents.registry.ts`, `slices/crew-list/crew-list.tool.ts`.
- **Discovery**: 3-level cascade (`project` > `user` > `bundled`). Frontmatter parser + config JSON override.
- **Registry**: Singleton in-memory registry, `restoreFromDb()`, active subagent lookup.
- **Tool**: `crew_list` tool registered directly alongside registry.

### 3.3 `slices/spawn.ts` (Spawn Engine, Session Manager, & Monitoring)
- **Merge**: `slices/spawn/spawn.tool.ts`, `slices/spawn/spawn.manager.ts`, `slices/spawn/spawn.monitor.ts`.
- **In-Process Sessions**: Uses `createAgentSession()` from `@earendil-works/pi-coding-agent`.
- **Extension Inheritance**: Subagents inherit user extensions. The loader explicitly skips `crew-of-pi` itself and filters out `crew_*` tools to block recursion.
- **Concurrency Limiter**: Max 4 parallel subagents semaphore.
- **Tools**: `crew_spawn`, `crew_log`, `crew_inject`.

### 3.4 `slices/db.ts` (Unified SQLite Persistence)
- **Merge & Prune**: `slices/spawn/spawn.db.ts` + `slices/comms/comms.ts`.
- **Tables**:
  - `subagent_status`: `id`, `agent_name`, `status`, `turns`, `input_tokens`, `output_tokens`, `owner_session`, `created_at`, `updated_at`, `last_heartbeat`.
  - `subagent_events`: `id`, `subagent_id`, `event_type`, `data`, `timestamp`.
  - `crew_messages`: `id`, `from_agent`, `to_agent`, `message_type`, `content`, `payload`, `timestamp`.
- **Pruned Dead Code**:
  - Delete `SubagentDb.getAllStatuses()`.
  - Delete `idx_subagent_status_owner` index.
  - Delete `MessageBus.getUnreadFor()`, `MessageBus.clear()`.
  - Replace timestamp delete query on start with bounded cleanup.

### 3.5 `slices/chain.ts` (Sequential Chain Orchestration)
- **Merge**: `slices/chain/chain.tool.ts`, `slices/chain/chain.orchestrator.ts`, `slices/chain/chain.types.ts`.
- **Workflow**: Step-by-step sequential execution.
- **Template Injection**: `{previous}` placeholder replaces prior step output into next prompt.
- **Tool**: `crew_chain`.

### 3.6 `slices/lifecycle.ts` (Abort, Respond, Done)
- **Merge**: `slices/lifecycle/lifecycle.abort.ts`, `slices/lifecycle/lifecycle.respond.ts`, `slices/lifecycle/lifecycle.done.ts`, `slices/lifecycle/lifecycle.shared.ts`, `slices/lifecycle/lifecycle.types.ts`.
- Combined ~80-line clean module exposing `crew_abort`, `crew_respond`, `crew_done` with shared ownership validation.

### 3.7 `slices/prompt.ts` (System Prompt Injection)
- **Merge**: `slices/prompt/prompt.injector.ts`, `slices/prompt/prompt.types.ts`.
- Injects available subagents, capabilities, and delegation best practices into main agent system prompt on `before_agent_start`.
- **No Blocker Rules**: Informs agent how to delegate without imposing tool call rejections.

### 3.8 `slices/widget.ts` (TUI Live Status Widget)
- **Merge**: `slices/widget/widget.store.ts`, `slices/widget/widget.updater.ts`, `slices/widget/widget.renderer.ts`, `slices/widget/widget.types.ts`.
- Single clean module managing widget state, session hooks, and rendering.

### 3.9 `slices/config.ts` (Lean Config Management)
- **Merge & Simplify**: Replace 6 files (`slices/config/*`, 800+ lines) with a concise ~150-line module.
- Provide simple slash command `/crew-of-pi config` with direct subcommands:
  - `/crew-of-pi config` $\rightarrow$ shows current config
  - `/crew-of-pi config model <agent> <model>` $\rightarrow$ sets model override
  - `/crew-of-pi config reset` $\rightarrow$ resets to defaults
  - Interactive single-step picker using standard `ctx.ui.select` when invoked without arguments.

### 3.10 `slices/blockers/` (DELETED)
- Entire directory removed. Main agent retains full native capability.

---

## 4. Implementation Steps & Beads Work Breakdown

| Task ID | Priority | Scope | Description |
|---|---|---|---|
| `crew-of-pi-cnb.8` | P1 | Types | Unify & centralize all cross-slice types in `shared/types.ts`. |
| `crew-of-pi-cnb.7` | P2 | DB & Comms | Consolidate `slices/db.ts`, prune dead methods and unused indexes. |
| `crew-of-pi-cnb.1` | P1 | Lifecycle | Merge 5 lifecycle files into `slices/lifecycle.ts`. |
| `crew-of-pi-cnb.2` | P1 | Prompt & Blocker Removal | Create `slices/prompt.ts` and delete `slices/blockers/`. |
| `crew-of-pi-cnb.3` | P1 | Chain | Merge chain slice files into `slices/chain.ts`. |
| `crew-of-pi-cnb.4` | P2 | Agents & List | Merge discovery, registry, and `crew_list` into `slices/agents.ts`. |
| `crew-of-pi-cnb.9` | P1 | Spawn Engine | Consolidate `slices/spawn.ts` with extension inheritance + anti-recursion. |
| `crew-of-pi-cnb.10`| P2 | Widget | Consolidate widget store, updater, renderer into `slices/widget.ts`. |
| `crew-of-pi-cnb.5` | P2 | Config | Consolidate config command into lean `slices/config.ts`. |
| `crew-of-pi-cnb.6` | P1 | Wiring & DOX | Rewire `index.ts`, delete obsolete folders, update DOX `AGENTS.md`. |

---

## 5. Verification Plan

1. **Static Analysis**: Verify TypeScript imports, syntax, and zero circular dependencies.
2. **Tool Registration**: Verify all 8 `crew_*` tools register cleanly with pi extension API.
3. **Subagent Spawn**: Test spawning `scout` and `worker` with full extension access (ensure `crew_*` tools are omitted from subagents).
4. **Sequential Chain**: Verify `/implement` workflow and `{previous}` string template injection.
5. **Session Persistence**: Verify SQLite state update, heartbeat, and orphaning cleanup.
6. **DOX Compliance**: Verify all `AGENTS.md` contracts reflect the flat 8-slice structure.
