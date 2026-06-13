/**
 * Widget updater — event-driven updates to the widget state.
 * Connects to spawn, lifecycle, and other events to keep widget in sync.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getWidgetStore } from "./widget.store";
import { renderWidget } from "./widget.renderer";
import { getAgentRegistry } from "../agents/agents.registry";

/**
 * Register all event handlers that update the widget.
 */
export function registerWidgetUpdater(pi: ExtensionAPI): void {
  // On session start, sync widget with registry
  pi.on("session_start", async () => {
    const registry = getAgentRegistry();
    const store = getWidgetStore();
    const running = registry.getRunning();
    store.clear();
    for (const handle of running) {
      store.upsertFromHandle(handle);
    }
    renderWidget(pi);
  });

  // On session shutdown, clean up
  pi.on("session_shutdown", async () => {
    const store = getWidgetStore();
    store.clear();
    renderWidget(pi);
  });
}

/**
 * Sync widget from the agent registry (call after any registry change).
 */
export function syncWidgetFromRegistry(pi: ExtensionAPI): void {
  const registry = getAgentRegistry();
  const store = getWidgetStore();

  const running = registry.getRunning();
  store.clear();
  for (const handle of running) {
    store.upsertFromHandle(handle);
  }
  renderWidget(pi);
}