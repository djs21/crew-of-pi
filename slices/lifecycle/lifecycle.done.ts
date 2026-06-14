/**
 * crew_done tool — close an interactive subagent session.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { getAgentRegistry } from "../agents/agents.registry";
import type { LifecycleResult } from "./lifecycle.types";

const DoneParams = Type.Object({
  subagent_id: Type.String({ description: "ID of the interactive subagent to close" }),
});

export function registerDoneTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "crew_done",
    label: "Crew Done",
    description: "Close an interactive subagent session when you no longer need it.",
    parameters: DoneParams,
    promptSnippet: "Close an interactive subagent session when no longer needed.",
    promptGuidelines: [
      "crew_done: Close a waiting interactive subagent owned by this session.",
      "crew_done: Use only when no further follow-up is needed; otherwise use crew_respond.",
      "crew_done: The subagent session is disposed and cannot be resumed.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const registry = getAgentRegistry();
      const callerSessionId = ctx.sessionManager.getSessionId();
      const handle = registry.getRunningById(params.subagent_id);

      if (!handle) {
        return {
          content: [{ type: "text", text: `No running subagent found with id: ${params.subagent_id}` }],
          details: { error: "not found" },
          isError: true,
        };
      }

      // Validate session ownership
      if (handle.ownerSession && handle.ownerSession !== callerSessionId) {
        return {
          content: [{ type: "text", text: `Subagent ${params.subagent_id} belongs to a different session.` }],
          details: { error: "foreign session" },
          isError: true,
        };
      }

      // Mark as completed and clean up
      registry.updateRunning(params.subagent_id, { status: "completed" });

      // Persist completion
      pi.appendEntry("crew-subagent-result", {
        id: handle.id,
        agentName: handle.agentName,
        status: "completed",
        completedAt: Date.now(),
        closedBy: "crew_done",
      });

      return {
        content: [{ type: "text", text: `Closed ${handle.agentName} (${params.subagent_id}). Session disposed.` }],
        details: {
          subagentId: params.subagent_id,
          agentName: handle.agentName,
          status: "completed",
        },
      };
    },

    renderCall(args: any, theme: any) {
      return new Text(`🔚 ${theme.fg("toolTitle", `done ${args.subagent_id}`)}`, 0, 0);
    },

    renderResult(result: any, _options: any, theme: any) {
      const content = result.content[0];
      return new Text(`${theme.fg("success", "✓")} ${content?.text ?? "(done)"}`, 0, 0);
    },
  });
}