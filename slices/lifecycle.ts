/**
 * lifecycle.ts — Lifecycle tools for crew-of-pi: crew_abort, crew_respond, crew_done.
 * Consolidated from lifecycle.abort.ts, lifecycle.done.ts, lifecycle.respond.ts, lifecycle.shared.ts, lifecycle.types.ts.
 */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { SubagentHandle } from "../shared/types";
import { getAgentRegistry } from "./agents";
import { getMessageBus } from "./db";
import { syncWidgetFromRegistry } from "./widget";

// ─── Ownership & Shared Operations ─────────────────────────────────

export interface ValidHandle {
  ok: true;
  handle: SubagentHandle;
}

export interface InvalidHandle {
  ok: false;
  errorResponse: {
    content: [{ type: "text"; text: string }];
    details: { error: string };
    isError: true;
  };
}

export type OwnershipResult = ValidHandle | InvalidHandle;

export function validateOwnership(
  subagentId: string,
  registry: ReturnType<typeof getAgentRegistry>,
  callerSessionId: string,
): OwnershipResult {
  const handle = registry.getRunningById(subagentId);
  if (!handle) {
    return {
      ok: false,
      errorResponse: {
        content: [{ type: "text", text: `No running subagent found with id: ${subagentId}` }],
        details: { error: "not found" },
        isError: true,
      },
    };
  }

  if (handle.ownerSession && handle.ownerSession !== callerSessionId) {
    return {
      ok: false,
      errorResponse: {
        content: [{ type: "text", text: `Subagent ${subagentId} belongs to a different session.` }],
        details: { error: "foreign session" },
        isError: true,
      },
    };
  }

  return { ok: true, handle };
}

export function doneSubagent(
  handle: SubagentHandle,
  registry: ReturnType<typeof getAgentRegistry>,
  pi: ExtensionAPI,
  options?: { closedBy?: string },
): void {
  registry.updateRunning(handle.id, { status: "completed" });

  const db = (registry as any)._db;
  if (db) {
    db.upsertStatus(handle.id, { status: "completed", completed_at: Date.now(), updated_at: Date.now() });
    db.insertEvent(handle.id, "completed", "completed", handle.turns, handle.usage?.contextTokens ?? 0);
  }

  pi.appendEntry("crew-subagent-result", {
    id: handle.id,
    agentName: handle.agentName,
    status: "completed",
    completedAt: Date.now(),
    closedBy: options?.closedBy ?? "crew_done",
  });

  syncWidgetFromRegistry(pi);
}

function abortSubagent(
  handle: SubagentHandle,
  registry: ReturnType<typeof getAgentRegistry>,
  pi: ExtensionAPI,
): boolean {
  handle.abortController?.abort();
  handle.session?.abortCompaction?.();
  handle.session?.abort().catch(() => {});
  handle.session?.dispose();

  registry.updateRunning(handle.id, { status: "aborted" });

  const db = (registry as any)._db;
  if (db) {
    db.upsertStatus(handle.id, { status: "aborted", updated_at: Date.now() });
    db.insertEvent(handle.id, "aborted", "aborted", handle.turns, handle.usage?.contextTokens ?? 0);
  }

  pi.appendEntry("crew-subagent-result", {
    id: handle.id,
    agentName: handle.agentName,
    status: "aborted",
    abortedAt: Date.now(),
  });

  syncWidgetFromRegistry(pi);
  return true;
}

// ─── crew_abort Tool ───────────────────────────────────────────────

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
      "crew_abort: Provide exactly one mode: subagent_id or all=true.",
      "crew_abort: Use only when delegated work is obsolete, wrong, or explicitly cancelled.",
      "crew_abort: Aborted subagents cannot be resumed.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const registry = getAgentRegistry();
      const callerSessionId = ctx.sessionManager.getSessionId();
      const results: { success: boolean; subagentId: string; status: string; message: string }[] = [];

      if (params.all) {
        const running = registry.getRunning();
        for (const handle of running) {
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
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No active subagents in the current session." }],
            details: { error: "none running" },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Aborted ${results.length} subagent(s).` }],
          details: { results, count: results.length },
        };
      }

      if (params.subagent_id) {
        const owned = validateOwnership(params.subagent_id, registry, callerSessionId);
        if (!owned.ok) return owned.errorResponse;
        abortSubagent(owned.handle, registry, pi);
        return {
          content: [{ type: "text", text: `Aborted ${owned.handle.agentName} (${params.subagent_id}).` }],
          details: { subagentId: params.subagent_id, status: "aborted" },
        };
      }

      return {
        content: [{ type: "text", text: "Must provide subagent_id or all: true." }],
        details: { error: "missing parameter" },
        isError: true,
      };
    },

    renderCall(args: any, theme: any) {
      const target = args.all ? "all running" : (args.subagent_id ?? "");
      return new Text(`🛑 ${theme.fg("toolTitle", `abort ${target}`)}`, 0, 0);
    },

    renderResult(result: any, _options: any, theme: any) {
      const content = result.content[0];
      return new Text(`${theme.fg("warning", "■")} ${content?.text ?? "(aborted)"}`, 0, 0);
    },
  });
}

// ─── crew_respond Tool ─────────────────────────────────────────────

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

      const bus = getMessageBus();
      const sentMessage = bus.send("main", params.subagent_id, "response", params.message);

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
      const preview = args.message?.length > 60 ? `${args.message.slice(0, 60)}...` : args.message ?? "...";
      return new Text(`💬 ${theme.fg("accent", `respond to ${args.subagent_id}`)}\n  ${theme.fg("dim", preview)}`, 0, 0);
    },

    renderResult(result: any, _options: any, theme: any) {
      const content = result.content[0];
      const text = content?.type === "text" ? `${theme.fg("success", "✓")} ${content.text}` : "(no output)";
      return new Text(text, 0, 0);
    },
  });
}

// ─── crew_done Tool ────────────────────────────────────────────────

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
      const owned = validateOwnership(params.subagent_id, registry, callerSessionId);

      if (!owned.ok) return owned.errorResponse;

      doneSubagent(owned.handle, registry, pi, { closedBy: "crew_done" });

      return {
        content: [{ type: "text", text: `Closed ${owned.handle.agentName} (${params.subagent_id}). Session disposed.` }],
        details: {
          subagentId: params.subagent_id,
          agentName: owned.handle.agentName,
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
