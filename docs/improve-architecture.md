# Architecture Improvement — Unify Lifecycle Triplet

## Date

2025-06-18

## Motivation

The lifecycle slice had three tools (`crew_abort`, `crew_done`, `crew_respond`) each inlining the same four-step pattern:

1. Find handle in registry
2. Validate session ownership
3. Mutate registry/persist
4. Sync widget

This caused bugs: `crew_abort` forgot to sync widget; `crew_done` didn't share `session.dispose()` logic. Each tool was a fragile copy of the same pattern.

## What Changed

### New file: `slices/lifecycle/lifecycle.shared.ts`

Extracts two shared functions:

- **`validateOwnership(subagentId, registry, callerSessionId)`** — returns `{ ok, handle }` or a standardized error response (`not found` / `foreign session`). All three tools now use this instead of inline `getRunningById` + ownership check.
- **`doneSubagent(handle, registry, pi)`** — marks handle as completed, persists result entry, syncs widget. Used by `crew_done` (and any future lifecycle tool).

### Refactored: `slices/lifecycle/lifecycle.done.ts`

Before: ~65 lines with inline find-validate-mark-persist-sync.
After: ~40 lines — calls `validateOwnership` then `doneSubagent`.

### Refactored: `slices/lifecycle/lifecycle.respond.ts`

Before: inline find + validate + respond logic interleaved.
After: `validateOwnership` separates concern; respond-specific logic (interactive check, bus send) remains in the tool.

### Refactored: `slices/lifecycle/lifecycle.abort.ts`

Single-id path: inline find + validate -> `validateOwnership`.
`abortSubagent` helper (extracted in earlier abort-race fix) remains as-is — it owns the multi-layer abort sequence (AbortController, session.abort, session.dispose, persist, widget sync).

## Depth Gained

| Before | After |
|--------|-------|
| 3 files, each inlining the same pattern | 1 shared module + 3 thin tools |
| Ownership validation in 3 places (drift risk) | Ownership validation in 1 place |
| Widget sync decisions scattered | Widget sync guaranteed by shared helpers |
| Adding a 4th lifecycle tool = copy-paste 4 steps | Adding = call `validateOwnership` + call shared operation |

## File Changes

```
slices/lifecycle/
├── lifecycle.abort.ts    — 14 lines shorter, uses validateOwnership
├── lifecycle.done.ts     — 25 lines shorter, uses validateOwnership + doneSubagent
├── lifecycle.respond.ts  — 12 lines shorter, uses validateOwnership
├── lifecycle.shared.ts   — NEW: validateOwnership(), doneSubagent()
└── lifecycle.types.ts    — unchanged
```

## Not Changed

- `lifecycle.types.ts` — kept as-is (used by other slices via import)
- `AbortSubagent()` helper — stays in `lifecycle.abort.ts` (abort-specific multi-step)
- Tool registration/renderCall/renderResult — tool-specific UI code stays in each tool file
