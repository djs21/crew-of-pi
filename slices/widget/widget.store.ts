/**
 * Widget store — manages the TUI widget state for running subagents.
 */

import type { SubagentHandle } from "../../shared/types";
import type { WidgetRow, WidgetState } from "./widget.types";
import { DEFAULT_WIDGET_STATE, MAX_SETTLED_ROWS, MAX_WIDGET_ROWS } from "./widget.types";

export class WidgetStore {
  private state: WidgetState = { ...DEFAULT_WIDGET_STATE };
  private listeners: Array<(state: WidgetState) => void> = [];

  /**
   * Add or update a row from a subagent handle.
   */
  upsertFromHandle(handle: SubagentHandle): void {
    const existingIndex = this.state.rows.findIndex((r) => r.id === handle.id);

    const row: WidgetRow = {
      id: handle.id,
      agentName: handle.agentName,
      status: handle.status,
      turns: handle.turns,
      usage: handle.usage,
      model: handle.model,
      task: handle.task,
      _tool: handle._tool,


    if (existingIndex >= 0) {
      this.state.rows[existingIndex] = row;
    } else {
      this.state.rows.push(row);
      // Trim to max rows
      if (this.state.rows.length > MAX_WIDGET_ROWS) {
        this.state.rows = this.state.rows.slice(-MAX_WIDGET_ROWS);
      }
    }

    this.notify();
  }

  /**
   * Remove a row by subagent ID.
   */
  remove(id: string): void {
    this.state.rows = this.state.rows.filter((r) => r.id !== id);
    this.notify();
  }

  /**
   * Update a specific field on a row.
   */
  update(id: string, updates: Partial<WidgetRow>): void {
    const index = this.state.rows.findIndex((r) => r.id === id);
    if (index >= 0) {
      this.state.rows[index] = { ...this.state.rows[index], ...updates };
      this.notify();
    }
  }

  /**
   * Get the current state.
   */
  getState(): WidgetState {
    return { ...this.state, rows: [...this.state.rows] };
  }

  /**
   * Get rows for widget display:
   * - Active agents (spawned/running) shown as-is.
   * - Last MAX_SETTLED_ROWS (4) settled agents (completed/failed/aborted) shown as compact history.
   */
  getActiveSummaries(): WidgetRow[] {
    const active = this.state.rows.filter(
      (r) => r.status === "spawned" || r.status === "running",
    );
    const settled = this.state.rows.filter(
      (r) => r.status === "completed" || r.status === "failed" || r.status === "aborted",
    );
    return [...active, ...settled.slice(-MAX_SETTLED_ROWS)];
  }

  /**
   * Set visibility.
   */
  setVisible(visible: boolean): void {
    this.state.isVisible = visible;
    this.notify();
  }

  /**
   * Clear all rows.
   */
  clear(): void {
    this.state.rows = [];
    this.notify();
  }

  /**
   * Subscribe to state changes.
   */
  subscribe(listener: (state: WidgetState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Notify all listeners of state change.
   */
  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // Isolate listener errors
      }
    }
  }
}

// Singleton
let _instance: WidgetStore | null = null;

export function getWidgetStore(): WidgetStore {
  if (!_instance) {
    _instance = new WidgetStore();
  }
  return _instance;
}

export function resetWidgetStore(): void {
  _instance = null;
}