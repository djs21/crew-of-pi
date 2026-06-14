# Migrasi spawn: child_process → createAgentSession

## Ringkasan

Migrasi core spawning logic dari `child_process.spawn("pi", ...)` ke
pi SDK-native `createAgentSession(...)`. Menutup gap #9 (session naming
+ persistence) sekaligus menyederhanakan kode, menghemat memory ~3-5x,
dan menghilangkan workaround `parseJsonLines` untuk turn tracking.

---

## Motivasi

| Masalah saat ini | Solusi dengan createAgentSession |
|---|---|
| Widget "0 turn" — parseJsonLines tanpa live bridge | `session.subscribe("turn_end")` — native, real-time |
| Session tidak punya nama (`--no-session`) | `session.setSessionName("crew: worker · ...")` |
| Subagent tidak bisa di-resume | Session file auto-persisted oleh pi |
| pi session list kosong | Semua subagent muncul dengan nama |
| No context compaction untuk subagent | pi compaction built-in |
| Memory: duplikasi pi runtime per subagent (+120MB/spawn) | Shared runtime: hanya +3MB/spawn |

---

## Cakupan Perubahan

### File yang diubah

| File | Perubahan | Baris |
|------|-----------|-------|
| `slices/spawn/spawn.manager.ts` | Rewrite `spawnSubagentProcess` | −120, +90 |
| `slices/spawn/spawn.types.ts` | Hapus child_process-specific types | −40 |
| `slices/spawn/spawn.tool.ts` | Minor: import + call signature | ±5 |
| `index.ts` | Setup resource loader + session manager | +20 |
| `shared/types.ts` | Tidak berubah | 0 |

### File yang bisa dihapus / dead code

| Kode | Lokasi | Alasan |
|------|--------|--------|
| `getPiInvocation()` | spawn.types.ts | Tidak perlu spawn pi binary |
| `parseJsonLines()` | spawn.manager.ts | Diganti `session.subscribe` |
| `ParseState` interface | spawn.manager.ts | Tidak relevan |
| `StreamingResult` type | spawn.types.ts | Diganti session API |
| `buildSpawnArgs()` | spawn.manager.ts | Tidak perlu build CLI args |
| `writePromptToTempFile()` | spawn.manager.ts | System prompt via resourceLoader |
| Temp dir management | spawn.manager.ts | Tidak perlu |
| `formatTokens()` (duplicate) | spawn.manager.ts | Sudah ada di widget.renderer.ts |
| `getFinalOutput()` | spawn.manager.ts | Diganti `getLastAssistantMessage` |
| `_activeTempDirs` / `trackTempDir` | spawn.manager.ts | Tidak perlu |
| `cleanupTemp()` | spawn.manager.ts | Tidak perlu |

### Yang TIDAK berubah

- `spawnSubagentAsync` — interface luar tetap sama
- Semua lifecycle tools (abort, respond, done)
- Widget, chain, comms, blockers, prompt, crew-list
- Semua tipe di `shared/types.ts`
- `crew_spawn` parameter shape
- Widget updater, registry, message bus

---

## Implementasi Detail

### Phase 1: Setup infrastructure di index.ts

```typescript
// Tambahan import
import { 
    DefaultResourceLoader, 
    SessionManager, 
    createAgentSession,
    type AgentSession,
    type ModelRegistry,
} from "@earendil-works/pi-coding-agent";

// State baru
let _resourceLoader: DefaultResourceLoader | undefined;
let _sessionManager: SessionManager | undefined;
let _extensionDir: string;

// Di session_start: init resource infrastructure
pi.on("session_start", async (_event, ctx) => {
    _extensionDir = extensionDir;
    _resourceLoader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir: getAgentDir() });
    await _resourceLoader.reload();
    _sessionManager = SessionManager.create(ctx.cwd);
    ...
});
```

### Phase 2: Rewrite spawnSubagentProcess

```typescript
// === SEBELUM ===
export async function spawnSubagentProcess(
    agentConfig, task, signal, cwd, extraSpawnArgs?, onProgress?
): Promise<SpawnSubagentResult> {
    const args = buildSpawnArgs(...);
    const proc = spawn(invocation.command, invocation.args, { ... });
    proc.stdout.on("data", ...);
    // ±120 baris child_process logic
}

// === SESUDAH ===
export async function spawnSubagentProcess(
    agentConfig, task, signal, cwd, 
    resourceLoader, sessionManager, modelRegistry,
    onProgress?
): Promise<SpawnSubagentResult> {
    // 1. Resolve model
    const model = resolveModel(agentConfig, modelRegistry);
    
    // 2. Setup resource loader dengan custom system prompt + extensions
    const loader = createSubagentResourceLoader(
        resourceLoader, agentConfig, _extensionDir
    );
    
    // 3. Create session
    const { session } = await createAgentSession({
        cwd,
        agentDir: getAgentDir(),
        model,
        thinkingLevel: agentConfig.thinking,
        tools: agentConfig.tools,
        resourceLoader: loader,
        sessionManager,
        authStorage: modelRegistry.authStorage,
        modelRegistry,
    });
    
    // 4. Name the session
    session.setSessionName(`crew: ${agentConfig.name} · ${taskPreview(task)}`);
    
    // 5. Subscribe to turns (live tracking INHERENT)
    session.subscribe((event) => {
        if (event.type !== "turn_end") return;
        const msg = event.message as AssistantMessage;
        onProgress?.(
            streamingResult.turns++,
            "running",
            { ...usageFromMessage(msg) }
        );
    });
    
    // 6. Prompt
    await session.prompt(task);
    
    // 7. Extract result
    const lastMsg = getLastAssistantMessage(session.messages);
    return { handle, output: lastMsg?.text, ... };
}
```

