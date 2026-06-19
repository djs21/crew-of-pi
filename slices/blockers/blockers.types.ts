/**
 * Blockers types — configurable tool blocking policies.
 */

export interface BlockedToolConfig {
  toolName: string;
  reason: string;
}

export interface BlockPolicyConfig {
  blockedTools: BlockedToolConfig[];
  allowBashReadOnly: boolean;
  customMessage?: string;
}

export const DEFAULT_BLOCKED_TOOLS: BlockedToolConfig[] = [
  { toolName: "write", reason: "Main agent is read-only. Delegate to 'worker' subagent via crew_spawn." },
  { toolName: "edit", reason: "Main agent is read-only. Delegate to 'worker' subagent via crew_spawn." },
];

export const DEFAULT_BLOCK_POLICY: BlockPolicyConfig = {
  blockedTools: DEFAULT_BLOCKED_TOOLS,
  allowBashReadOnly: true,
  customMessage: "Main agent is orchestrator-only. Use crew_spawn to delegate tasks to subagents.",
};

/** Default tools disabled for main agent when no crew-of-pi.json config is set */
export const DEFAULT_MAIN_AGENT_DISABLED_TOOLS = ["write", "edit"];