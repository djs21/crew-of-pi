/**
 * crew_log and crew_inject tools — monitor and steer subagents mid-run.
 *
 * crew_log: Read real-time transcript from a running subagent.
 * crew_inject: Interrupt and correct a subagent mid-turn via session.steer().
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { getAgentRegistry } from "../agents/agents.registry";
import { validateOwnership } from "../lifecycle/lifecycle.shared";

// ─── crew_log — Read subagent transcript ────────────────────────

const LogParams = Type.Object({
  subagent_id: Type.String({ description: "ID of the subagent to inspect" }),
  limit: Type.Optional(Type.Number({ description: "Number of latest transcript entries to show (default 10)", default: 10 })),
});

export function registerLogTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "crew_log",
    label: "Crew Log",
    description: "Read the latest transcript entries from a running subagent — shows thinking, text output, and tool results in real-time.",
    parameters: LogParams,
    promptSnippet: "Read real-time transcript output from a running subagent.",
    promptGuidelines: [
      "crew_log: Read transcript from a running subagent to see its thinking, text output, and tool results.",
      "crew_log: Use when a subagent is taking too long or you suspect it's going in the wrong direction.",
      "crew_log: Does NOT wait for the subagent to finish — shows whatever events have been captured so far.",
      "crew_log: After reading the log, use crew_inject to correct course if needed.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const registry = getAgentRegistry();
      const callerSessionId = ctx.sessionManager.getSessionId();
      const owned = validateOwnership(params.subagent_id, registry, callerSessionId);
      if (!owned.ok) return owned.errorResponse;

      const transcript = owned.handle._transcript ?? [];
      const limit = Math.min(params.limit ?? 10, transcript.length);
      const entries = transcript.slice(-limit);

      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: `**${owned.handle.agentName}** (${owned.handle.id}) belum memulai aktivitas — transcript kosong.` }],
          details: { subagentId: params.subagent_id, entries: 0 },
        };
      }

      const lines: string[] = [
        `=== ${owned.handle.agentName} (${owned.handle.id}) ===`,
        `Status: ${owned.handle.status} · ${owned.handle.turns} turn(s)`,
        `Transcript: ${transcript.length} total entries, showing last ${limit}`,
        "",
      ];
      for (const entry of entries) {
        const prefix = entry.toolName ? `[${entry.type}: ${entry.toolName}]` : `[${entry.type}]`;
        const content = entry.content.length > 200
          ? entry.content.slice(0, 200) + "…"
          : entry.content;
        lines.push(`${prefix} ${content}`);
        if (entry.isError) lines.push("  ⚠️ Error");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { subagentId: params.subagent_id, totalEntries: transcript.length, shown: limit },
      };
    },

    renderCall(args: any, theme: any) {
      return new Text(`📋 ${theme.fg("toolTitle", `log ${args.subagent_id}`)}`, 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const text = result.content[0]?.text ?? "(empty)";
      return new Text(text, 0, 0);
    },
  });
}

// ─── crew_inject — Steer subagent mid-turn ──────────────────────

const InjectParams = Type.Object({
  subagent_id: Type.String({ description: "ID of the subagent to steer/interrupt" }),
  message: Type.String({ description: "Steering instruction to inject mid-turn" }),
});

export function registerInjectTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "crew_inject",
    label: "Crew Inject",
    description: "Inject a steering message into a running subagent mid-turn — corrects course without waiting for the current response to finish.",
    parameters: InjectParams,
    promptSnippet: "Interrupt and redirect a running subagent mid-turn.",
    promptGuidelines: [
      "crew_inject: Send a course-correction to a subagent that is currently generating or running tools.",
      "crew_inject: Use AFTER reading the transcript with crew_log — target the specific wrong direction.",
      "crew_inject: The subagent receives the steer message after its current tool finishes executing.",
      "crew_inject: Unlike crew_respond (for interactive agents), this works on any subagent mid-stream.",
      "crew_inject: Message should be concise, specific, and directive: what to change, what to focus on.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const registry = getAgentRegistry();
      const callerSessionId = ctx.sessionManager.getSessionId();
      const owned = validateOwnership(params.subagent_id, registry, callerSessionId);
      if (!owned.ok) return owned.errorResponse;

      if (!owned.handle.session) {
        return {
          content: [{ type: "text", text: `Subagent ${owned.handle.agentName} (${params.subagent_id}) has no active session — cannot inject.` }],
          details: { error: "no session" },
          isError: true,
        };
      }

      if (owned.handle.status !== "running" && owned.handle.status !== "spawned") {
        return {
          content: [{ type: "text", text: `Subagent ${owned.handle.agentName} (${params.subagent_id}) is ${owned.handle.status} — can only steer running/spawned agents.` }],
          details: { error: "wrong status" },
          isError: true,
        };
      }

      try {
        await owned.handle.session.steer(params.message);
        // Log the steering message into transcript for audit trail
        if (owned.handle._transcript) {
          owned.handle._transcript.push({
            type: "text",
            content: `🧭 [STEER from Orc] ${params.message}`,
            timestamp: Date.now(),
          } as any);
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to steer ${owned.handle.agentName} (${params.subagent_id}): ${err.message}` }],
          details: { error: err.message },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: `🧭 Steer message sent to **${owned.handle.agentName}** (${params.subagent_id}).\n\nMessage: "${params.message}"` }],
        details: {
          subagentId: params.subagent_id,
          message: params.message,
        },
      };
    },

    renderCall(args: any, theme: any) {
      const preview = args.message?.length > 60
        ? `${args.message.slice(0, 60)}…`
        : args.message ?? "";
      return new Text(`🧭 ${theme.fg("toolTitle", `inject ${args.subagent_id}`)}\n  ${theme.fg("dim", preview)}`, 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const text = result.content[0]?.text ?? "";
      return new Text(`${theme.fg("success", "🧭")} ${text}`, 0, 0);
    },
  });
}
