/**
 * Widget updater — centralized widget refresh callback.
 * Registers session lifecycle handlers and exports refreshWidget for other slices.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getWidgetStore } from "./widget.store";
import { updateWidget } from "./widget.renderer";
import { getAgentRegistry } from "../agents/agents.registry";

let _currentCtx: ExtensionContext | undefined;
let _pi: ExtensionAPI | undefined;

/**
 * Refresh the widget from registry state. Safe to call from anywhere.
 */
export function refreshWidget(): void {
  if (!_currentCtx || !_pi) return;

  const registry = getAgentRegistry();
  const store = getWidgetStore();
  const running = registry.getRunning();

  // Sync store with registry
  store.clear();
  for (const handle of running) {
    store.upsertFromHandle(handle);
  }

  updateWidget(_currentCtx);
}

/**
 * Register lifecycle handlers and save context reference.
 */
export function registerWidgetUpdater(pi: ExtensionAPI): void {
  _pi = pi;

  // On session start, save context and sync widget
  pi.on("session_start", async (_event, ctx) => {
    _currentCtx = ctx;
    const registry = getAgentRegistry();
    const store = getWidgetStore();
    store.clear();
    for (const handle of registry.getRunning()) {
      store.upsertFromHandle(handle);
    }
    updateWidget(ctx);
  });

  // On session shutdown, clean up
  pi.on("session_shutdown", async () => {
    getWidgetStore().clear();
    // updateWidget will clear the widget since rows are empty
    if (_currentCtx) updateWidget(_currentCtx);
    _currentCtx = undefined;
  });
}

/**
 * Sync widget from registry (backward compat — calls refreshWidget).
 */
export function syncWidgetFromRegistry(_pi: ExtensionAPI): void {
  refreshWidget();
}
