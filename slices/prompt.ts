/**
 * prompt.ts — Injects crew awareness into the main agent's system prompt.
 * Informs the agent of available subagent roles and best practices for delegation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, PromptInjectionConfig } from "../shared/types";
import { getAgentRegistry } from "./agents";

const DEFAULT_RULES = [
  "Use `crew_spawn` to delegate heavy, focused, or multi-step tasks to specialized subagents.",
  "Use `crew_chain` for sequential workflows where one agent's output feeds the next (e.g. scout -> planner -> worker).",
  "Subagents run asynchronously in the background and report results via steering messages.",
  "Use `crew_list` to check on running subagents, `crew_log` to inspect details, and `crew_abort` to stop tasks if needed.",
];

export const DEFAULT_PROMPT_CONFIG: PromptInjectionConfig = {
  enabled: true,
  preamble: "You have access to a crew of specialized subagents to assist with complex tasks:",
  rules: DEFAULT_RULES,
};

let currentConfig: PromptInjectionConfig = { ...DEFAULT_PROMPT_CONFIG };


function expandSkillName(raw: string): string[] {
  const fileMatch = raw.match(/([^/]+)\/SKILL\.md$/);
  if (fileMatch) return [fileMatch[1]];

  try {
    const stat = fs.statSync(raw);
    if (stat.isDirectory()) {
      const names: string[] = [];
      scanSkillsDir(raw, names);
      return names.sort();
    }
  } catch {
    // ignore missing path
  }

  return [raw];
}

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
      const skillFile = path.join(fullPath, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        acc.push(entry.name);
      } else {
        scanSkillsDir(fullPath, acc);
      }
    }
  }
}

function formatAgentEntry(agent: AgentConfig): string {
  const parts: string[] = [`- **${agent.name}**: ${agent.description}`];
  if (agent.model) parts.push(`model: \`${agent.model}\``);
  if (agent.tools && agent.tools.length > 0) {
    parts.push(`tools: \`${agent.tools.join(", ")}\``);
  } else if (agent.denyTools && agent.denyTools.length > 0) {
    parts.push(`denied tools: \`${agent.denyTools.join(", ")}\``);
  } else {
    parts.push("tools: all");
  }
  if (agent.skills && agent.skills.length > 0) {
    const skillNames = agent.skills.flatMap(expandSkillName);
    parts.push(`skills: \`${skillNames.join(", ")}\``);
  }
  if (agent.interactive) parts.push("interactive: yes (multi-turn)");
  return parts.join(" | ");
}

function buildSystemPromptAddition(agents: AgentConfig[], config: PromptInjectionConfig): string {
  const parts: string[] = [];
  parts.push("## Your Subagent Crew");
  parts.push("");
  parts.push(config.preamble);

  if (agents.length > 0) {
    parts.push("");
    parts.push("### Available Subagents");
    parts.push("");
    for (const agent of agents) {
      parts.push(formatAgentEntry(agent));
    }
  }

  if (config.rules.length > 0) {
    parts.push("");
    parts.push("### Delegation Guidelines");
    parts.push("");
    for (const rule of config.rules) {
      parts.push(`- ${rule}`);
    }
  }

  return parts.join("\n");
}

export function registerPromptInjector(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event: any) => {
    if (!currentConfig.enabled) return;

    const registry = getAgentRegistry();
    const agents = registry.getAll();
    const addition = buildSystemPromptAddition(agents, currentConfig);

    if (event.systemPrompt) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${addition}`,
      };
    }
    return { systemPrompt: addition };
  });
}
