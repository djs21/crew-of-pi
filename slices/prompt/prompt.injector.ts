/**
 * System prompt injector — injects agent list + delegation instructions
 * into the main agent's system prompt via before_agent_start event.
 * Main agent is made aware of its crew and knows to delegate.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../shared/types";
import { getAgentRegistry } from "../agents/agents.registry";
import { DEFAULT_RULES, type PromptInjectionConfig, DEFAULT_PROMPT_CONFIG } from "./prompt.types";

let currentConfig: PromptInjectionConfig = { ...DEFAULT_PROMPT_CONFIG };

/**
 * Update the prompt injection configuration at runtime.
 */
export function setPromptConfig(config: Partial<PromptInjectionConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

/**
 * Format agent entry for system prompt.
 */
function formatAgentEntry(agent: AgentConfig): string {
  const parts: string[] = [`- **${agent.name}**: ${agent.description}`];

  if (agent.model) {
    parts.push(`model: \`${agent.model}\``);
  }
  if (agent.tools && agent.tools.length > 0) {
    parts.push(`tools: \`${agent.tools.join(", ")}\``);
  }
  if (agent.interactive) {
    parts.push("interactive: yes (multi-turn)");
  }

  return parts.join(" | ");
}

/**
 * Build the system prompt addition with agent awareness.
 */
function buildSystemPromptAddition(
  agents: AgentConfig[],
  config: PromptInjectionConfig,
): string {
  const parts: string[] = [];

  // Header
  parts.push("## Your Subagent Crew");
  parts.push("");
  parts.push("You are a MAIN ORCHESTRATOR agent. You coordinate specialized subagents to complete tasks efficiently. You do NOT write or edit files directly.");

  // Agent list
  if (config.includeAgentDescriptions && agents.length > 0) {
    parts.push("");
    parts.push("### Available Subagents");
    parts.push("");
    for (const agent of agents) {
      parts.push(formatAgentEntry(agent));

      // Include extension info if available
      if (config.includeAgentExtensions && agent.extensions.length > 0) {
        const extNames = agent.extensions.map((e) => e.value).join(", ");
        parts.push(`  Extensions: \`${extNames}\``);
      }
    }
  }

  // Rules
  if (config.includeRules) {
    parts.push("");
    parts.push("### Delegation Rules");
    for (const rule of DEFAULT_RULES) {
      parts.push(rule);
    }
  }

  // Custom preamble
  if (config.customPreamble) {
    parts.push("");
    parts.push(config.customPreamble);
  }

  // Custom rules
  if (config.customRules && config.customRules.length > 0) {
    parts.push("");
    parts.push("### Custom Instructions");
    for (const rule of config.customRules) {
      parts.push(`- ${rule}`);
    }
  }

  return parts.join("\n");
}

/**
 * Register the before_agent_start handler.
 */
export function registerPromptInjector(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    if (!currentConfig.enabled) return;

    // Discover agents
    const registry = getAgentRegistry();
    const agents = registry.getAll();

    if (agents.length === 0) return; // No agents to inject

    const addition = buildSystemPromptAddition(agents, currentConfig);

    return {
      systemPrompt: event.systemPrompt + "\n\n" + addition,
    };
  });
}