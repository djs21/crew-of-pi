/**
 * crew_respond tool — send a follow-up message to an interactive subagent.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { getMessageBus } from "../comms/comms.bus";
import { persistMessage } from "../comms/comms.persistence";
import { getAgentRegistry } from "../agents/agents.registry";
import type { LifecycleResult } from "./lifecycle.types";

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

      if (!handle.interactive) {
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

      // Pipe response to subagent stdin
      if (handle.proc && handle.proc.stdin && !handle.proc.stdin.destroyed) {
        handle.proc.stdin.write(JSON.stringify({
          type: "crew_response",
          message: params.message,
          messageId: sentMessage.id,
        }) + "\n");
      }

      return {
        content: [{ type: "text", text: `Response sent to ${handle.agentName} (${params.subagent_id}).` }],
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