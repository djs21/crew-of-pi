/**
 * crew_spawn tool — spawns a subagent asynchronously.
 * Returns immediately with subagent_id; results delivered as steering message.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type AgentScope } from "../../shared/types";
import { getAgentRegistry } from "../agents/agents.registry";
import { findAgent } from "../agents/agents.discovery";
import { spawnSubagentAsync } from "./spawn.manager";
import { syncWidgetFromRegistry } from "../widget/widget.updater";

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Which agent directories to use. Default: "both" (user + project + bundled). Use "user" for user-only.',
  default: "both",
});

const SpawnParams = Type.Object({
  agent: Type.String({ description: "Name of the subagent to spawn (e.g., worker, scout, planner)" }),
  task: Type.String({ description: "Task description for the subagent" }),
  model: Type.Optional(Type.String({ description: "Override the subagent model" })),
  interactive: Type.Optional(Type.Boolean({ description: "Keep session alive for multi-turn conversations" })),
  agentScope: Type.Optional(AgentScopeSchema),
  cwd: Type.Optional(Type.String({ description: "Working directory for the subagent" })),
});

export function registerSpawnTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "crew_spawn",
    label: "Crew Spawn",
    description: [
      "Spawn a subagent in an isolated session with its own context window.",
      "Subagent runs ASYNC in the background. Results delivered as steering message when done.",
      'Default: --no-extensions (prevents recursive Spawning).',
      'Use crew_list to check status. Use crew_abort to cancel.',
    ].join(" "),
    parameters: SpawnParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const agentScope: AgentScope = params.agentScope ?? "both"; // ⬅️ default "both" agar bundled agents terdeteksi
      const cwd = params.cwd ?? ctx.cwd;

      // Cari via registry dulu (sudah di-refresh di session_start dengan scope "both")
      const registry = getAgentRegistry();
      let agentConfig = registry.get(params.agent);

      // Fallback: discovery langsung jika registry kosong
      if (!agentConfig) {
        agentConfig = findAgent(cwd, agentScope, params.agent);
      }

      if (!agentConfig) {
        registry.refresh(cwd, agentScope);
        const available = registry.getNames().join(", ") || "none";
        return {
          content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${available}.` }],
          details: { agents: available },
          isError: true,
        };
      }

      // Override model if specified
      if (params.model) {
        agentConfig.model = params.model;
      }

      // Override interactive if specified
      if (params.interactive !== undefined) {
        agentConfig.interactive = params.interactive;
      }

      // Spawn async (non-blocking)
      const ownerSession = ctx.sessionManager.getSessionId();
      const handle = spawnSubagentAsync(pi, agentConfig, params.task, signal, cwd, ownerSession);

      // Register with registry and update widget
      registry.registerRunning(handle);
      syncWidgetFromRegistry(pi);

      return {
        content: [
          {
            type: "text",
            text: `Spawned **${params.agent}** (${handle.id}) ✅\nStatus: ${handle.status}\nTask: ${params.task}\n\nYou will be notified via steering message when it completes.`,
          },
        ],
        details: {
          subagentId: handle.id,
          agentName: params.agent,
          status: handle.status,
          task: params.task,
          model: agentConfig.model,
          cwd,
        },
      };
    },

    renderCall(args: any, theme: any) {
      const agentName = args.agent || "...";
      const preview = args.task
        ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task)
        : "...";
      return new Text(`🚀 ${theme.fg("toolTitle", "spawn ")}${theme.fg("accent", agentName)}\n  ${theme.fg("dim", preview)}`, 0, 0);
    },

    renderResult(result: any, { expanded }: any, theme: any) {
      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "(no output)";
      return new Text(text, 0, 0);
    },
  });
}
