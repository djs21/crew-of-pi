/**
 * agents.ts — Discovery, live registry, and listing tool for crew-of-pi.
 * Discovers agents from project (.pi/agents/), user (~/.pi/agents/), and bundled locations.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  parseFrontmatter as parseFrontmatterSDK,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  AgentConfig,
  AgentDiscoveryResult,
  AgentDiscoveryWarning,
  AgentExtensionRef,
  AgentScope,
  CrewConfig,
  SubagentHandle,
  SubagentStatusRow,
} from "../shared/types";
import { statusRowToHandle } from "../shared/types";

// ─── Frontmatter & Discovery Parsing ────────────────────────────────

export interface FrontmatterFields {
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
  thinking?: string;
  skills?: string;
  extensions?: string[];
  interactive?: string;
  compaction?: string;
}

const VALID_THINKING_LEVELS = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh",
]);

function warn(filePath: string, message: string): AgentDiscoveryWarning {
  return { filePath, message };
}

function parseModel(raw: unknown): { model?: string; warning?: AgentDiscoveryWarning } {
  if (typeof raw !== "string" || !raw.includes("/")) {
    if (typeof raw === "string" && raw.length > 0) {
      return { warning: warn("", `Invalid model format "${raw}" (expected "provider/model-id"), ignoring`) };
    }
    return {};
  }
  const slashIdx = raw.indexOf("/");
  const provider = raw.slice(0, slashIdx).trim();
  const modelId = raw.slice(slashIdx + 1).trim();
  if (!provider || !modelId) {
    return { warning: warn("", `Invalid model format "${raw}" (expected "provider/model-id"), ignoring`) };
  }
  return { model: raw };
}

function parseThinking(raw: unknown): { thinking?: string; warning?: AgentDiscoveryWarning } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") return {};
  if (!VALID_THINKING_LEVELS.has(raw)) {
    return { warning: warn("", `Unknown thinking level "${raw}", ignoring`) };
  }
  return { thinking: raw };
}

function parseFrontmatter(content: string): { frontmatter: FrontmatterFields; body: string } {
  try {
    const parsed = parseFrontmatterSDK<Record<string, unknown>>(content);
    return {
      frontmatter: parsed.frontmatter as unknown as FrontmatterFields,
      body: parsed.body,
    };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

function resolveExtensionRef(extStr: string, cwd: string, warnings: AgentDiscoveryWarning[]): AgentExtensionRef | null {
  const trimmed = extStr.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("npm:") || trimmed.startsWith("git:")) {
    return { type: "pi-package", value: trimmed };
  }

  let resolvedPath = trimmed;
  if (trimmed.startsWith("~/") || trimmed === "~") {
    resolvedPath = path.join(os.homedir(), trimmed.slice(1));
  } else if (!path.isAbsolute(trimmed)) {
    resolvedPath = path.resolve(cwd, trimmed);
  }

  if (!fs.existsSync(resolvedPath)) {
    warnings.push(warn(trimmed, `Extension path not found: "${trimmed}" (resolved to: "${resolvedPath}")`));
  }

  return { type: "path", value: trimmed, resolved: resolvedPath };
}

function parseAgentDoc(
  content: string,
  filePath: string,
  source: AgentConfig["source"],
  cwd: string,
  warnings: AgentDiscoveryWarning[],
): AgentConfig | null {
  const { frontmatter, body } = parseFrontmatter(content);
  const name = frontmatter.name?.trim() || path.basename(filePath, ".md");
  const description = frontmatter.description?.trim() || "";

  let tools: string[] | undefined;
  if (frontmatter.tools) {
    tools = frontmatter.tools.split(",").map((t) => t.trim()).filter(Boolean);
  }

  const { model, warning: modelWarning } = parseModel(frontmatter.model);
  if (modelWarning) warnings.push({ ...modelWarning, filePath });

  const { thinking, warning: thinkingWarning } = parseThinking(frontmatter.thinking);
  if (thinkingWarning) warnings.push({ ...thinkingWarning, filePath });

  let skills: string[] | undefined;
  if (frontmatter.skills) {
    skills = frontmatter.skills.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const extensions: AgentExtensionRef[] = [];
  if (Array.isArray(frontmatter.extensions)) {
    for (const extStr of frontmatter.extensions) {
      const ref = resolveExtensionRef(extStr, cwd, warnings);
      if (ref) extensions.push(ref);
    }
  }

  const interactive = frontmatter.interactive === "true" || frontmatter.interactive === "yes";
  const compaction = frontmatter.compaction !== "false" && frontmatter.compaction !== "no";

  return {
    name,
    description,
    tools,
    model,
    thinking,
    skills,
    systemPrompt: body.trim(),
    source,
    filePath,
    extensions,
    interactive,
    compaction,
  };
}

function scanDir(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function getBundledAgentsDir(): string {
  return path.resolve(__dirname, "../agents");
}

export function getProjectAgentsDir(cwd: string): string {
  return path.resolve(cwd, ".pi/agents");
}

export function getUserAgentsDir(): string {
  return path.resolve(getAgentDir(), "agents");
}

export function discoverAgents(cwd: string, scope: AgentScope = "both"): AgentDiscoveryResult {
  const warnings: AgentDiscoveryWarning[] = [];
  const agentsByName = new Map<string, AgentConfig>();

  const bundledDir = getBundledAgentsDir();
  for (const file of scanDir(bundledDir)) {
    try {
      const content = fs.readFileSync(file, "utf-8");
      const agent = parseAgentDoc(content, file, "bundled", cwd, warnings);
      if (agent) agentsByName.set(agent.name, agent);
    } catch (err: any) {
      warnings.push(warn(file, `Failed to read bundled agent: ${err.message}`));
    }
  }

  if (scope === "user" || scope === "both") {
    const userDir = getUserAgentsDir();
    for (const file of scanDir(userDir)) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const agent = parseAgentDoc(content, file, "user", cwd, warnings);
        if (agent) agentsByName.set(agent.name, agent);
      } catch (err: any) {
        warnings.push(warn(file, `Failed to read user agent: ${err.message}`));
      }
    }
  }

  const projectDir = getProjectAgentsDir(cwd);
  if (scope === "project" || scope === "both") {
    for (const file of scanDir(projectDir)) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const agent = parseAgentDoc(content, file, "project", cwd, warnings);
        if (agent) agentsByName.set(agent.name, agent);
      } catch (err: any) {
        warnings.push(warn(file, `Failed to read project agent: ${err.message}`));
      }
    }
  }

  return {
    agents: Array.from(agentsByName.values()),
    projectAgentsDir: fs.existsSync(projectDir) ? projectDir : null,
    warnings,
  };
}

export function findAgent(cwd: string, scope: AgentScope, name: string): AgentConfig | undefined {
  const registry = getAgentRegistry();
  const cached = registry.get(name);
  if (cached) return cached;
  const result = discoverAgents(cwd, scope);
  return result.agents.find((a) => a.name === name);
}

export function loadCrewConfig(cwd: string): CrewConfig | null {
  const paths = [
    path.resolve(cwd, ".pi/crew.json"),
    path.resolve(getAgentDir(), "crew.json"),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf-8")) as CrewConfig;
      } catch {
        // ignore parse error
      }
    }
  }
  return null;
}

export function applyConfigOverrides(agents: AgentConfig[], config: CrewConfig): AgentConfig[] {
  if (!config.agents) return agents;
  return agents.map((agent) => {
    const override = config.agents?.[agent.name];
    if (!override) return agent;
    return {
      ...agent,
      model: override.model ?? agent.model,
      thinking: override.thinking ?? agent.thinking,
      skills: override.skills ?? agent.skills,
      extensions: override.extensions ? override.extensions : agent.extensions,
    };
  });
}

// ─── Agent Registry Singleton ──────────────────────────────────────

export class AgentRegistry {
  private agents: AgentConfig[] = [];
  private runningAgents: Map<string, SubagentHandle> = new Map();
  private discoveryWarnings: AgentDiscoveryWarning[] = [];
  private cwd: string = "";
  private scope: AgentScope = "user";
  private _db: any;

  setDb(db: any): void {
    this._db = db;
  }

  async restoreFromDb(): Promise<void> {
    if (!this._db) return;
    const rows = this._db.getActiveStatuses();
    for (const row of rows) {
      const handle = statusRowToHandle(row);
      this.runningAgents.set(handle.id, handle);
    }
  }

  refresh(cwd: string, scope: AgentScope): AgentConfig[] {
    this.cwd = cwd;
    this.scope = scope;
    const result = discoverAgents(cwd, scope);
    this.discoveryWarnings = result.warnings;

    const config = loadCrewConfig(cwd);
    if (config && config.agents && Object.keys(config.agents).length > 0) {
      this.agents = applyConfigOverrides(result.agents, config);
    } else {
      this.agents = result.agents;
    }

    return this.agents;
  }

  getAll(): AgentConfig[] {
    return this.agents;
  }

  get(name: string): AgentConfig | undefined {
    return this.agents.find((a) => a.name === name);
  }

  getNames(): string[] {
    return this.agents.map((a) => a.name);
  }

  registerRunning(handle: SubagentHandle): void {
    this.runningAgents.set(handle.id, handle);
  }

  updateRunning(id: string, updates: Partial<SubagentHandle>): SubagentHandle | undefined {
    const existing = this.runningAgents.get(id);
    if (!existing) return undefined;
    const updated: SubagentHandle = { ...existing, ...updates };
    this.runningAgents.set(id, updated);
    return updated;
  }

  unregisterRunning(id: string): boolean {
    return this.runningAgents.delete(id);
  }

  getRunning(): SubagentHandle[] {
    return Array.from(this.runningAgents.values());
  }

  getRunningById(id: string): SubagentHandle | undefined {
    return this.runningAgents.get(id);
  }

  getWarnings(): AgentDiscoveryWarning[] {
    return this.discoveryWarnings;
  }
}

let _registry: AgentRegistry | null = null;

export function getAgentRegistry(): AgentRegistry {
  if (!_registry) {
    _registry = new AgentRegistry();
  }
  return _registry;
}

export function resetAgentRegistry(): void {
  _registry = null;
}

// ─── crew_list Tool ────────────────────────────────────────────────

export function registerCrewListTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "crew_list",
    label: "Crew List",
    description: "List available subagent definitions and running subagents.",
    parameters: Type.Object({}),
    promptSnippet: "List available subagents and active subagents. Use only for discovery or a requested status snapshot.",
    promptGuidelines: [
      "crew_list: List available subagent definitions and active subagents.",
      "crew_list: Use before crew_spawn to discover names, models, tools, and interactive status.",
      "crew_list: Use only for discovery or a requested status snapshot — do NOT poll for completion.",
      "crew_list: Subagent results arrive automatically as steering messages. Polling wastes turns.",
    ],

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx: ExtensionContext) {
      const registry = getAgentRegistry();
      const available = registry.getAll();
      const running = registry.getRunning();

      let text = "## Available Subagents\n\n";
      if (available.length === 0) {
        text += "None found.\n";
      } else {
        for (const agent of available) {
          text += `- **${agent.name}**: ${agent.description}`;
          text += ` (source: ${agent.source}`;
          if (agent.model) text += `, model: ${agent.model}`;
          if (agent.tools) text += `, tools: ${agent.tools.join(", ")}`;
          if (agent.extensions.length > 0) {
            text += `, extensions: ${agent.extensions.map((e) => e.value).join(", ")}`;
          }
          text += ")\n";
        }
      }

      text += "\n## Running Subagents\n\n";
      if (running.length === 0) {
        text += "None.\n";
      } else {
        for (const h of running) {
          text += `- **${h.agentName}** (${h.id}): ${h.status}`;
          text += `, ${h.turns} turns`;
          if (h.usage.cost > 0) text += `, $${h.usage.cost.toFixed(4)}`;
          text += "\n";
        }
      }

      return {
        content: [{ type: "text", text }],
        details: {
          available: available.map((a) => ({ name: a.name, description: a.description })),
          running: running.map((h) => ({ id: h.id, agent: h.agentName, status: h.status })),
        },
      };
    },
  });
}
