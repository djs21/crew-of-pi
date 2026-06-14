/**
 * crew_list tool — list available subagent definitions and running subagents.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getAgentRegistry } from "../agents/agents.registry";

export function registerCrewListTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "crew_list",
    label: "Crew List",
    description: "List available subagent definitions and running subagents.",
    parameters: Type.Object({}),
    promptSnippet: "List available subagents and active subagents. Use only for discovery or a requested status snapshot.",
    promptGuidelines: [
      "crew_list: List available subagent definitions and active subagents.",
      "crew_list: Use before crew_spawn to discover names, models, tools, and interactive status.",
      "crew_list: Use only for discovery or a requested status snapshot — do NOT poll for completion.",
      "crew_list: Subagent results arrive automatically as steering messages. Polling wastes turns.",
    ],

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
      const registry = getAgentRegistry();
      const available = registry.getAll();
      const running = registry.getRunning();

      // Anti-polling warning: tell main agent not to repeatedly check status
      if (running.length > 0) {
        pi.sendMessage(
          {
            customType: "crew-list-warning",
            content: "⚠ Active subagents detected. Do NOT poll crew_list for completion — results arrive automatically as steering messages. Continue with other work or end your turn and wait.",
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      }

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
}