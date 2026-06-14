/**
 * crew-of-pi: Async Non-Blocking Subagent Orchestration Extension
 *
 * Entry point — imports & mounts all vertical slices.
 * Each slice is self-contained. To add/remove a feature, add/remove one import.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

// ─── Agent Discovery ────────────────────────────────────────────
import { getAgentRegistry, resetAgentRegistry } from "./slices/agents/agents.registry";
import { setBundledAgentsDir } from "./slices/agents/agents.discovery";

// ─── Spawn ──────────────────────────────────────────────────────
import { registerSpawnTool } from "./slices/spawn/spawn.tool";
import { getWidgetStore, resetWidgetStore } from "./slices/widget/widget.store";

// ─── Blockers ───────────────────────────────────────────────────
import { registerBlocker, setBlockPolicy } from "./slices/blockers/blockers.intercept";

// ─── Prompt ─────────────────────────────────────────────────────
import { registerPromptInjector, setPromptConfig } from "./slices/prompt/prompt.injector";

// ─── Chain ──────────────────────────────────────────────────────
import { registerChainTool } from "./slices/chain/chain.tool";

// ─── Comms ──────────────────────────────────────────────────────
import { registerCommsRelay } from "./slices/comms/comms.relay";
import { getMessageBus, resetMessageBus } from "./slices/comms/comms.bus";
import { restoreBusState } from "./slices/comms/comms.persistence";

// ─── Lifecycle ──────────────────────────────────────────────────
import { registerAbortTool } from "./slices/lifecycle/lifecycle.abort";
import { registerRespondTool } from "./slices/lifecycle/lifecycle.respond";
import { registerDoneTool } from "./slices/lifecycle/lifecycle.done";

// ─── Crew List ─────────────────────────────────────────────────
import { registerCrewListTool } from "./slices/crew-list/crew-list.tool";

// ─── Widget ─────────────────────────────────────────────────────
import { registerWidgetUpdater } from "./slices/widget/widget.updater";

export default function (pi: ExtensionAPI) {
  // ─── Init: Bundled Agents Path ─────────────────────────────
  // jiti provides CommonJS compat: __dirname always available
  const extensionDir = __dirname;
  const bundledAgentsPath = path.join(extensionDir, "agents");
  setBundledAgentsDir(bundledAgentsPath);

  // ─── Init: Session Start (discover agents + restore state) ──
  pi.on("session_start", async (_event, ctx) => {
    const registry = getAgentRegistry();
    registry.refresh(ctx.cwd, "both");

    // Ensure bundled agents dir is set
    setBundledAgentsDir(bundledAgentsPath);

    // Refresh with bundled agents
    registry.refresh(ctx.cwd, "both");

    // Set default block policy
    setBlockPolicy({
      blockedTools: [
        { toolName: "write", reason: "Main agent is read-only. Delegate to 'worker' subagent via crew_spawn." },
        { toolName: "edit", reason: "Main agent is read-only. Delegate to 'worker' subagent via crew_spawn." },
      ],
      allowBashReadOnly: true,
    });

    // Set prompt config
    setPromptConfig({
      enabled: true,
      includeAgentDescriptions: true,
      includeAgentExtensions: true,
      includeRules: true,
    });

    // Restore message bus from previous session entries
    restoreBusState(pi, ctx);

    // Display discovery warnings as notifications
    for (const warning of registry.getUnshownWarnings()) {
      ctx.ui.notify(`${warning.message} (${warning.filePath})`, "error");
    }

  });

  // ─── Init: Session Shutdown (cleanup) ───────────────────────
  pi.on("session_shutdown", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const registry = getAgentRegistry();

    // Abort all running subagents owned by this session
    for (const handle of registry.getRunning()) {
      if (handle.ownerSession === sessionId && handle.pid) {
        try { process.kill(handle.pid, "SIGTERM"); } catch { /* already dead */ }
      }
    }

    resetAgentRegistry();
    resetMessageBus();
    resetWidgetStore();
  });

  // ─── Register Tools ─────────────────────────────────────────
  registerSpawnTool(pi);

  registerChainTool(pi);

  registerAbortTool(pi);
  registerRespondTool(pi);
  registerDoneTool(pi);
  registerCrewListTool(pi);

  // ─── Register Events ────────────────────────────────────────
  registerBlocker(pi);
  registerPromptInjector(pi);
  registerCommsRelay(pi);
  registerWidgetUpdater(pi);
}