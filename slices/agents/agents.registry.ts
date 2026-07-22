/**
 * Live agent registry — maintains an in-memory cache of discovered agents.
 * Refreshed on session_start and on demand.
 */

import type { AgentConfig, AgentDiscoveryWarning, AgentScope, SubagentHandle } from "../../shared/types";
import { statusRowToHandle } from "../../shared/types";
import { discoverAgents } from "./agents.discovery";
import { loadCrewConfig, applyConfigOverrides } from "./agents.discovery";

/**
 * In-memory agent registry with running subagent tracking.
 */
export class AgentRegistry {
  private agents: AgentConfig[] = [];
  private runningAgents: Map<string, SubagentHandle> = new Map();
  private discoveryWarnings: AgentDiscoveryWarning[] = [];
  private shownWarnings: Set<string> = new Set();
  private cwd: string = "";
  private scope: AgentScope = "user";
  private _db: any; // SubagentDb — set externally via setDb

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

  /**
   * Refresh the agent list from disk.
   */
  refresh(cwd: string, scope: AgentScope): AgentConfig[] {
    this.cwd = cwd;
    this.scope = scope;
    const result = discoverAgents(cwd, scope);

    // Collect discovery warnings
    this.discoveryWarnings = result.warnings;

    // Apply config overrides (project overrides global)
    const config = loadCrewConfig(cwd);
    if (config && config.agents && Object.keys(config.agents).length > 0) {
      this.agents = applyConfigOverrides(result.agents, config);
    } else {
      this.agents = result.agents;
    }

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
   * Abort all running subagents.
   */
  clear(): void {
    this.runningAgents.clear();
  }

  /**
   * Get warnings that haven't been shown yet, and mark them as shown.
   */
  getUnshownWarnings(): AgentDiscoveryWarning[] {
    const unshown = this.discoveryWarnings.filter((w) => {
      const key = `${w.filePath}:${w.message}`;
      if (this.shownWarnings.has(key)) return false;
      this.shownWarnings.add(key);
      return true;
    });
    return unshown;
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