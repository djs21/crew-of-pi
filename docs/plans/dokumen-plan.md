# SQLite-Based Sub-agent System

**Tanggal:** 2026-07-21
**Status:** Final (setelah review)
**File:** 1 baru + 11 modified
**Estimasi:** ~250 baris net

---

## 1. Masalah

State sub-agent saat ini **in-memory**:
- `AgentRegistry.runningAgents: Map<string, SubagentHandle>` — hilang saat reload/crash
- Widget render via callback chain: `session.subscribe → onProgress → syncWidgetFromRegistry`
- `pi.appendEntry()` untuk persist — rawan inkonsistensi, gak bisa query
- Gak bisa multi-process (tmux/herdr di masa depan)

---

## 2. Solusi

Migrasi state tracking ke **SQLite** (node:sqlite, sudah terpakai untuk MessageBus).
In-memory cache tetap ada untuk READ (widget, crew_list, validation).
DUAL-WRITE untuk semua state transition: SQLite dulu, memory kedua.

**Keputusan arsitektural (setelah review):**
1. **Satu DB connection** — MessageBus dan SubagentDb sharing koneksi yang sama
2. **No circular dependency** — `AgentRegistry` tidak import dari spawn slice
3. **Error handling** — semua DB write pake try/catch
4. **Transaction** — tiap state change pake BEGIN/COMMIT
5. **Debounce** — progress callback hanya nulis ke DB tiap 5 turn / 5 detik
6. **`subagent_commands` tabel dihapus** — YAGNI, pesan udah di `crew_messages`
7. **`current_tool` tetap di memory** — gak perlu di DB
8. **`last_heartbeat`** — kolom baru buat orphan detection

---

## 3. Tabel SQLite

```sql
-- Real-time status per sub-agent (1 row per agent)
CREATE TABLE IF NOT EXISTS subagent_status (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'spawned',
  task TEXT NOT NULL,
  model TEXT,
  interactive INTEGER NOT NULL DEFAULT 0,
  spawned_at INTEGER NOT NULL,
  owner_session TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  usage_input INTEGER NOT NULL DEFAULT 0,
  usage_output INTEGER NOT NULL DEFAULT 0,
  usage_cache_read INTEGER NOT NULL DEFAULT 0,
  usage_cache_write INTEGER NOT NULL DEFAULT 0,
  usage_cost REAL NOT NULL DEFAULT 0,
  usage_context_tokens INTEGER NOT NULL DEFAULT 0,
  session_file TEXT,
  last_error TEXT,
  last_heartbeat INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subagent_status_status ON subagent_status(status);
CREATE INDEX IF NOT EXISTS idx_subagent_status_owner ON subagent_status(owner_session);

-- Append-only event log (state transitions only, not tiap progress)
CREATE TABLE IF NOT EXISTS subagent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subagent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  usage_context_tokens INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subagent_events_id ON subagent_events(subagent_id, created_at);
```

---

## 4. Shared DB Connection Architecture

**Sebelum (bermasalah):**
```
MessageBus (comms.ts) → new DatabaseSync(path)  ← koneksi 1
SubagentDb (spawn.db.ts) → new DatabaseSync(path)  ← koneksi 2
```
Risk: `SQLITE_BUSY` karena dua koneksi write ke WAL file yang sama.

**Sesudah (satu koneksi):**
```
SubagentDb terima DatabaseSync dari luar (dependency injection).
MessageBus juga terima DatabaseSync dari luar.
Keduanya sharing koneksi yang sama, diinisialisasi di index.ts.
```

```typescript
// Di index.ts session_start:
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode=WAL");

// Shared:
const messageBus = new MessageBus(db);
const subagentDb = new SubagentDb(db);  // ← same db connection!

// Pass ke infra:
setSpawnInfra({ modelRegistry, modelRuntime, agentDir, extensionDir, subagentDb });
```

---

## 5. File-by-File Changes

### 5.1 `shared/types.ts` — +2 interfaces, +1 helper

Tambahkan setelah `SubagentHandle`:

