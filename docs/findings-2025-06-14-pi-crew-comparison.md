# Komparasi crew-of-pi vs pi-crew (Original) — 14 June 2025

## Ringkasan

Audit komparatif seluruh source code crew-of-pi terhadap pi-crew ([melihmucuk/pi-crew](https://github.com/melihmucuk/pi-crew)).
Ditemukan 13 temuan — 2 HIGH severity (arsitektur fundamental), 3 MEDIUM, 8 LOW/NOTE.

---

## Checklist Temuan

| # | Temuan | Severity | Status |
|---|--------|----------|--------|
| 1 | child_process vs createAgentSession — tidak bisa live track turns | **HIGH** | OPEN |
| 2 | Widget filter completed agent — agent hilang dari widget | **HIGH** | OPEN |
| 3 | Tidak ada session ownership — abort bisa cross-session | **MEDIUM** | OPEN |
| 4 | Tidak ada message queue + `isIdle()` check — race condition | **MEDIUM** | OPEN |
| 5 | Tidak ada `brief` field — widget display kurang readable | **MEDIUM** | OPEN |
| 6 | Agent discovery tanpa validasi ketat | **LOW** | OPEN |
| 7 | Tidak ada `promptGuidelines` per-tool | **LOW** | OPEN |
| 8 | Tidak ada anti-polling warning di crew_list | **LOW** | OPEN |
| 9 | Tidak ada session naming (`--no-session`) | **LOW** | OPEN |
| 10 | `--no-extensions` vs extension filtering approach | **NOTE** | — |
| 11 | Error detection logic | **NOTE** | — |
| 12 | Concurrency semaphore implementation | **NOTE** | — |
| 13 | SubagentStatus enum berbeda | **NOTE** | — |

---

## 1. Arsitektur Spawn — `child_process` vs `createAgentSession`

### Temuan

**pi-crew** menggunakan `createAgentSession()` (in-process session API pi).
**crew-of-pi** menggunakan `child_process.spawn("pi", ...)` (out-of-process).

### Dampak

**pi-crew — Live tracking:**
```typescript
// subagent-session.ts
session.subscribe((event) => {
    if (event.type !== "turn_end") return;
    state.turns++;                              // ← LIVE per-turn
    state.contextTokens = usage.totalTokens;
    this.callbacks.onProgress(ownerSessionId);  // ← LIVE widget refresh
});
```

**crew-of-pi — No live tracking:**
```typescript
// spawn.manager.ts
const result = await spawnSubagentProcess(...);  // ← BLOCK sampai SELESAI
// Baru setelah await selesai:
handle.turns = result.handle.turns;     // turns = N (benar, tapi terlambat)
handle.status = result.handle.status;   // status = "completed"
syncWidgetFromRegistry(pi);             // ← widget filter completed → hilang
```

`parseJsonLines` menghitung turns dengan benar secara internal, tapi tidak ada callback/bridge ke registry/widget selama eksekusi. Hasil: widget stuck "0 turns" sepanjang subagent hidup.

### Rekomendasi

- Tambahkan `onProgress` callback ke `spawnSubagentProcess` yang dipanggil setiap `parseJsonLines` selesai
- Atau: migrasi dari `child_process.spawn` ke `createAgentSession` (perlu riset API compatibility)

---

## 2. Widget Filter — Completed Agent Hilang

### Temuan

**pi-crew:** `getActiveSummariesForOwner()` return status `"running"` + `"waiting"`. Agent `"done"` dihapus dari `crewRuntime.agents` via `disposeAgent()`.

**crew-of-pi:** `getActiveSummaries()` return `"running"` + `"spawned"`. Agent tidak pernah dihapus dari registry setelah complete — tetap `"completed"` di `Map` selamanya.

### Dampak

1. **Widget misleading:** Agent hilang dari widget begitu complete — main agent tidak tahu agent sudah selesai (harus tunggu steering message)
2. **Memory leak:** `crew_list` tetap menampilkan semua completed agent, registry Map terus membesar
3. **Kontradiksi visual:** Widget kosong tapi `crew_list` penuh completed agents

### Rekomendasi

- Widget tampilkan semua status (bukan cuma running/spawned) — pakai emoji per status
- Atau: hapus completed agent dari registry setelah N detik (time-based cleanup)
- Atau: tambahkan peringatan kalau widget kosong tapi ada completed agents

---

## 3. Session Ownership — Abort Bisa Cross-Session

### Temuan

**pi-crew:** `SubagentState.ownerSessionId` — setiap agent terikat ke session yang spawn. `crew_abort` validasi:
```typescript
if (state.ownerSessionId !== callerSessionId) {
    return { ok: false, error: `Subagent "${id}" belongs to a different session` };
}
```

**crew-of-pi:** `SubagentHandle` tidak punya `ownerSession` sama sekali. `crew_abort` langsung `abortSubagentProcess(handle.pid)` tanpa validasi kepemilikan.

### Dampak

1. Agent dari session A bisa di-abort dari session B
2. `session_shutdown` cuma `resetAgentRegistry()` — tidak abort running process milik session tersebut
3. Session restore tidak bisa membedakan agent milik session mana

### Rekomendasi

- Tambahkan `ownerSessionId` ke `SubagentHandle`
- Validasi ownership di `crew_abort`/`crew_respond`/`crew_done`
- `session_shutdown` → abort hanya agent milik session tersebut

---

## 4. Message Delivery — Race Condition

### Temuan

**pi-crew:** Message delivery logic dengan `isIdle()` check + `pendingMessages` queue:
```typescript
// ui.ts
function sendWithDeliveryPolicy(message, sendMessage, opts) {
    sendMessage(message, opts.isIdle
        ? { triggerTurn: opts.triggerTurn }
        : { deliverAs: "steer", triggerTurn: opts.triggerTurn }
    );
}

// crew.ts
private deliver(ownerSessionId, payload) {
    if (!this.activeBinding || ownerSessionId !== this.activeBinding.sessionId) {
        this.queue(ownerSessionId, payload);  // ← jangan lose message
        return;
    }
    this.send(ownerSessionId, payload);
}
```

**crew-of-pi:** Hardcode tanpa pengecekan:
```typescript
pi.sendMessage({...}, { deliverAs: "steer", triggerTurn: true });
```

### Dampak

1. Kalau session belum fully active (binding belum ada), message hilang selamanya
2. Tidak ada retry/queue mechanism
3. `triggerTurn: true` selalu — bisa interrupt main agent yang sedang sibuk

### Rekomendasi

- Implementasi message queue (pending messages)
- Flush queue di `session_start` / `activateSession`
- Gunakan `ctx.isIdle()` untuk memilih `triggerTurn`

---

## 5. `brief` Field — Widget Display Kurang Readable

### Temuan

**pi-crew:** Setiap spawn punya `brief` terpisah dari `task`:
```
crew_spawn({ subagent: "worker", brief: "JWT login", task: "Full prompt..." })
```
`brief` digunakan untuk session naming + widget display.

**crew-of-pi:** Cuma ada `task`. Widget render 60 karakter pertama sebagai preview:
```typescript
const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
```

### Dampak

Widget display tidak informatif — "task" panjang dipotong 60 karakter.

### Rekomendasi

- Tambahkan `brief` parameter opsional di `crew_spawn`
- Widget render pakai `brief` jika ada, fallback ke task preview

---

## 6. Agent Discovery — Validasi Kurang Ketat

### Temuan

**pi-crew** `AgentCatalog` punya:
- Validasi `name` + `description` mandatory
- Validasi no whitespace dalam agent name
- Parse model: `provider/model-id` → `parsedModel` untuk lookup
- Thinking level: hanya `off/minimal/low/medium/high/xhigh`
- Warning system: invalid tools, unknown fields, duplicate name per group
- Config merge: project `pi-crew.json` > global, dengan validasi field

**crew-of-pi** `parseFrontmatter` sederhana:
- Tidak validasi format model
- Tidak validasi thinking level
- Config loader tanpa validasi field
- Tidak ada warning untuk unknown tools

### Dampak

Agent dengan konfigurasi salah (misal model typo) tidak dikasih warning ke user.

### Rekomendasi

- Ambil validasi dari pi-crew `catalog.ts` — terutama parse model + thinking level
- Tambahkan warning system (`AgentDiscoveryWarning[]`)

---

## 7. `promptGuidelines` Per-Tool — Belum Ada

### Temuan

**pi-crew:** Setiap tool punya `promptGuidelines` untuk pi prompt injection:
```typescript
promptGuidelines: [
    "crew_list: Use before crew_spawn to discover names...",
    "crew_list: Use only for discovery — do not poll for completion.",
]
```

**crew-of-pi:** System prompt injection via `before_agent_start` global. Tidak ada per-tool guidelines.

### Dampak

Main agent kurang optimal dalam delegasi — tidak dapat panduan per-tool.

### Rekomendasi

- Tambahkan `promptGuidelines` di setiap tool registration
- Pertahankan `before_agent_start` injection untuk konteks global

---

## 8. crew_list — Tidak Ada Anti-Polling Warning

### Temuan

**pi-crew:** `crew_list` trigger `showActiveListWarning()` kalau ada running agents:
```
⚠ Active subagents detected. Do not poll crew_list for completion —
results arrive as steering messages. Continue with unrelated work...
```

**crew-of-pi:** `crew_list` langsung return daftar tanpa peringatan. Tidak menghalangi main agent untuk polling berkali-kali.

### Dampak

Main agent bisa buang turns untuk poll `crew_list` berulang kali alih-alih menunggu steering message.

### Rekomendasi

- Tambahkan warning message kalau ada running agents
- Atau: tidak tampilkan running agents di `crew_list`, suruh tunggu steering

---

## 9. Session Naming — `--no-session`

### Temuan

**pi-crew:** Subagent session dikasih nama via `session.setSessionName()`:
```typescript
session.setSessionName(`crew: ${agentName} · ${brief}`);
```

**crew-of-pi:** Pakai `--no-session` flag — subagent tidak punya session file sama sekali.

### Dampak

1. Subagent tidak bisa di-resume
2. Session list kosong/tidak informatif
3. Hasil subagent tidak persistent antar restart pi

### Rekomendasi

- Evaluasi apakah `--no-session` masih diperlukan (alasan awal: isolasi konteks)
- Kalau tetap, setidaknya buat session entries via `pi.appendEntry` untuk persistence

---

## 10. `--no-extensions` vs Extension Filtering — Approach Note

### Perbandingan

**pi-crew:** Extension filtering via `DefaultResourceLoader`:
```typescript
extensionsOverride: (base) => ({
    ...base,
    extensions: base.extensions.filter((ext) => 
        !ext.resolvedPath.startsWith(extensionResolvedPath)
    ),
}),
```
Mencegah pi-crew extension di-load secara recursive, tapi extension LAIN tetap jalan.

**crew-of-pi:** `--no-extensions` — subagent tidak dapat extension satupun kecuali explicit di-list di frontmatter:
```typescript
if (agentConfig.extensions && agentConfig.extensions.length > 0) {
    for (const ext of agentConfig.extensions) { ... }
}
```

### Analisis

Kedua approach valid. `--no-extensions` lebih strict (mencegah semua extension). pi-crew approach lebih fleksibel (extension lain tetap jalan, cuma pi-crew yang di-skip).

### Rekomendasi

Tidak perlu diubah. `--no-extensions` + explicit list sudah aman untuk mencegah recursive spawning.

---

## 11. Error Detection Logic — Analysis

**pi-crew:** Deteksi dari `stopReason`:
```typescript
if (lastAssistant?.stopReason === "error") return { status: "error", ... };
if (lastAssistant?.stopReason === "aborted") return { status: "aborted", ... };
```

**crew-of-pi:** Deteksi dari exit code + stopReason + errorMessage:
```typescript
function isFailedResult(result: StreamingResult): boolean {
    return result.exitCode !== 0 || 
        result.stopReason === "error" || 
        result.stopReason === "aborted";
}
```

Kalau pi process exit dengan code ≠ 0 tanpa `message_end` event, `streamingResult.stopReason` tetap undefined, tapi `isFailedResult` tetap return true karena `exitCode !== 0`. ✅ Aman.

### Rekomendasi

Tidak perlu diubah. Logic sudah handle semua edge case.

---

## 12. Concurrency Semaphore — Analysis

**pi-crew:** Tidak ada explicit concurrency limit.

**crew-of-pi:** `ConcurrencyTracker` dengan `MAX_CONCURRENCY = 4`:
```typescript
release(): void {
    const next = this.queue.shift();
    if (next) { next(); }           // resolve next waiter (no counter change)
    else { this.current = Math.max(0, this.current - 1); }
}
```

Logic ini benar — next waiter langsung mengambil slot, bukan menambah counter.

### Rekomendasi

Tidak perlu diubah. Implementasi valid.

---

## 13. SubagentStatus Enum — Mapping

| pi-crew | crew-of-pi | Notes |
|---------|------------|-------|
| `"running"` | `"spawned"`, `"running"` | crew-of-pi punya transitional state |
| `"waiting"` | — | pi-crew interactive pause, crew-of-pi tidak punya |
| `"done"` | `"completed"` | Naming berbeda |
| `"error"` | `"failed"` | Naming berbeda |
| `"aborted"` | `"aborted"` | Sama |
| — | `"orphaned"` | crew-of-pi punya untuk session restore edge case |

`"orphaned"` tidak ada di pi-crew karena pi-crew pakai in-process session (tidak mungkin orphaned).

### Rekomendasi

- Hati-hati kalau ada cross-project reference
- Dokumentasikan mapping ini kalau perlu

---

## Prioritas Perbaikan

### Critical Path (harus difiksasi dulu)

1. **#1 + #2** — Widget live tracking + completed visibility
   - Ini akar dari complaint user: "0 turn" + widget tidak update
   - _Possible approaches:_ onProgress callback di spawn, atau migrasi ke createAgentSession

### High Priority (setelah critical path)

2. **#3** — Session ownership
3. **#4** — Message queue
4. **#5** — `brief` field

### Nice to Have

5. **#6** — Agent discovery validation
6. **#7** — promptGuidelines
7. **#8** — Anti-polling warning
8. **#9** — Session naming

---

## Referensi

- pi-crew source: `https://github.com/melihmucuk/pi-crew`
- crew-of-pi source: `extensions/crew-of-pi/`
- Audit sebelumnya: `docs/findings-2025-06-13.md`
