/**
 * widget.ts — Live TUI widget displaying subagent status, turns, and context usage.
 * Consolidated from widget.store.ts, widget.updater.ts, widget.renderer.ts, widget.types.ts.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SubagentHandle, SubagentStatus, UsageStats } from "../shared/types";
import { INITIAL_USAGE } from "../shared/types";
import { getAgentRegistry } from "./agents";

// ─── Types & Store ─────────────────────────────────────────────────

export interface WidgetRow {
  id: string;
  agentName: string;
  status: SubagentStatus;
  turns: number;
  usage: UsageStats;
  model?: string;
  task?: string;
  _tool?: string;
}

const MAX_WIDGET_ROWS = 10;
const MAX_SETTLED_ROWS = 4;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

const STATUS_ICON: Record<string, string> = {
  running: "⚡",
  spawned: "⏳",
  completed: "✅",
  failed: "❌",
  aborted: "⏹️",
  stalled: "⚠️",
  orphaned: "👻",
};

export class WidgetStore {
  private rows: WidgetRow[] = [];

  upsertFromHandle(handle: SubagentHandle): void {
    const existingIndex = this.rows.findIndex((r) => r.id === handle.id);
    const row: WidgetRow = {
      id: handle.id,
      agentName: handle.agentName,
      status: handle.status,
      turns: handle.turns,
      usage: handle.usage ?? { ...INITIAL_USAGE },
      model: handle.model,
      task: handle.task,
      _tool: handle._tool,
    };

    if (existingIndex >= 0) {
      this.rows[existingIndex] = row;
    } else {
      this.rows.push(row);
      if (this.rows.length > MAX_WIDGET_ROWS) {
        this.rows = this.rows.slice(-MAX_WIDGET_ROWS);
      }
    }
  }

  clear(): void {
    this.rows = [];
  }

  getActiveSummaries(): WidgetRow[] {
    const active = this.rows.filter((r) => r.status === "spawned" || r.status === "running");
    const settled = this.rows.filter(
      (r) => r.status === "completed" || r.status === "failed" || r.status === "aborted" || r.status === "orphaned",
    );
    return [...active, ...settled.slice(-MAX_SETTLED_ROWS)];
  }
}

let _store: WidgetStore | null = null;

export function getWidgetStore(): WidgetStore {
  if (!_store) {
    _store = new WidgetStore();
  }
  return _store;
}

// ─── Formatting & Rendering ────────────────────────────────────────

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function isSettledStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "aborted" || status === "orphaned";
}

function buildActiveLine(row: WidgetRow, frame: string): string {
  const model = row.model ?? "…";
  const icon = row.status === "running" ? frame : (STATUS_ICON[row.status] ?? frame);
  const taskPreview = row.task ? (row.task.length > 35 ? row.task.slice(0, 35).trimEnd() + "…" : row.task) : "";

  let line = `${icon} ${row.agentName} (${model})`;
  if (row._tool) {
    line += ` [${row._tool}]`;
  }
  if (taskPreview) {
    line += ` · ${taskPreview}`;
  }
  line += row.turns === 0 && row.status === "running" && !row._tool
    ? ` · ⏳ thinking...`
    : ` · turn ${row.turns} · ${formatTokens(row.usage.contextTokens)} ctx`;
  return line;
}

function buildSettledLine(row: WidgetRow): string {
  const model = row.model ?? "…";
  const icon = STATUS_ICON[row.status] ?? "✅";
  const taskPreview = row.task ? (row.task.length > 35 ? row.task.slice(0, 35).trimEnd() + "…" : row.task) : "";

  let line = `  ${icon} ${row.agentName} (${model})`;
  if (row.status === "aborted") {
    line += ` · [cancelled]`;
  } else if (row.status === "failed") {
    line += ` · [failed]`;
  }
  if (taskPreview) {
    line += ` · ${taskPreview}`;
  }
  line += ` · turn ${row.turns} · ${formatTokens(row.usage.contextTokens)} ctx`;
  return line;
}

interface ActiveWidget {
  ctx: ExtensionContext;
  text: Text;
  tui: any;
  timer: ReturnType<typeof setInterval>;
  frameIndex: number;
}

let activeWidget: ActiveWidget | undefined;

function clearWidget(): void {
  if (!activeWidget) return;
  clearInterval(activeWidget.timer);
  activeWidget.ctx.ui.setWidget("crew-status", undefined);
  activeWidget = undefined;
}

function syncWidgetText(state: ActiveWidget, rows: WidgetRow[]): void {
  const frame = SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length];
  const lines: string[] = [];
  let hasActive = false;
  let enteredSettled = false;

  for (const row of rows) {
    if (isSettledStatus(row.status)) {
      if (!enteredSettled) {
        enteredSettled = true;
        if (hasActive) lines.push("  ─ ─ ─");
      }
      lines.push(buildSettledLine(row));
    } else {
      hasActive = true;
      lines.push(buildActiveLine(row, frame));
    }
  }

  state.text.setText(lines.join("\n"));
  state.tui.requestRender();
}

export function updateWidget(ctx: ExtensionContext): void {
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

  if (activeWidget) {
    syncWidgetText(activeWidget, rows);
    return;
  }

  ctx.ui.setWidget("crew-status", (_tui: any, theme: any) => {
    const textWidget = new Text("", 0, 0);
    const state: ActiveWidget = {
      ctx,
      text: textWidget,
      tui: _tui,
      frameIndex: 0,
      timer: null as any,
    };

    state.timer = setInterval(() => {
      state.frameIndex++;
      const currentRows = getWidgetStore().getActiveSummaries();
      if (currentRows.length === 0) {
        clearWidget();
        return;
      }
      syncWidgetText(state, currentRows);
    }, SPINNER_INTERVAL_MS);

    activeWidget = state;
    syncWidgetText(state, rows);
    return textWidget;
  });
}

// ─── Updater & Lifecycle Hooks ─────────────────────────────────────

let _currentCtx: ExtensionContext | undefined;
let _pi: ExtensionAPI | undefined;

export function refreshWidget(): void {
  if (!_currentCtx || !_pi) return;
  const registry = getAgentRegistry();
  const store = getWidgetStore();
  const running = registry.getRunning();

  store.clear();
  for (const handle of running) {
    store.upsertFromHandle(handle);
  }

  updateWidget(_currentCtx);
}

export function syncWidgetFromRegistry(_pi: ExtensionAPI): void {
  refreshWidget();
}

export function registerWidgetUpdater(pi: ExtensionAPI): void {
  _pi = pi;

  pi.on("session_start", async (_event, ctx) => {
    _currentCtx = ctx;
    refreshWidget();
  });

  pi.on("session_shutdown", async () => {
    getWidgetStore().clear();
    if (_currentCtx) updateWidget(_currentCtx);
    _currentCtx = undefined;
  });
}
