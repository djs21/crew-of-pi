/**
 * Lifecycle shared — ownership validation and common lifecycle operations.
 * Extracted to eliminate the 4-step pattern duplicated across abort/done/respond.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "../agents/agents.registry";
import type { SubagentHandle } from "../../shared/types";
import { syncWidgetFromRegistry } from "../widget/widget.updater";

// ─── Ownership Validation ───────────────────────────────────────

export interface ValidHandle {
  ok: true;
  handle: SubagentHandle;
}

export interface InvalidHandle {
  ok: false;
  errorResponse: {
    content: { type: string; text: string }[];
    details: { error: string };
    isError: true;
  };
}

export type OwnershipResult = ValidHandle | InvalidHandle;

/**
 * Validate that a subagent exists and is owned by the calling session.
 * Returns a standardized error response if either check fails.
 */
export function validateOwnership(
  subagentId: string,
  registry: AgentRegistry,
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

/**
 * Standard error response for abort tool (all mode — no specific handle).
 */
export function noRunningSubagentsError(): {
  content: { type: string; text: string }[];
  details: { error: string };
  isError: true;
} {
  return {
    content: [{ type: "text", text: "No active subagents in the current session." }],
    details: { error: "none running" },
    isError: true,
  };
}

// ─── Lifecycle Operations ───────────────────────────────────────

/**
 * Mark a subagent as completed, persist the result, and sync the widget.
 * Shared by crew_done and (future) crew_abort.
 */
export function doneSubagent(
  handle: SubagentHandle,
  registry: AgentRegistry,
  pi: ExtensionAPI,
  options?: { closedBy?: string },
): void {
  registry.updateRunning(handle.id, { status: "completed" });

  // Persist to DB
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
