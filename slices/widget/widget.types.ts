/**
 * Widget types — TUI widget state definitions.
 */

import type { SubagentStatus, UsageStats } from "../../shared/types";

export interface WidgetRow {
  id: string;
  agentName: string;
  status: SubagentStatus;
  turns: number;
  usage: UsageStats;
  model?: string;
  task: string;
}

export interface WidgetState {
  rows: WidgetRow[];
  isVisible: boolean;
  collapsedByDefault: boolean;
}

export const MAX_WIDGET_ROWS = 10;
export const MAX_SETTLED_ROWS = 4;
export const DEFAULT_WIDGET_STATE: WidgetState = {
  rows: [],
  isVisible: true,
  collapsedByDefault: true,
};