```typescript
export interface SubagentStatusRow {
  id: string;
  agentName: string;
  status: SubagentStatus;
  task: string;
  model?: string;
  interactive: boolean;
  spawnedAt: number;
  ownerSession?: string;
  turns: number;
  usageInput: number;
  usageOutput: number;
  usageCacheRead: number;
  usageCacheWrite: number;
  usageCost: number;
  usageContextTokens: number;
  sessionFile?: string;
  lastHeartbeat: number;
  completedAt?: number;
  updatedAt: number;
}

export interface SubagentEventRow {
  id: number;
  subagentId: string;
  eventType: string;
  status: string;
  turns: number;
  usageContextTokens: number;
  metadata?: string;
  createdAt: number;
}

/** Convert DB row to handle (for restore from DB on startup) */
export function statusRowToHandle(
  row: SubagentStatusRow,
  runtime?: { abortController?: AbortController; session?: any }
): SubagentHandle {
  return {
    id: row.id,
    agentName: row.agentName,
    status: row.status as SubagentStatus,
    task: row.task,
    model: row.model,
    interactive: row.interactive,
    spawnedAt: row.spawnedAt,
    ownerSession: row.ownerSession,
    turns: row.turns,
    usage: {
      input: row.usageInput, output: row.usageOutput,
      cacheRead: row.usageCacheRead, cacheWrite: row.usageCacheWrite,
      cost: row.usageCost, contextTokens: row.usageContextTokens, turns: row.turns,
    },
    sessionFile: row.sessionFile,
    abortController: runtime?.abortController,
    session: runtime?.session,
  };
}
```

**Estimasi:** +25 baris

---

### 5.2 NEW: `slices/spawn/spawn.db.ts` — SubagentDb class

