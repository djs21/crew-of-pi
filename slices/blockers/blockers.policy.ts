/**
 * Block policies — configurable policies for which tools to block.
 * Can be configured at runtime or via agent overrides.
 */

import { DEFAULT_BLOCK_POLICY, type BlockPolicyConfig, type BlockedToolConfig } from "./blockers.types";

/**
 * Create a custom block policy.
 */
export function createBlockPolicy(overrides?: Partial<BlockPolicyConfig>): BlockPolicyConfig {
  return {
    ...DEFAULT_BLOCK_POLICY,
    ...overrides,
    blockedTools: overrides?.blockedTools ?? DEFAULT_BLOCK_POLICY.blockedTools,
  };
}

/**
 * Add a tool to the block list dynamically.
 */
export function addBlockedTool(
  policy: BlockPolicyConfig,
  toolName: string,
  reason: string,
): BlockPolicyConfig {
  const exists = policy.blockedTools.find((bt) => bt.toolName === toolName);
  if (exists) {
    exists.reason = reason;
  } else {
    policy.blockedTools.push({ toolName, reason });
  }
  return { ...policy };
}

/**
 * Remove a tool from the block list.
 */
export function removeBlockedTool(
  policy: BlockPolicyConfig,
  toolName: string,
): BlockPolicyConfig {
  return {
    ...policy,
    blockedTools: policy.blockedTools.filter((bt) => bt.toolName !== toolName),
  };
}

/**
 * Get default blocked tools list as formatted string.
 */
export function getBlockedToolsDescription(): string {
  return DEFAULT_BLOCK_POLICY.blockedTools
    .map((bt: BlockedToolConfig) => `- \`${bt.toolName}\`: ${bt.reason}`)
    .join("\n");
}