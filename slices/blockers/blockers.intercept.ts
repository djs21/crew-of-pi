/**
 * Tool call interceptor — blocks write/edit tools on the main agent.
 * Main agent is orchestrator-only; all file modifications go through workers.
 */

import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BLOCKED_TOOLS, type BlockPolicyConfig } from "./blockers.types";

let currentPolicy: BlockPolicyConfig | null = null;

/**
 * Set the block policy (configurable at runtime).
 */
export function setBlockPolicy(policy: BlockPolicyConfig): void {
  currentPolicy = policy;
}

/**
 * Get the current block policy.
 */
export function getBlockPolicy(): BlockPolicyConfig {
  return currentPolicy ?? {
    blockedTools: DEFAULT_BLOCKED_TOOLS,
    allowBashReadOnly: true,
  };
}

/**
 * Register the tool_call interceptor that blocks write/edit.
 * Prevents main agent from directly modifying files.
 */
export function registerBlocker(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    const policy = getBlockPolicy();

    // Check if the tool is in the blocked list
    const blocked = policy.blockedTools.find((bt) => bt.toolName === event.toolName);

    if (blocked) {
      return {
        block: true,
        reason: blocked.reason,
      };
    }

    // Optionally block bash commands that modify files
    if (!policy.allowBashReadOnly && isToolCallEventType("bash", event)) {
      const command = event.input.command?.toLowerCase() || "";
      const destructiveCommands = ["rm", "mv", "cp", "dd", "mkfs", "format", "chmod", "chown"];
      const hasDestructive = destructiveCommands.some((cmd) =>
        command.split(" ").includes(cmd),
      );
      if (hasDestructive) {
        return {
          block: true,
          reason: "Destructive bash commands are blocked for main agent. Delegate to 'worker' subagent.",
        };
      }
    }

    // Allow the tool
    return undefined;
  });
}