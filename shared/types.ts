/**
 * Shared types for crew-of-pi extension.
 *
 * These are the ONLY types shared across slices.
 * Each slice also has its own *.types.ts for slice-specific types.
 * Cross-slice runtime communication goes through these interfaces only.
 */

// ─── Agent Types ────────────────────────────────────────────────

export type AgentScope = "user" | "project" | "both";

export interface AgentExtensionRef {
  type: "path" | "pi-package";
  value: string;
  resolved?: string; // absolute path after resolution (path mode only)
}

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  skills?: string[];
  systemPrompt: string;
  source: "user" | "project" | "bundled";
  filePath: string;
  extensions: AgentExtensionRef[];
  interactive: boolean;
  compaction: boolean;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  warnings: AgentDiscoveryWarning[];
}

export interface AgentDiscoveryWarning {
  filePath: string;
  message: string;
}

// ─── Spawn Types ────────────────────────────────────────────────

export type SubagentStatus =
  | "spawned"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "orphaned";

export interface SubagentHandle {
  id: string;            // unique identifier (crew-<agent>-<random>)
  agentName: string;
  status: SubagentStatus;
  pid?: number;
  proc?: any;  // ChildProcess reference for interactive subagents
  session?: any; // AgentSession reference (post-migration)
  sessionFile?: string; // path ke session file (untuk resume dan fork lineage)
  abortController?: AbortController; // dedicated abort controller for this subagent
  task: string;
  model?: string;
  interactive: boolean;
  spawnedAt: number;
  ownerSession?: string;
  turns: number;
  usage: UsageStats;
}

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
export interface SpawnConfig {
  agent: string;
  task: string;
  model?: string;
  interactive?: boolean;
  cwd?: string;
}

export interface SpawnResult {
  subagent_id: string;
  status: SubagentStatus;
}


// ─── Communication Types ────────────────────────────────────────

export type SubagentMessageType =
  | "request"
  | "response"
  | "handoff"
  | "report"
  | "broadcast"
  | "clarification";

export interface SubagentMessage {
  id: string;
  from: string;           // subagent id
  to: string;             // subagent id or "main" or "all"
  type: SubagentMessageType;
  content: string;
  timestamp: number;
  inReplyTo?: string;     // message id this is replying to
}

export interface BusEntry {
  type: "crew-subagent-spawn" | "crew-subagent-result" | "crew-bus-message" | "crew-status";
  data: Record<string, unknown>;
}

// ─── Prompt Types ───────────────────────────────────────────────

export interface PromptInjectionConfig {
  enabled: boolean;
  preamble: string;
  rules: string[];
}

// ─── Widget Types ───────────────────────────────────────────────

export interface WidgetEntry {
  id: string;
  agentName: string;
  status: SubagentStatus;
  turns: number;
  usage: UsageStats;
  model?: string;
}

export interface WidgetState {
  entries: WidgetEntry[];
  collapsed: boolean;
}

// ─── Shared Utilities ───────────────────────────────────────────

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export const INITIAL_USAGE: UsageStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

export function generateId(agentName: string): string {
  const random = Math.random().toString(36).substring(2, 8);
  return `crew-${agentName}-${random}`;
}

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const PER_TASK_OUTPUT_CAP = 50 * 1024; // 50KB cap per task output