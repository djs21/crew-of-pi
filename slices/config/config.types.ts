/**
 * Config types — shared interfaces and constants for config slice.
 */

export interface AgentOverride {
  model?: string;
  extensions?: string[];
  skills?: string[];
  [key: string]: unknown;
}

export interface MainAgentConfig {
  /** Tools explicitly disabled for main agent. Default: ["write", "edit"] */
  disabledTools?: string[];
}

export interface CrewConfig {
  mainAgent?: MainAgentConfig;
  agents?: Record<string, AgentOverride>;
}

export interface ExtensionOption {
  label: string;
  value: string;
  type: "pi-package" | "path";
}

export interface SkillOption {
  label: string;
  value: string;
}

/** All main-agent tools that can be toggled */
export const ALL_MAIN_AGENT_TOOLS = ["read", "bash", "grep", "find", "ls", "write", "edit"];

/** Default disabled tools if no config is set */
export const DEFAULT_DISABLED_TOOLS = ["write", "edit"];

/** Label used in agent picker for main-agent tool policy */
export const MAIN_AGENT_KEY = "🤖 Main Agent (tool policy)";
