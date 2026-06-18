# Architecture Improvements

| # | Candidate | Status | Date |
|---|-----------|--------|------|
| 2 | **Unify lifecycle triplet** — shared ownership validation for abort/done/respond | ✅ Done | 2025-06-18 |
| 1 | **Collapse agent discovery pipeline** — 5 files → 2 (config, frontmatter, types merged into discovery) | ✅ Done | 2025-06-18 |
| 3 | **Eliminate dual handle in spawn** — ONE handle per subagent, mutated in-place | ✅ Done | 2025-06-18 |
| 4 | Collapse comms slice (4 files → 1) | ⏳ Pending | — |
| 5 | Chain step type dedup | ⏳ Pending | — |

---

## #2: Unify Lifecycle Triplet

**Date:** 2025-06-18

### Motivation

Three lifecycle tools inlined the same four-step pattern: find handle → validate ownership → mutate registry/persist → sync widget. Each was a fragile copy. `crew_abort` forgot widget sync; `crew_done` didn't share `session.dispose()`.

### What Changed

#### New file: `slices/lifecycle/lifecycle.shared.ts`

- **`validateOwnership(subagentId, registry, callerSessionId)`** — returns `{ ok, handle }` or standardized error response. Replaces inline pattern in all 3 tools.
- **`doneSubagent(handle, registry, pi)`** — marks completed, persists, syncs widget.

#### Refactored tools

- `lifecycle.abort.ts` — single-id path uses `validateOwnership`
- `lifecycle.done.ts` — ~40 lines (was 84), uses both shared helpers
- `lifecycle.respond.ts` — uses `validateOwnership`, respond-specific logic stays

### Depth Gained

| Before | After |
|--------|-------|
| 3 files inlining same pattern | 1 shared module + 3 thin tools |
| Ownership validation in 3 places | Ownership validation in 1 place |
| Widget sync decisions scattered | Widget sync guaranteed by shared helpers |

---

## #1: Collapse Agent Discovery Pipeline

**Date:** 2025-06-18

### Motivation

Five files for one linear pipeline. `frontmatter.ts` (59 lines) wraps one SDK call. `config.ts` (148 lines) is three functions loaded by `discovery.ts` and `registry.ts`. `types.ts` (36 lines) is two interfaces used within the slice. Deletion test: delete frontmatter.ts, config.ts, types.ts → 0 complexity moves to callers.

### What Changed

- Merged: `agents.frontmatter.ts`, `agents.config.ts`, `agents.types.ts` → into `agents.discovery.ts`
- Kept: `agents.registry.ts` — query interface over discovery cache (separate concern: running subagent tracking)
- Removed unused exports: `ExtensionResolverResult`, `DiscoveryOptions`, `makeParsedDoc`

### File Changes

```
slices/agents/
├── agents.discovery.ts   — 556 lines (was 366), now owns full discovery pipeline
├── agents.registry.ts    — unchanged (1 import path updated)
```

*Deleted: agents.config.ts, agents.frontmatter.ts, agents.types.ts*

### Depth Gained

| Before | After |
|--------|-------|
| 5 files for one pipeline | 2 files: discovery (deep) + registry (query seam) |
| Pipeline understanding requires 5 file reads | Pipeline understanding requires 1 file read |
| Config + frontmatter = pass-through wrappers | Logic concentrated, exports intentional |

### Cross-slice imports unchanged

- `index.ts`: `setBundledAgentsDir` still from `agents.discovery`
- `spawn.tool.ts`, `chain.orchestrator.ts`: `findAgent` still from `agents.discovery`
- All `getAgentRegistry` still from `agents.registry`

---

## #3: Eliminate Dual Handle in Spawn

**Date:** 2025-06-18

### Motivation

`spawnSubagentProcess` created its own internal `SubagentHandle`, set status on it through the lifecycle (abort handler → after prompt → catch), then returned it. The caller (`spawnSubagentAsync`) copied status/turns/session/usage fields to the outer handle. Two objects for one subagent. The abort-race fix needed guards (`if status !== "aborted"`) to prevent overwrite — a symptom of the split.

### What Changed

- Renamed `spawnSubagentProcess` → `spawnSubagentSession` — clarifies it owns *session* lifecycle, not handle lifecycle
- `spawnSubagentSession` now accepts `handle: SubagentHandle` as param, mutates it in-place
- Returns `{ output, session, sessionFile }` — no handle in return type
- `spawnSubagentAsync` creates ONE handle, passes it directly — no field copying after call
- `chain.orchestrator.ts` passes `chainHandle` directly — no `spawnResult.handle.*` field copying

### Depth Gained

| Before | After |
|--------|-------|
| Inner handle created, status set, returned, fields copied | One handle, mutated in-place |
| `finalStatus` variable to reconcile inner vs outer | `handle.status` is the single source of truth |
| Guards needed to prevent status overwrite | Guards still exist but are fallbacks, not workarounds |
| Chain ORM had `spawnResult.handle.*` copy pattern | Chain reads `chainHandle.status` directly |
