/**
 * db.ts — Unified SQLite-backed persistence for crew-of-pi.
 * Combines subagent status/events and inter-agent message bus.
 * Uses node:sqlite (DatabaseSync) in WAL mode.
 */
import { DatabaseSync } from "node:sqlite";
import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentStatusRow, SubagentMessageType, SubagentStatus } from "../shared/types";

// ─── Subagent Persistence (Status & Events) ──────────────────────

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
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_subagent_status_status ON subagent_status(status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_subagent_events_id ON subagent_events(subagent_id, created_at)");
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
      throw err;
    }
  }

  insertEvent(subagentId: string, eventType: string, status: string, turns: number, ctxTokens: number, metadata?: string): void {
    try {
      this.db.prepare(
        "INSERT INTO subagent_events (subagent_id, event_type, status, turns, usage_context_tokens, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(subagentId, eventType, status, turns, ctxTokens, metadata ?? null, Date.now());
    } catch (err) {
      console.error(`[crew-of-pi] DB insertEvent error:`, err);
      throw err;
    }
  }

  getActiveStatuses(): SubagentStatusRow[] {
    return this.db.prepare(
      "SELECT * FROM subagent_status WHERE status IN ('spawned', 'running') ORDER BY spawned_at"
    ).all() as unknown as SubagentStatusRow[];
  }

  orphanStaleSessions(): number {
    const cutoff = Date.now() - 30 * 60 * 1000;
    const result = this.db.prepare(
      "UPDATE subagent_status SET status = 'orphaned', updated_at = ? WHERE status IN ('spawned', 'running') AND last_heartbeat < ?"
    ).run(Date.now(), cutoff);
    return Number(result.changes);
  }
}

// ─── Inter-Agent Comms (Message Bus) ──────────────────────────────

export interface CommsMessage {
  id: string;
  from: string;
  to: string;
  type: SubagentMessageType;
  content: string;
  timestamp: number;
  inReplyTo?: string;
}

interface CommsSubscription {
  channel: string;
  handler: (message: CommsMessage) => void;
}

const CHANNEL_BROADCAST = "broadcast";
const CHANNEL_MAIN = "main";

export class MessageBus {
  private db: DatabaseSync;
  private subscriptions: CommsSubscription[] = [];

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS crew_messages (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      in_reply_to TEXT
    )`);
  }

  send(from: string, to: string, type: SubagentMessageType, content: string, inReplyTo?: string): CommsMessage {
    const message: CommsMessage = {
      id: crypto.randomUUID(),
      from,
      to,
      type,
      content,
      timestamp: Date.now(),
      inReplyTo,
    };

    this.db.prepare(
      "INSERT INTO crew_messages (id, from_id, to_id, type, content, timestamp, in_reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(message.id, message.from, message.to, message.type, message.content, message.timestamp, message.inReplyTo ?? null);
    this.deliver(message);
    return message;
  }

  getMessagesFor(recipientId: string): CommsMessage[] {
    const rows = this.db.prepare(
      "SELECT id, from_id, to_id, type, content, timestamp, in_reply_to FROM crew_messages WHERE to_id = ? OR to_id = 'broadcast' ORDER BY timestamp"
    ).all(recipientId);
    return rows.map(rowToMessage);
  }

  subscribe(channel: string, handler: (message: CommsMessage) => void): () => void {
    const sub: CommsSubscription = { channel, handler };
    this.subscriptions.push(sub);
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM crew_messages").get() as { cnt: number };
    return row.cnt;
  }

  private deliver(message: CommsMessage): void {
    for (const sub of this.subscriptions) {
      if (
        sub.channel === message.to ||
        sub.channel === CHANNEL_BROADCAST ||
        sub.channel === "all"
      ) {
        try {
          sub.handler(message);
        } catch {
          // Isolate subscriber errors
        }
      }
    }
  }
}

// ─── Singletons & Helpers ──────────────────────────────────────────

let _messageBus: MessageBus | null = null;
let _subagentDb: SubagentDb | null = null;

export function getMessageBus(): MessageBus {
  if (!_messageBus) {
    throw new Error("MessageBus not initialized. Call initDb(db) first.");
  }
  return _messageBus;
}

export function getSubagentDb(): SubagentDb {
  if (!_subagentDb) {
    throw new Error("SubagentDb not initialized. Call initDb(db) first.");
  }
  return _subagentDb;
}

export function initDb(db: DatabaseSync): { subagentDb: SubagentDb; messageBus: MessageBus } {
  _subagentDb = new SubagentDb(db);
  _messageBus = new MessageBus(db);
  return { subagentDb: _subagentDb, messageBus: _messageBus };
}

export function resetDb(): void {
  _subagentDb = null;
  _messageBus = null;
}

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

// ─── Relay Helper ──────────────────────────────────────────────────

export function registerCommsRelay(pi: ExtensionAPI): void {
  const bus = getMessageBus();
  bus.subscribe("all", (message: CommsMessage) => {
    if (message.to !== CHANNEL_MAIN) {
      pi.sendMessage(
        {
          customType: "crew-comms-relay",
          content: `💬 **${message.from}** → **${message.to}**: ${message.content.slice(0, 200)}`,
          display: true,
          details: {
            from: message.from,
            to: message.to,
            type: message.type,
            content: message.content,
            timestamp: message.timestamp,
          },
        },
        { deliverAs: "steer", triggerTurn: false },
      );
    }
  });
}

export function respondToSubagent(
  _pi: ExtensionAPI,
  subagentId: string,
  message: string,
  inReplyTo?: string,
): CommsMessage {
  const bus = getMessageBus();
  return bus.send(CHANNEL_MAIN, subagentId, "response", message, inReplyTo);
}
