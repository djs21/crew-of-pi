/**
 * Widget renderer — renders the TUI widget showing running subagents.
 * Uses factory function + spinner animation (like pi-crew pattern).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getWidgetStore } from "./widget.store";
import type { WidgetRow } from "./widget.types";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// ─── Formatting ─────────────────────────────────────────────────

const STATUS_ICON: Record<string, string> = {
  running: "⏳",
  spawned: "⏳",
  completed: "✅",
  failed: "❌",
  aborted: "⏹️",
  orphaned: "👻",
};

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function buildWidgetLine(row: WidgetRow, frame: string): string {
  const model = row.model ?? "…";
  const icon = STATUS_ICON[row.status] ?? frame;
  return `${icon} ${row.id} (${model}) · turn ${row.turns} · ${formatTokens(row.usage.contextTokens)} ctx`;
}

// ─── Widget State ───────────────────────────────────────────────

interface WidgetState {
  ctx: ExtensionContext;
  text: Text;
  // biome-ignore lint: TUI type from factory param
  tui: any;
  timer: ReturnType<typeof setInterval>;
  frameIndex: number;
}

let widget: WidgetState | undefined;

function disposeWidget(state: WidgetState): void {
  clearInterval(state.timer);
  if (widget === state) widget = undefined;
}

function clearWidget(): void {
  const current = widget;
  if (!current) return;
  disposeWidget(current);
  current.ctx.ui.setWidget("crew-status", undefined);
}

function hasRunningAgent(rows: WidgetRow[]): boolean {
  return rows.some((r) => r.status === "running" || r.status === "spawned");
}

function syncWidgetText(state: WidgetState, rows: WidgetRow[]): void {
  const frame = SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length];
  state.text.setText(rows.map((r) => buildWidgetLine(r, frame)).join("\n"));
  state.tui.requestRender();
}

// ─── Public API ─────────────────────────────────────────────────

export function updateWidget(ctx: ExtensionContext): void {
  // Only render in interactive TUI mode
  if (ctx.mode !== "tui") {
    clearWidget();
    return;
  }

  const store = getWidgetStore();
  const rows = store.getActiveSummaries();

  if (rows.length === 0) {
    clearWidget();
    return;
  }

  // If widget exists but context changed, replace it
  if (widget && widget.ctx !== ctx) clearWidget();
  if (widget) {
    syncWidgetText(widget, rows);
    return;
  }

  // Create new widget with spinner animation
  ctx.ui.setWidget("crew-status", (tui: any, _theme: any) => {
    const text = new Text("", 1, 0);
    const state: WidgetState = {
      ctx,
      text,
      tui,
      frameIndex: 0,
      timer: setInterval(() => {
        const currentRows = store.getActiveSummaries();
        if (currentRows.length === 0) {
          clearWidget();
          return;
        }
        if (!hasRunningAgent(currentRows)) return;
        state.frameIndex++;
        syncWidgetText(state, currentRows);
      }, SPINNER_INTERVAL_MS),
    };

    widget = state;
    syncWidgetText(state, rows);

    return Object.assign(text, {
      dispose() {
        disposeWidget(state);
      },
    });
  });
}