```typescript
import { DatabaseSync } from "node:sqlite";
import type { SubagentStatusRow, SubagentStatus } from "../../shared/types";

export class SubagentDb {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.init();
  }

  private init(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS subagent_status (
      id TEXT PRIMARY KEY, agent_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'spawned', task TEXT NOT NULL,
      model TEXT, interactive INTEGER NOT NULL DEFAULT 0,
      spawned_at INTEGER NOT NULL, owner_session TEXT,
      turns INTEGER NOT NULL DEFAULT 0,
      usage_input INTEGER NOT NULL DEFAULT 0,
      usage_output INTEGER NOT NULL DEFAULT 0,
      usage_cache_read INTEGER NOT NULL DEFAULT 0,
      usage_cache_write INTEGER NOT NULL DEFAULT 0,
      usage_cost REAL NOT NULL DEFAULT 0,
      usage_context_tokens INTEGER NOT NULL DEFAULT 0,
      session_file TEXT, last_error TEXT, last_heartbeat INTEGER NOT NULL,
      completed_at INTEGER, updated_at INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS subagent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subagent_id TEXT NOT NULL, event_type TEXT NOT NULL,
      status TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0,
      usage_context_tokens INTEGER NOT NULL DEFAULT 0,
      metadata TEXT, created_at INTEGER NOT NULL
    )`);
    this.db.exec("PRAGMA journal_mode=WAL");
  }

  upsertStatus(id: string, fields: Record<string, any>): void {
    try {
      const existing = this.db.prepare("SELECT id FROM subagent_status WHERE id = ?").get(id);
      if (existing) {
        const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(", ");
        const values = Object.values(fields);
        values.push(id);
        this.db.prepare(`UPDATE subagent_status SET ${setClauses} WHERE id = ?`).run(...values);
      } else {
        const keys = Object.keys(fields);
        const placeholders = keys.map(() => "?").join(", ");
        this.db.prepare(`INSERT INTO subagent_status (${keys.join(", ")}) VALUES (${placeholders})`).run(...Object.values(fields));
      }
    } catch (err) {
      console.error(`[crew-of-pi] DB upsertStatus error:`, err);
    }
  }

  insertEvent(subagentId: string, eventType: string, status: string, turns: number, ctxTokens: number, metadata?: string): void {
    try {
      this.db.prepare(
        "INSERT INTO subagent_events (subagent_id, event_type, status, turns, usage_context_tokens, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(subagentId, eventType, status, turns, ctxTokens, metadata ?? null, Date.now());
    } catch (err) {
      console.error(`[crew-of-pi] DB insertEvent error:`, err);
    }
  }

  getActiveStatuses(): SubagentStatusRow[] {
    return this.db.prepare(
      "SELECT * FROM subagent_status WHERE status IN ('spawned', 'running') ORDER BY spawned_at"
    ).all() as SubagentStatusRow[];
  }

  getAllStatuses(): SubagentStatusRow[] {
    return this.db.prepare("SELECT * FROM subagent_status ORDER BY spawned_at DESC").all() as SubagentStatusRow[];
  }

  orphanStaleSessions(): number {
    const cutoff = Date.now() - 30 * 60 * 1000;
    const result = this.db.prepare(
      "UPDATE subagent_status SET status = 'orphaned', updated_at = ? WHERE status IN ('spawned', 'running') AND last_heartbeat < ?"
    ).run(Date.now(), cutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
```

**Estimasi:** ~100 baris

---

### 5.3 `slices/comms/comms.ts` — Refactor: accept DB from outside

Ubah constructor MessageBus untuk terima `DatabaseSync` dari luar (dependency injection), bukan buka sendiri.

```typescript
export class MessageBus {
  private db: DatabaseSync;
  private subscriptions: CommsSubscription[] = [];

  constructor(db: DatabaseSync) {  // ← terima dari luar
    this.db = db;
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS crew_messages (...)`);
  }
  // ... sisanya sama
}
```

**Estimasi:** ~5 baris berubah

---

### 5.4 `slices/spawn/spawn.tool.ts` — tambah `subagentDb` ke SpawnInfra

```typescript
export interface SpawnInfra {
  modelRegistry: ModelRegistry;
  modelRuntime?: any;
  agentDir: string;
  extensionDir: string;
  subagentDb: SubagentDb;  // BARU
}
```

Import: `import type { SubagentDb } from "./spawn.db";`

**Estimasi:** +3 baris

---

### 5.5 `slices/spawn/spawn.manager.ts` — 6 transition points + debounce

**6 transition points:**

| # | Point | Status | DB Write | Event |
|---|-------|--------|----------|-------|
| 1 | Handle created | spawned | upsertStatus | insertEvent('spawned') |
| 2 | After concurrency acquire | running | upsertStatus | insertEvent('running') |
| 3 | Progress callback (turn_end) | running | upsertStatus (debounced) | - |
| 4 | After session completes | completed/failed/aborted | upsertStatus | insertEvent(final) |
| 5 | Catch block (error) | failed | upsertStatus | insertEvent('error') |
| 6 | Aborted before start | aborted | upsertStatus | insertEvent('aborted') |

**Debounce progress:** hanya nulis ke DB tiap 5 turn atau 5 detik:
```typescript
const lastDbWrite = { turn: 0, time: 0 };
// ... di progress callback:
if (turns % 5 === 0 || Date.now() - lastDbWrite.time > 5000) {
  const row = handleToRow(handle);
  subagentDb.upsertStatus(handle.id, { turns: row.turns, usage_input: ..., last_heartbeat: Date.now() });
  lastDbWrite.turn = turns;
  lastDbWrite.time = Date.now();
}
```

**Hapus `pi.appendEntry("crew-subagent-spawn", ...)` dan `pi.appendEntry("crew-subagent-result", ...)`** — sudah digantikan oleh subagent_events.

**Estimasi:** ~40 baris berubah

---

### 5.6 `slices/agents/agents.registry.ts` — setDb injection, restoreFromDb

Tambahkan method tanpa import dari spawn slice:

```typescript
private _db: any; // SubagentDb — di-set dari luar via setDb

setDb(db: any): void {
  this._db = db;
}

async restoreFromDb(): Promise<void> {
  if (!this._db) return;
  const rows = this._db.getAllStatuses();
  for (const row of rows) {
    const handle = statusRowToHandle(row);
    this.runningAgents.set(handle.id, handle);
  }
}
```

**TIDAK import SubagentDb** — registry tetap bebas dependency. `_db: any` untuk runtime type.

---

### 5.7 `slices/lifecycle/lifecycle.abort.ts` — +DB writes

Di fungsi `abortSubagent`, setelah `handle.abortController?.abort()`:

```typescript
// DB write (via registry's db reference)
const db = (registry as any)._db;
if (db) {
  db.upsertStatus(handle.id, { status: "aborted", updated_at: Date.now() });
  db.insertEvent(handle.id, "aborted", "aborted", handle.turns, handle.usage?.contextTokens ?? 0);
}
```

**Estimasi:** +8 baris

---

### 5.8 `slices/lifecycle/lifecycle.done.ts` — +DB writes

Di fungsi `doneSubagent`:

```typescript
const db = (registry as any)._db;
if (db) {
  db.upsertStatus(handle.id, { status: "completed", completed_at: Date.now(), updated_at: Date.now() });
  db.insertEvent(handle.id, "completed", "completed", handle.turns, handle.usage?.contextTokens ?? 0);
}
```

**Estimasi:** +8 baris

---

### 5.9 `slices/widget/widget.renderer.ts` — No change

Widget tetap baca dari `WidgetStore.getActiveSummaries()` yang baca dari `AgentRegistry.getRunning()`. Zero perubahan.

---

### 5.10 `slices/widget/widget.store.ts` — No change

Tetap in-memory store. Dual-write sudah di-handle oleh spawn.manager.ts + registry.

---

### 5.11 `index.ts` — Init, orphan, restore, close, wire everything

**session_start:**
```typescript
pi.on("session_start", async (_event, ctx) => {
  // ... existing init ...
  
  // Init shared DB
  const projectHash = crypto.createHash("sha256").update(ctx.cwd).digest("hex").slice(0, 12);
  const dbPath = path.join(homedir(), ".local", "share", "pi", `crew-of-pi-${projectHash}.db`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");

  // Init shared instances
  const messageBus = getMessageBus();
  messageBus.init(db);  // atau ubah constructor
  const subagentDb = new SubagentDb(db);

  // Orphan stale sessions
  const orphaned = subagentDb.orphanStaleSessions();
  if (orphaned > 0) {
    ctx.ui.notify(`Found ${orphaned} stale sub-agent(s) from previous session`, "warning");
  }

  // Restore surviving handles
  const registry = getAgentRegistry();
  registry.setDb(subagentDb);
  await registry.restoreFromDb();

  // Pass to spawn infra
  setSpawnInfra({
    modelRegistry: ctx.modelRegistry,
    modelRuntime: ctx.modelRegistry['runtime'],
    agentDir: getAgentDir(),
    extensionDir: bundledAgentsPath,
    subagentDb,
  });

  // ... rest unchanged ...
});
```

**session_shutdown:**
```typescript
pi.on("session_shutdown", async () => {
  // ... existing cleanup ...
  resetMessageBus();
});
```

**Estimasi:** ~25 baris berubah

---

## 6. Ringkasan Diff

| File | Status | Perubahan |
|------|--------|-----------|
| `shared/types.ts` | Modified | +25 baris (types + helper) |
| `slices/spawn/spawn.db.ts` | **NEW** | ~100 baris |
| `slices/comms/comms.ts` | Modified | ~5 baris (constructor) |
| `slices/spawn/spawn.tool.ts` | Modified | +3 baris (SpawnInfra) |
| `slices/spawn/spawn.manager.ts` | Modified | ~40 baris (6 transitions + debounce) |
| `slices/agents/agents.registry.ts` | Modified | ~20 baris (setDb + restoreFromDb) |
| `slices/lifecycle/lifecycle.abort.ts` | Modified | +8 baris |
| `slices/lifecycle/lifecycle.done.ts` | Modified | +8 baris |
| `slices/widget/widget.renderer.ts` | **No change** | - |
| `slices/widget/widget.store.ts` | **No change** | - |
| `index.ts` | Modified | ~25 baris |
| **Total** | **1 new + 10 modified** | **~240 baris net** |

---

## 7. Dependensi Baru

**0** — semua pake `node:sqlite` yang sudah terpakai.

---

## 8. Risk Register (Post-Review)

| Risk | Severity | Mitigasi |
|------|----------|----------|
| `SQLITE_BUSY` karena dua koneksi write | 🔴 **Dieliminasi** | Satu koneksi sharing — sudah fix di arsitektur |
| Circular dependency registry → spawn | 🔴 **Dieliminasi** | Registry pake `_db: any`, tidak import SubagentDb |
| DB write error silent | 🟡 Medium | try/catch + console.error di semua DB write |
| Progress callback thrashing | 🟡 Medium | Debounce: tiap 5 turn / 5 detik |
| Session runtime hilang setelah reload | 🟡 Medium | Restored handles marked as orphaned; lifecycle tools refuse |
| `last_heartbeat` stale | 🟢 Low | Orphan threshold 30 menit |

---

## 9. Urutan Eksekusi

1. `shared/types.ts` — row types + `statusRowToHandle()`
2. `slices/spawn/spawn.db.ts` — `SubagentDb` class baru
3. `slices/comms/comms.ts` — refactor constructor terima `DatabaseSync` dari luar
4. `slices/spawn/spawn.tool.ts` — tambah `subagentDb` ke `SpawnInfra`
5. `slices/agents/agents.registry.ts` — `setDb()` + `restoreFromDb()`
6. `slices/spawn/spawn.manager.ts` — 6 transition points + debounce + hapus appendEntry
7. `slices/lifecycle/lifecycle.abort.ts` — DB writes
8. `slices/lifecycle/lifecycle.done.ts` — DB writes
9. `index.ts` — init DB, orphan, restore, wire, close
10. Build & test
```
