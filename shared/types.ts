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
  task: string;
  model?: string;
  interactive: boolean;
  spawnedAt: number;
  ownerSession?: string;
  turns: number;
  usage: UsageStats;
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

// ─── Chain Types ────────────────────────────────────────────────

export interface ChainStep {
  agent: string;
  task: string;
  cwd?: string;
}

export interface ChainConfig {
  chain: ChainStep[];
  stopOnError?: boolean;
}

export interface ChainHandle {
  id: string;
  steps: ChainStep[];
  currentStep: number;
  status: "running" | "completed" | "failed" | "aborted";
  results: ChainStepResult[];
}

export interface ChainStepResult {
  step: number;
  agent: string;
  task: string;
  output: string;
  exitCode: number;
  usage: UsageStats;
  errorMessage?: string;
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