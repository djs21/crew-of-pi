/**
 * crew_abort tool — abort one, many, or all running subagents.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { getAgentRegistry } from "../agents/agents.registry";
import { syncWidgetFromRegistry } from "../widget/widget.updater";
import { validateOwnership } from "./lifecycle.shared";
import type { LifecycleResult } from "./lifecycle.types";
import type { SubagentHandle } from "../../shared/types";

/**
 * Centralized abort logic:
 * 1. Call abortController.abort() first — works even before session exists
 * 2. Call session.abort() — works if session already exists
 * 3. Dispose session to free resources
 * 4. Persist result entry
 */
function abortSubagent(
  handle: SubagentHandle,
  registry: ReturnType<typeof getAgentRegistry>,
  pi: ExtensionAPI,
): boolean {
  // Fire dedicated AbortController (works even before session creation)
  handle.abortController?.abort();

  // Also abort session directly (covers case where session exists but
  // abortController signal listener hasn't fired yet)
  handle.session?.abortCompaction?.();
  handle.session?.abort().catch(() => {});

  // Dispose session to free resources
  handle.session?.dispose();

  // Set registry status
  registry.updateRunning(handle.id, { status: "aborted" });

  // Persist result
  pi.appendEntry("crew-subagent-result", {
    id: handle.id,
    agentName: handle.agentName,
    status: "aborted",
    abortedAt: Date.now(),
  });

  // Sync widget so abort is reflected immediately in the UI
  syncWidgetFromRegistry(pi);

  return true;
}

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
    promptSnippet: "Abort one, many, or all active subagents in this session.",
    promptGuidelines: [
      "crew_abort: Abort one, many, or all active subagents owned by this session.",
      "crew_abort: Provide exactly one mode: subagent_id, subagent_ids, or all=true.",
      "crew_abort: Use only when delegated work is obsolete, wrong, or explicitly cancelled.",
      "crew_abort: Aborted subagents cannot be resumed.",
    ],

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

          if (abortSubagent(handle, registry, pi)) {
            results.push({
              success: true,
              subagentId: handle.id,
              status: "aborted",
              message: `Aborted ${handle.agentName} (${handle.id})`,
            });
          }
        }

        return {
          content: [{ type: "text", text: `Aborted ${results.length} running subagent(s) in this session.` }],
          details: { results, count: results.length },
        };
      }

      if (params.subagent_id) {
        const owned = validateOwnership(params.subagent_id, registry, callerSessionId);
        if (!owned.ok) return owned.errorResponse;

        abortSubagent(owned.handle, registry, pi);

        return {
          content: [{ type: "text", text: `Aborted ${owned.handle.agentName} (${owned.handle.id}).` }],
          details: { subagentId: owned.handle.id, status: "aborted" },
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