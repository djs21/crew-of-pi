/**
 * Live agent registry — maintains an in-memory cache of discovered agents.
 * Refreshed on session_start and on demand.
 */

import type { AgentConfig, AgentScope, SubagentHandle } from "../../shared/types";
import { discoverAgents } from "./agents.discovery";

/**
 * In-memory agent registry with running subagent tracking.
 */
export class AgentRegistry {
  private agents: AgentConfig[] = [];
  private runningAgents: Map<string, SubagentHandle> = new Map();
  private cwd: string = "";
  private scope: AgentScope = "user";

  /**
   * Refresh the agent list from disk.
   */
  refresh(cwd: string, scope: AgentScope): AgentConfig[] {
    this.cwd = cwd;
    this.scope = scope;
    const result = discoverAgents(cwd, scope);
    this.agents = result.agents;
    return this.agents;
  }

  /**
   * Get all discovered agents.
   */
  getAll(): AgentConfig[] {
    return this.agents;
  }

  /**
   * Find a specific agent by name.
   */
  get(name: string): AgentConfig | undefined {
    return this.agents.find((a) => a.name === name);
  }

  /**
   * Get agent names list.
   */
  getNames(): string[] {
    return this.agents.map((a) => a.name);
  }

  /**
   * Register a running subagent.
   */
  registerRunning(handle: SubagentHandle): void {
    this.runningAgents.set(handle.id, handle);
  }

  /**
   * Update a running subagent's status.
   */
  updateRunning(id: string, updates: Partial<SubagentHandle>): SubagentHandle | undefined {
    const existing = this.runningAgents.get(id);
    if (!existing) return undefined;

    const updated: SubagentHandle = { ...existing, ...updates };
    this.runningAgents.set(id, updated);
    return updated;
  }

  /**
   * Remove a running subagent from tracking.
   */
  unregisterRunning(id: string): boolean {
    return this.runningAgents.delete(id);
  }

  /**
   * Get all running subagents.
   */
  getRunning(): SubagentHandle[] {
    return Array.from(this.runningAgents.values());
  }

  /**
   * Get a specific running subagent.
   */
  getRunningById(id: string): SubagentHandle | undefined {
    return this.runningAgents.get(id);
  }

  /**
   * Get counts for display.
   */
  getCounts(): { running: number; completed: number; failed: number } {
    const vals = Array.from(this.runningAgents.values());
    return {
      running: vals.filter((h) => h.status === "running" || h.status === "spawned").length,
      completed: vals.filter((h) => h.status === "completed").length,
      failed: vals.filter((h) => h.status === "failed" || h.status === "aborted").length,
    };
  }

  /**
   * Abort all running subagents.
   */
  clear(): void {
    this.runningAgents.clear();
  }
}

// Singleton instance
let _instance: AgentRegistry | null = null;

export function getAgentRegistry(): AgentRegistry {
  if (!_instance) {
    _instance = new AgentRegistry();
  }
  return _instance;
}

export function resetAgentRegistry(): void {
  _instance = null;
}