### Phase 3: Cleanup types

Hapus dari `spawn.types.ts`:
- `ProcessSpawnArgs`
- `getPiInvocation()`
- `StreamingResult`
- `SpawnTask` (kalau tidak dipakai di tempat lain)

### Phase 4: Perubahan di spawnSubagentAsync

```typescript
export function spawnSubagentAsync(
    pi, agentConfig, task, signal, cwd, ownerSession?
): SubagentHandle {
    // ... handle creation (sama) ...
    
    (async () => {
        await concurrencyTracker.acquire();
        handle.status = "running";
        syncWidgetFromRegistry(pi);
        
        try {
            const result = await spawnSubagentProcess(
                agentConfig, task, signal, cwd,
                _resourceLoader!,        // ← NEW
                _sessionManager!,        // ← NEW
                _modelRegistry!,         // ← NEW
                // onProgress callback (sama dengan sekarang)
                (turns, status, usage) => {
                    handle.turns = turns;
                    handle.usage = usage;
                    syncWidgetFromRegistry(pi);
                },
            );
            // ... steering delivery (sama) ...
        }
    })();
}
```

### Phase 5: Session cleanup di session_shutdown

```typescript
pi.on("session_shutdown", async (event, ctx) => {
    // Abort owned agents (existing)
    // ...
    
    // Dispose session manager → cleanup orphaned subagent sessions
    _sessionManager?.dispose();
    _resourceLoader = undefined;
    _sessionManager = undefined;
    
    resetAgentRegistry();
    resetMessageBus();
    resetWidgetStore();
});
```

---

## Model Resolution (helper baru)

```typescript
function resolveModel(
    agentConfig: AgentConfig,
    modelRegistry: ModelRegistry,
): Model<Api> | undefined {
    if (!agentConfig.model) return undefined;
    
    const [provider, modelId] = agentConfig.model.split("/");
    if (!provider || !modelId) return undefined;
    
    return modelRegistry.find(provider, modelId);
}
```

---

## Extension Isolation (pertahankan opt-in)

```typescript
function createSubagentResourceLoader(
    baseLoader: DefaultResourceLoader,
    agentConfig: AgentConfig,
    extensionDir: string,
): DefaultResourceLoader {
    return new DefaultResourceLoader({
        extensionsOverride: (base) => ({
            ...base,
            extensions: base.extensions.filter((ext) => {
                // Filter out crew-of-pi sendiri (cegah recursive spawn)
                if (ext.resolvedPath.startsWith(extensionDir)) return false;
                
                // Opt-in: hanya load extension yang explicit di frontmatter
                if (agentConfig.extensions.length > 0) {
                    return agentConfig.extensions.some((agentExt) =>
                        ext.resolvedPath === agentExt.resolved ||
                        ext.resolvedPath.endsWith(agentExt.value)
                    );
                }
                
                return false; // default: no extensions
            }),
        }),
        appendSystemPromptOverride: (base) => 
            agentConfig.systemPrompt.trim() 
                ? [...base, agentConfig.systemPrompt] 
                : base,
    });
}
```

---

## Timeline

| Phase | Durasi | Output |
|-------|--------|--------|
| **Phase 1** | 30 menit | Setup resource loader + session manager di index.ts |
| **Phase 2** | 1 jam | Rewrite spawnSubagentProcess + model resolution |
| **Phase 3** | 20 menit | Cleanup dead types di spawn.types.ts |
| **Phase 4** | 20 menit | Update spawnSubagentAsync signature |
| **Phase 5** | 10 menit | Session cleanup di shutdown |
| **Testing** | 30 menit | Spawn worker/scout, cek widget, cek session list, verifikasi result |
| **Total** | ~3 jam | |

---

## Risiko & Mitigasi

| Risiko | Level | Mitigasi |
|--------|-------|----------|
| `createAgentSession` API beda versi SDK | LOW | Cek tipe di .d.ts sebelum implementasi |
| Model resolution gagal (provider/model-id invalid) | LOW | Fallback ke model session saat ini |
| Subagent stuck tanpa `--no-session` cleanup | MED | Pastikan `session.dispose()` di error path |
| Interactive subagent session handling | MED | Test `crew_respond` flow, stdin tidak relevan lagi |
| Compaction behaviour beda dari `--no-session` | LOW | pi compaction default cukup |
| Memory leak dari session yang tidak di-dispose | MED | `session_shutdown` dispose all + `finally` block |

---

## Verifikasi

Setelah migrasi, cek:

1. `crew_spawn("scout", "find auth code")` → result via steering ✅
2. Widget live turns → ⏳ turn 1, 2, 3... real-time ✅
3. `pi session list` → tampil `crew: scout · find auth code` ✅
4. Widget completed → ✅ tetap tampil dengan turns final ✅
5. `crew_abort` → kill subagent, session dispose ✅
6. `session_shutdown` → semua owned subagent di-abort + dispose ✅
7. CPU/Memory → lebih rendah dari child_process (3-5x) ✅
8. 3 parallel subagent → semua jalan tanpa issue ✅

---

## Referensi

- pi-crew `subagent-session.ts`: bootstrap session + turn tracking pattern
- pi-crew `catalog.ts`: extension filtering + model resolution
- pi SDK `createAgentSession` type definition:
  `dist/core/agent-session.d.ts`
- pi SDK `DefaultResourceLoader` options:
  `dist/core/resource-loader.d.ts`
