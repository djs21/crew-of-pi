/**
 * Comms — inter-agent message bus, relay, and persistence.
 *
 * Consolidated from: comms.bus.ts, comms.relay.ts, comms.persistence.ts, comms.types.ts
 * Deleted (was pass-through): those 4 files.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentMessageType } from "../../shared/types";
import { Database } from "bun:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as crypto from "node:crypto";

// ─── Types (was comms.types.ts) ─────────────────────────────────

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

// ─── MessageBus (was comms.bus.ts) ──────────────────────────────

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

    this.db.run(
      "INSERT INTO crew_messages (id, from_id, to_id, type, content, timestamp, in_reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [message.id, message.from, message.to, message.type, message.content, message.timestamp, message.inReplyTo ?? null]
    );
    this.deliver(message);
    return message;
  }

  getMessagesFor(recipientId: string): CommsMessage[] {
    const rows = this.db.query(
      "SELECT id, from_id, to_id, type, content, timestamp, in_reply_to FROM crew_messages WHERE to_id = ? OR to_id = 'broadcast' ORDER BY timestamp"
    ).all(recipientId);
    return rows.map(rowToMessage);
  }

  getUnreadFor(recipientId: string, sinceTimestamp: number): CommsMessage[] {
    const rows = this.db.query(
      "SELECT id, from_id, to_id, type, content, timestamp, in_reply_to FROM crew_messages WHERE (to_id = ? OR to_id = 'broadcast') AND timestamp > ? ORDER BY timestamp"
    ).all(recipientId, sinceTimestamp);
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

  getHistory(): CommsMessage[] {
    return this.db.query(
      "SELECT id, from_id, to_id, type, content, timestamp, in_reply_to FROM crew_messages ORDER BY timestamp"
    ).all().map(rowToMessage);
  }

  injectHistory(message: CommsMessage): void {
    this.db.run(
      "INSERT OR IGNORE INTO crew_messages (id, from_id, to_id, type, content, timestamp, in_reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [message.id, message.from, message.to, message.type, message.content, message.timestamp, message.inReplyTo ?? null]
    );
  }

  clear(): void {
    this.db.run("DELETE FROM crew_messages");
    this.subscriptions = [];
  }

  get count(): number {
    const row = this.db.query("SELECT COUNT(*) AS cnt FROM crew_messages").get() as { cnt: number };
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

// ─── Singleton (was comms.bus.ts) ───────────────────────────────

let _instance: MessageBus | null = null;

export function getMessageBus(): MessageBus {
  if (!_instance) {
    _instance = new MessageBus();
  }
  return _instance;
}

export function resetMessageBus(): void {
  if (_instance) {
    _instance.db.close();
    _instance = null;
  }
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

// ─── Relay (was comms.relay.ts) ─────────────────────────────────

/**
 * Register relay from message bus to main agent.
 */
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

/**
 * Send a response from main agent to a subagent.
 */
export function respondToSubagent(
  pi: ExtensionAPI,
  subagentId: string,
  message: string,
  inReplyTo?: string,
): CommsMessage {
  const bus = getMessageBus();
  const sent = bus.send(CHANNEL_MAIN, subagentId, "response", message, inReplyTo);
  return sent;
}

/**
 * Broadcast from main agent to all subagents.
 */
export function broadcastToAll(pi: ExtensionAPI, message: string): void {
  const bus = getMessageBus();
  const sent = bus.send(CHANNEL_MAIN, "broadcast", "broadcast", message);
}
