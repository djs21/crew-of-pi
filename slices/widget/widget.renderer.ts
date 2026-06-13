/**
 * Widget renderer — renders the TUI widget showing running subagents.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getWidgetStore } from "./widget.store";
import type { WidgetRow } from "./widget.types";

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function getStatusIcon(status: string): string {
  switch (status) {
    case "running":
    case "spawned":
      return "🟢";
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    case "aborted":
      return "⛔";
    case "orphaned":
      return "👻";
    default:
      return "⚪";
  }
}

function formatRow(row: WidgetRow): string {
  const icon = getStatusIcon(row.status);
  const usage = row.usage;
  const parts: string[] = [`${icon} ${row.agentName}`, `[${row.status}]`];
  if (usage.turns > 0) parts.push(`${usage.turns} turns`);
  if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  if (row.model) parts.push(row.model);

  return parts.join("  ");
}

/**
 * Build the widget text lines.
 */
export function buildWidgetLines(): string[] {
  const store = getWidgetStore();
  const state = store.getState();

  if (!state.isVisible || state.rows.length === 0) {
    return [];
  }

  const lines: string[] = [];
  const running = state.rows.filter(
    (r) => r.status === "running" || r.status === "spawned",
  );
  const completed = state.rows.filter((r) => r.status === "completed");
  const failed = state.rows.filter(
    (r) => r.status === "failed" || r.status === "aborted" || r.status === "orphaned",
  );

  // Running first
  for (const row of running) {
    lines.push(formatRow(row));
  }

  // Then failed
  for (const row of failed) {
    lines.push(formatRow(row));
  }

  // Then completed (only if space)
  if (running.length + failed.length < 5) {
    for (const row of completed.slice(0, 3)) {
      lines.push(formatRow(row));
    }
  }

  // Summary line
  const total = state.rows.length;
  const runCount = running.length;
  if (total > 0) {
    lines.push(`─── ${runCount} running, ${total} total ───`);
  }

  return lines;
}

/**
 * Update the TUI widget with current state.
 */
export function renderWidget(pi: ExtensionAPI): void {
  // pi.ui only available in interactive mode; skip for print/json/rpc modes
  if (!pi.ui) return;

  const lines = buildWidgetLines();
  if (lines.length > 0) {
    pi.ui.setWidget("crew-status", lines);
  } else {
    pi.ui.setWidget("crew-status", []);
  }
}