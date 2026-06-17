/**
 * System prompt injector — injects agent list + delegation instructions
 * into the main agent's system prompt via before_agent_start event.
 * Main agent is made aware of its crew and knows to delegate.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
 * Expand skill path (file or directory) into skill names.
 * - `.../tavily-search/SKILL.md` → `tavily-search`
 * - `/path/to/skills/` → scan subdirs for SKILL.md → `tavily-search, find-docs, ...`
 * - Path gak dikenal → raw path string
 */
function expandSkillName(raw: string): string[] {
  // File path: .../tavily-search/SKILL.md
  const fileMatch = raw.match(/([^/]+)\/SKILL\.md$/);
  if (fileMatch) return [fileMatch[1]];

  // Cek apakah directory
  try {
    const stat = fs.statSync(raw);
    if (stat.isDirectory()) {
      const names: string[] = [];
      scanSkillsDir(raw, names);
      return names.sort();
    }
  } catch {
    // path gak exist atau gak bisa dibaca
  }

  // Fallback: raw path
  return [raw];
}

/** Recursive scan folder for SKILL.md files, collect directory names */
function scanSkillsDir(dir: string, acc: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Cek apakah folder ini punya SKILL.md
      const skillFile = path.join(fullPath, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        acc.push(entry.name); // skill name = dir name
      } else {
        scanSkillsDir(fullPath, acc); // nested
      }
    }
  }
}

/**
 * Format agent entry for system prompt.
 */
function formatAgentEntry(agent: AgentConfig, config: PromptInjectionConfig): string {
  const parts: string[] = [`- **${agent.name}**: ${agent.description}`];

  if (agent.model) {
    parts.push(`model: \`${agent.model}\``);
  }
  if (agent.tools && agent.tools.length > 0) {
    parts.push(`tools: \`${agent.tools.join(", ")}\``);
  }
  if (config.includeAgentSkills && agent.skills && agent.skills.length > 0) {
    // Expand mixed file+dir paths into flat skill name list
    const skillNames = agent.skills.flatMap(expandSkillName);
    parts.push(`skills: \`${skillNames.join(", ")}\``);
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
      parts.push(formatAgentEntry(agent, config));

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