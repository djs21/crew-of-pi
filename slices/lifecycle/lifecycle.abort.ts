/**
 * crew_abort tool — abort one, many, or all running subagents.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { abortSubagentProcess } from "../spawn/spawn.manager";
import { getAgentRegistry } from "../agents/agents.registry";
import type { LifecycleResult } from "./lifecycle.types";

const AbortParams = Type.Object({
  subagent_id: Type.Optional(Type.String({ description: "ID of specific subagent to abort" })),
  all: Type.Optional(Type.Boolean({ description: "Abort all running subagents in current session" })),
});

export function registerAbortTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "crew_abort",
    label: "Crew Abort",
    description: "Abort one or all running subagents. Provide subagent_id for specific, or all: true for all.",
    parameters: AbortParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const registry = getAgentRegistry();
      const callerSessionId = ctx.sessionManager.getSessionId();
      const results: LifecycleResult[] = [];

      if (params.all) {
        // Abort all running SUBAGENTS OWNED BY THIS SESSION
        const running = registry.getRunning();
        for (const handle of running) {
          // Skip agents owned by other sessions
          if (handle.ownerSession && handle.ownerSession !== callerSessionId) continue;

          const success = handle.pid ? abortSubagentProcess(handle.pid) : false;
          registry.updateRunning(handle.id, { status: "aborted" });
          results.push({
            success,
            subagentId: handle.id,
            status: "aborted",
            message: `Aborted ${handle.agentName} (${handle.id})`,
          });
          pi.appendEntry("crew-subagent-result", {
            id: handle.id,
            agentName: handle.agentName,
            status: "aborted",
            abortedAt: Date.now(),
          });
        }

        return {
          content: [{ type: "text", text: `Aborted ${results.length} running subagent(s) in this session.` }],
          details: { results, count: results.length },
        };
      }

      if (params.subagent_id) {
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
            content: [{ type: "text", text: `Subagent ${params.subagent_id} belongs to a different session and cannot be aborted from here.` }],
            details: { error: "foreign session" },
            isError: true,
          };
        }

        const success = handle.pid ? abortSubagentProcess(handle.pid) : false;
        registry.updateRunning(params.subagent_id, { status: "aborted" });

        pi.appendEntry("crew-subagent-result", {
          id: handle.id,
          agentName: handle.agentName,
          status: "aborted",
          abortedAt: Date.now(),
        });

        return {
          content: [{ type: "text", text: `Aborted ${handle.agentName} (${handle.id}).` }],
          details: { subagentId: handle.id, status: "aborted" },
        };
      }

      return {
        content: [{ type: "text", text: "Specify subagent_id or all: true to abort." }],
        details: {},
        isError: true,
      };
    },

    renderCall(args: any, theme: any) {
      if (args.all) {
        return new Text(`⛔ ${theme.fg("error", "abort all")}`, 0, 0);
      }
      return new Text(`⛔ ${theme.fg("error", `abort ${args.subagent_id ?? "?"}`)}`, 0, 0);
    },

    renderResult(result: any, _options: any, theme: any) {
      const content = result.content[0];
      const text = content?.text ?? "";
      const isError = text.includes("not found");
      return new Text(
        isError
          ? `${theme.fg("error", "✗")} ${text}`
          : `${theme.fg("warning", "⛔")} ${text}`,
        0, 0,
      );
    },
  });
}