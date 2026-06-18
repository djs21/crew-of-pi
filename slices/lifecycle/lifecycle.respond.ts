/**
 * crew_respond tool — send a follow-up message to an interactive subagent.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { getMessageBus, persistMessage } from "../comms/comms";
import { getAgentRegistry } from "../agents/agents.registry";
import { validateOwnership } from "./lifecycle.shared";

const RespondParams = Type.Object({
  subagent_id: Type.String({ description: "ID of the interactive subagent to respond to" }),
  message: Type.String({ description: "Message content to send" }),
});

export function registerRespondTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "crew_respond",
    label: "Crew Respond",
    description: "Send a follow-up message to an interactive subagent that is waiting for a response.",
    parameters: RespondParams,
    promptSnippet: "Send a follow-up message to a waiting interactive subagent.",
    promptGuidelines: [
      "crew_respond: Send a complete follow-up message to a waiting interactive subagent.",
      "crew_respond: Use the waiting subagent ID from crew_spawn results or crew_list.",
      "crew_respond: The subagent's response arrives as a steering message — do NOT poll.",
      "crew_respond: Only works for subagents spawned with interactive: true.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const registry = getAgentRegistry();
      const callerSessionId = ctx.sessionManager.getSessionId();
      const owned = validateOwnership(params.subagent_id, registry, callerSessionId);

      if (!owned.ok) return owned.errorResponse;

      if (!owned.handle.interactive) {
        return {
          content: [{ type: "text", text: `Subagent ${params.subagent_id} is not interactive. Spawn with interactive: true for multi-turn.` }],
          details: { error: "not interactive" },
          isError: true,
        };
      }

      // Send message via bus
      const bus = getMessageBus();
      const sentMessage = bus.send(
        "main",
        params.subagent_id,
        "response",
        params.message,
      );

      // Persist to session
      persistMessage(pi, sentMessage);

      // Send response to subagent session (fire-and-forget prompt)
      if (owned.handle.session) {
        owned.handle.session.prompt(params.message).catch(() => {});
      }

      return {
        content: [{ type: "text", text: `Response sent to ${owned.handle.agentName} (${params.subagent_id}).` }],
        details: {
          subagentId: params.subagent_id,
          messageId: sentMessage.id,
          message: params.message,
        },
      };
    },

    renderCall(args: any, theme: any) {
      const preview = args.message?.length > 60
        ? `${args.message.slice(0, 60)}...`
        : args.message ?? "...";
      return new Text(`💬 ${theme.fg("accent", `respond to ${args.subagent_id}`)}\n  ${theme.fg("dim", preview)}`, 0, 0);
    },

    renderResult(result: any, _options: any, theme: any) {
      const content = result.content[0];
      const text = content?.type === "text"
        ? `${theme.fg("success", "✓")} ${content.text}`
        : "(no output)";
      return new Text(text, 0, 0);
    },
  });
}
