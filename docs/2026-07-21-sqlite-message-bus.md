# Plan: SQLite Message Bus untuk crew-of-pi

**Tanggal:** 2026-07-21
**Status:** Final (setelah review)

---

## 1. Masalah

Message bus (`slices/comms/comms.ts`) pake array in-memory:
```typescript
private messages: CommsMessage[] = [];
```

- ❌ Pesan ilang kalau main session restart
- ❌ Gak bisa query/debug lintas sub-agent
- ❌ Race condition kalo concurrent write
- ❌ Persistence cuma lewat `pi.appendEntry()` — double-write rawan inkonsistensi

## 2. Solusi

Ganti storage dari array ke SQLite (`bun:sqlite` — bawaan Bun, nol dependensi).

### Prinsip

- **API permukaan `MessageBus` TETAP IDENTIK** — consumer gak perlu perubahan
- **Subscriptions (callback) tetap in-memory** — itu runtime, bukan data
- **DB per project directory** — biar pesan gak nyampur antar project
- **Auto-cleanup 30 hari** — constructor hapus pesan expired

---

## 3. File Kena

### 3.1 `slices/comms/comms.ts` — file utama

#### Import baru

```typescript
import { Database } from "bun:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as crypto from "node:crypto";
```

#### Constructor — Init DB + Auto-cleanup

```typescript
export class MessageBus {
  private db: Database;
  private subscriptions: CommsSubscription[] = [];

  constructor(cwd?: string) {
    const projectHash = cwd
      ? crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12)
      : "default";
    const dbPath = path.join(
      homedir(), ".local", "share", "pi",
      `crew-of-pi-${projectHash}.db`
    );
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS crew_messages (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      in_reply_to TEXT
    )`);

    // Auto-cleanup: hapus pesan lebih dari 30 hari
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    this.db.run("DELETE FROM crew_messages WHERE timestamp < ?", [thirtyDaysAgo]);
  }
