/**
 * crew-of-pi: Async Non-Blocking Subagent Orchestration Extension
 *
 * Entry point — imports & mounts all vertical slices.
 * Each slice is self-contained. To add/remove a feature, add/remove one import.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

// ─── Lifecycle ──────────────────────────────────────────────────
import { registerAbortTool } from "./slices/lifecycle/lifecycle.abort";
import { registerRespondTool } from "./slices/lifecycle/lifecycle.respond";
import { registerDoneTool } from "./slices/lifecycle/lifecycle.done";

// ─── Widget ─────────────────────────────────────────────────────
import { registerWidgetUpdater, syncWidgetFromRegistry } from "./slices/widget/widget.updater";
import { renderWidget } from "./slices/widget/widget.renderer";

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

    // Render widget
    renderWidget(pi);
  });

  // ─── Init: Session Shutdown (cleanup) ───────────────────────
  pi.on("session_shutdown", async () => {
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

  // ─── crew_list Tool (inline — lightweight) ──────────────────
  pi.registerTool({
    name: "crew_list",
    label: "Crew List",
    description: "List available subagent definitions and running subagents.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const registry = getAgentRegistry();
      const available = registry.getAll();
      const running = registry.getRunning();

      let text = "## Available Subagents\n\n";
      if (available.length === 0) {
        text += "None found.\n";
      } else {
        for (const agent of available) {
          text += `- **${agent.name}**: ${agent.description}`;
          text += ` (source: ${agent.source}`;
          if (agent.model) text += `, model: ${agent.model}`;
          if (agent.tools) text += `, tools: ${agent.tools.join(", ")}`;
          if (agent.extensions.length > 0) {
            text += `, extensions: ${agent.extensions.map((e) => e.value).join(", ")}`;
          }
          text += ")\n";
        }
      }

      text += "\n## Running Subagents\n\n";
      if (running.length === 0) {
        text += "None.\n";
      } else {
        for (const h of running) {
          text += `- **${h.agentName}** (${h.id}): ${h.status}`;
          text += `, ${h.turns} turns`;
          if (h.usage.cost > 0) text += `, $${h.usage.cost.toFixed(4)}`;
          text += "\n";
        }
      }

      return {
        content: [{ type: "text", text }],
        details: {
          available: available.map((a) => ({ name: a.name, description: a.description })),
          running: running.map((h) => ({ id: h.id, agent: h.agentName, status: h.status })),
        },
      };
    },
  });

  // ─── Register Events ────────────────────────────────────────
  registerBlocker(pi);
  registerPromptInjector(pi);
  registerCommsRelay(pi);
  registerWidgetUpdater(pi);
}