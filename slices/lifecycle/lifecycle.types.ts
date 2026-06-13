/**
 * Lifecycle types — subagent lifecycle management.
 */

export type AbortMode = "single" | "all";

export interface AbortConfig {
  subagentId?: string;
  all?: boolean;
}

export interface RespondConfig {
  subagentId: string;
  message: string;
}

export interface DoneConfig {
  subagentId: string;
}

export interface LifecycleResult {
  success: boolean;
  subagentId?: string;
  status?: string;
  message: string;
}