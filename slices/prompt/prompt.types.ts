/**
 * Prompt types — system prompt injection configuration.
 */

import type { AgentConfig } from "../../shared/types";

export interface PromptInjectionConfig {
  enabled: boolean;
  includeAgentDescriptions: boolean;
  includeAgentExtensions: boolean;
  /** Include subagent skills in agent listing so main agent knows what tools each subagent has */
  includeAgentSkills: boolean;
  includeRules: boolean;
  customPreamble?: string;
  customRules?: string[];
}

export const DEFAULT_PROMPT_CONFIG: PromptInjectionConfig = {
  enabled: true,
  includeAgentDescriptions: true,
  includeAgentExtensions: true,
  includeAgentSkills: true,
  includeRules: true,
};

export const DEFAULT_RULES: string[] = [
  "You CAN read, grep, find, ls, and bash (read-only) to understand the codebase.",
  "You CANNOT write, edit, or modify files. Delegate to 'worker' subagent instead.",
  "For codebase investigation, delegate to 'scout' (fast, cheap model).",
  "For deep research/analysis, delegate to 'researcher'.",
  "For implementation planning, delegate to 'planner'.",
  "For code review after changes, delegate to 'reviewer'.",
  "For implementation, delegate to 'worker' (has write/edit capabilities).",
  "Subagents run ASYNC in the background. You will be notified when they finish.",
  "Use crew_spawn to spawn a subagent.",
  "Use crew_list to check running subagent status.",
  "Use crew_abort to cancel a running subagent.",
  "Use crew_chain for sequential multi-agent workflows.",
  "Each subagent has specific skills listed in their entry. Delegate tasks that match those skills (e.g., researcher has Tavily web search, 9Router web search/fetch, and library docs lookup — do NOT tell researcher to use curl for web searches).",
];