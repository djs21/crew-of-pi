/**
 * SubagentDb — SQLite-backed persistence for subagent state and events.
 * Uses node:sqlite (DatabaseSync). Shares a single DB connection with MessageBus.
 */
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
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_subagent_status_status ON subagent_status(status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_subagent_status_owner ON subagent_status(owner_session)");
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
