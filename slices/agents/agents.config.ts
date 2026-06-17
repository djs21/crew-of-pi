/**
 * Agent config loader — loads crew-of-pi.json (global + project)
 * and merges overrides into agent definitions.
 *
 * Config file locations (project overrides global):
 *   Global:  ~/.pi/agent/crew-of-pi.json
 *   Project: <cwd>/.pi/crew-of-pi.json
 *
 * Config format:
 *   {
 *     "agents": {
 *       "<agent-name>": {
 *         "model": "provider/model-name",
 *         "tools": ["read", "grep", ...],
 *         "extensions": ["npm:@scope/name", "./relative/path", ...],
 *         "thinking": "high|medium|low"
 *       }
 *     }
 *   }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../../shared/types";
import { resolveExtensions } from "./agents.discovery";

// ─── Types ──────────────────────────────────────────────────────

interface AgentOverride {
  model?: string;
  tools?: string[];
  extensions?: string[];
  thinking?: string;
  [key: string]: any; // allow arbitrary frontmatter overrides
}

interface CrewConfig {
  agents: Record<string, AgentOverride>;
}

// ─── Config Loading ─────────────────────────────────────────────

/**
 * Load config from a file path. Returns null if file doesn't exist
 * or can't be parsed as valid JSON.
 */
function loadConfigFile(filePath: string): CrewConfig | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as CrewConfig;

    // Validate structure — must have an "agents" object
    if (!parsed || typeof parsed !== "object" || typeof parsed.agents !== "object") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load crew-of-pi config from both global and project locations.
 * Project-level config overrides global config.
 * Returns merged config or null if no config files found.
 */
export function loadCrewConfig(cwd: string): CrewConfig | null {
  const globalPath = path.join(os.homedir(), ".pi", "agent", "crew-of-pi.json");
  const projectPath = path.join(cwd, ".pi", "crew-of-pi.json");

  const globalConfig = loadConfigFile(globalPath);
  const projectConfig = loadConfigFile(projectPath);

  if (!globalConfig && !projectConfig) return null;

  // Merge: project overrides global (shallow merge per agent)
  return {
    agents: {
      ...(globalConfig?.agents ?? {}),
      ...(projectConfig?.agents ?? {}),
    },
  };
}

// ─── Override Application ───────────────────────────────────────

/**
 * Apply config overrides to agent definitions.
 * Returns a new array with overrides applied (does not mutate original).
 *
 * Supported override fields:
 *   - model: override the model string
 *   - tools: override the tools array
 *   - extensions: override extensions (resolved relative to agent .md directory)
 *   - thinking: override thinking mode
 *   - skills: override skills (skill names/paths)
 *
 * Extensions from config are resolved using the agent's filePath directory,
 * the same way frontmatter extensions are resolved.
 */
export function applyConfigOverrides(
  agents: AgentConfig[],
  config: CrewConfig,
): AgentConfig[] {
  if (!config.agents || Object.keys(config.agents).length === 0) {
    return agents;
  }

  return agents.map((agent) => {
    const overrides = config.agents[agent.name];
    if (!overrides) return agent;

    const updated = { ...agent };

    if (overrides.model !== undefined) {
      updated.model = overrides.model;
    }

    if (overrides.tools !== undefined) {
      updated.tools = overrides.tools;
    }

    if (overrides.thinking !== undefined) {
      updated.thinking = overrides.thinking;
    }

    if (overrides.extensions !== undefined) {
      // Resolve extensions using the agent's own directory
      // Defensive: wrap single string into array (user may pass string instead of array)
      const agentDir = path.dirname(agent.filePath);
      const rawExtensions = Array.isArray(overrides.extensions)
        ? overrides.extensions
        : [String(overrides.extensions)];
      updated.extensions = resolveExtensions(rawExtensions, agentDir);
    }

    if (overrides.skills !== undefined) {
      // Skills are plain skill names/paths (not extension refs)
      // Defensive: wrap single string into array
      updated.skills = Array.isArray(overrides.skills)
        ? overrides.skills.map(String)
        : [String(overrides.skills)];
    }

    return updated;
  });
}