```

#### `send()` — INSERT pake prepared statement ✅ (no SQL injection)

```typescript
send(from: string, to: string, type: SubagentMessageType, content: string, inReplyTo?: string): CommsMessage {
  const message: CommsMessage = {
    id: crypto.randomUUID(), // Bun global, gak perlu import
    from,
    to,
    type,
    content,
    timestamp: Date.now(),
    inReplyTo,
  };

  this.db.run(
    "INSERT INTO crew_messages (id, from_id, to_id, type, content, timestamp, in_reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [message.id, message.from, message.to, message.type, message.content, message.timestamp, message.inReplyTo ?? null]
  );
  this.deliver(message);
  return message;
}
```

#### `getMessagesFor()` — SELECT

```typescript
getMessagesFor(recipientId: string): CommsMessage[] {
  const rows = this.db.query(
    "SELECT id, from_id, to_id, type, content, timestamp, in_reply_to FROM crew_messages WHERE to_id = ? OR to_id = 'broadcast' ORDER BY timestamp"
  ).all(recipientId);
  return rows.map(rowToMessage);
}
```

#### `getUnreadFor()` — SELECT with timestamp

```typescript
getUnreadFor(recipientId: string, sinceTimestamp: number): CommsMessage[] {
  const rows = this.db.query(
    "SELECT id, from_id, to_id, type, content, timestamp, in_reply_to FROM crew_messages WHERE (to_id = ? OR to_id = 'broadcast') AND timestamp > ? ORDER BY timestamp"
  ).all(recipientId, sinceTimestamp);
  return rows.map(rowToMessage);
}
```

#### `getHistory()` — SELECT all

```typescript
getHistory(): CommsMessage[] {
  return this.db.query(
    "SELECT id, from_id, to_id, type, content, timestamp, in_reply_to FROM crew_messages ORDER BY timestamp"
  ).all().map(rowToMessage);
}
```

#### `injectHistory()` — INSERT OR IGNORE

```typescript
injectHistory(message: CommsMessage): void {
  this.db.run(
    "INSERT OR IGNORE INTO crew_messages (id, from_id, to_id, type, content, timestamp, in_reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [message.id, message.from, message.to, message.type, message.content, message.timestamp, message.inReplyTo ?? null]
  );
}
```

#### `clear()` — DELETE

```typescript
clear(): void {
  this.db.run("DELETE FROM crew_messages");
  this.subscriptions = [];
}
```

#### `count` — SELECT COUNT

```typescript
get count(): number {
  const row = this.db.query("SELECT COUNT(*) AS cnt FROM crew_messages").get() as { cnt: number };
  return row.cnt;
}
```

#### `resetMessageBus()` — Close DB + null (FIX P0)

```typescript
export function resetMessageBus(): void {
  if (_instance) {
    _instance.db.close();
    _instance = null;
  }
}
```

#### Helper — Row → CommsMessage

```typescript
function rowToMessage(row: any): CommsMessage {
  return {
    id: row.id,
    from: row.from_id,
    to: row.to_id,
    type: row.type as SubagentMessageType,
    content: row.content,
    timestamp: row.timestamp,
    inReplyTo: row.in_reply_to ?? undefined,
  };
}
```

#### Yang DIHAPUS dari comms.ts

| Fungsi | Alasan |
|--------|--------|
| `private messages: CommsMessage[]` | Ganti SQLite |
| `private nextId: number` | Ganti `crypto.randomUUID()` |
| `CommsChannel` interface | Gak dipake |
| `const CHANNEL_BROADCAST` | Tetep dipake di relay |
| `const CHANNEL_MAIN` | Tetep dipake di relay |
| `restoreBusState()` | Gak perlu — SQLite udah persist |
| `loadPersistedMessages()` | Sama |
| `persistMessage()` | Gak perlu — `send()` udah INSERT |
| `injectHistory()` → update `nextId` | Ganti INSERT OR IGNORE |

### 3.2 `slices/lifecycle/lifecycle.respond.ts`

**Hapus** import `persistMessage` dan panggil `persistMessage(pi, sentMessage)` — `bus.send()` udah handle persistence.

### 3.3 `index.ts`

**Hapus** import `restoreBusState` dan panggil `restoreBusState(pi, ctx)` di session_start.

### 3.4 TETAP TIDAK Berubah

| File | Alasan |
|------|--------|
| `slices/chain/chain.orchestrator.ts` | Panggil `bus.send()` — otomatis di-persist SQLite |
| `slices/agents/agents.registry.ts` | Gak sentuh comms |
| `slices/spawn/spawn.manager.ts` | Gak sentuh comms |
| `slices/spawn/spawn.tool.ts` | Gak sentuh comms |

---

## 4. Skema DB

```sql
CREATE TABLE IF NOT EXISTS crew_messages (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  in_reply_to TEXT
);
```

**DB file per project:** `~/.local/share/pi/crew-of-pi-<12-char-hash>.db`

---

## 5. Urutan Eksekusi

1. `slices/comms/comms.ts` — ganti storage, tambah helper, hapus fungsi lama
2. `slices/lifecycle/lifecycle.respond.ts` — hapus import + panggil `persistMessage`
3. `index.ts` — hapus import + panggil `restoreBusState`
4. `git diff --stat` — verifikasi cuma 3 file kena
5. Test manual: `bun -e "import { getMessageBus } from './slices/comms/comms'; ..."`

---

## 6. Ringkasan Diff

| File | Perubahan |
|------|-----------|
| `slices/comms/comms.ts` | ~55 baris baru, ~35 hapus |
| `slices/lifecycle/lifecycle.respond.ts` | 2 baris hapus |
| `index.ts` | 2 baris hapus |
| **Total** | **~20 baris net baru** |
| **Dependensi baru** | **0** |
| **File baru** | **0** |

---

## 7. Risk Register

| Risiko | Dampak | Mitigasi |
|--------|--------|----------|
| DB file corrupt | Kehilangan history pesan | `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` — aman |
| File descriptor leak | Tiap session startup bocor 1 FD | `resetMessageBus()` panggil `db.close()` |
| SQL injection | Content dari model output | Prepared statements (`?` placeholders) — no interpolation |
| Cross-session message bleed | Pesan dari session lain kebaca | DB per project (`crew-of-pi-<hash>.db`) + auto-cleanup 30 hari |
