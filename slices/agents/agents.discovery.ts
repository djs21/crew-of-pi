/**
 * Agent discovery — discovers agents from user, project, and bundled locations.
 * Extension resolver: supports path-based (absolute/relative/~) and pi-package (npm:/git:).
 *
 * This file is the consolidated agent discovery pipeline:
 *   .md file → frontmatter parsing → extension resolution → config overrides → cache
 *
 * Separated into: agents.registry.ts (query interface over discovery cache).
 * Deleted (was pass-through): agents.config.ts, agents.frontmatter.ts, agents.types.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getAgentDir,
  parseFrontmatter as parseFrontmatterSDK,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentDiscoveryResult, AgentDiscoveryWarning, AgentExtensionRef, AgentScope } from "../../shared/types";

// ─── Slice Types (was agents.types.ts) ──────────────────────────

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

interface ParsedAgentDoc {
  frontmatter: FrontmatterFields;
  body: string;
  filePath: string;
  source: AgentConfig["source"];
}

// ─── Config Override Types (was agents.config.ts) ───────────────

interface AgentOverride {
  model?: string;
  tools?: string[];
  extensions?: string[];
  skills?: string[];
  thinking?: string;
  [key: string]: any;
}

export interface MainAgentConfig {
  /** Tools explicitly disabled for main agent. Default: ["write", "edit"] */
  disabledTools?: string[];
}

interface CrewConfig {
  /** Main agent tool policy */
  mainAgent?: MainAgentConfig;
  agents: Record<string, AgentOverride>;
}

// ─── Validation ─────────────────────────────────────────────────

const VALID_THINKING_LEVELS = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh",
]);

function warn(filePath: string, message: string): AgentDiscoveryWarning {
  return { filePath, message };
}

/**
 * Validate model string format: must be "provider/model-id" with exactly one slash.
 */
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

/**
 * Validate thinking level.
 */
function parseThinking(raw: unknown): { thinking?: string; warning?: AgentDiscoveryWarning } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") return {};
  if (!VALID_THINKING_LEVELS.has(raw)) {
    return { warning: warn("", `Unknown thinking level "${raw}", ignoring`) };
  }
  return { thinking: raw };
}

// ─── YAML Frontmatter Parser (was agents.frontmatter.ts) ────────

/**
 * Parse frontmatter from a markdown string using the pi SDK parser.
 */
function parseFrontmatter(content: string): {
  frontmatter: FrontmatterFields;
  body: string;
} {
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

/**
 * Validate parsed frontmatter has required fields.
 */
export function validateAgentFrontmatter(
  frontmatter: FrontmatterFields,
  filePath: string,
): string[] {
  const errors: string[] = [];

  if (!frontmatter.name) {
    errors.push(`Agent at ${filePath} missing required field: name`);
  } else if (!/^[\w.-]+$/.test(frontmatter.name)) {
    errors.push(`Agent '${frontmatter.name}': name must contain only word chars, dots, and hyphens`);
  }

  if (!frontmatter.description) {
    errors.push(`Agent '${frontmatter.name ?? "?"}' missing required field: description`);
  }

  return errors;
}

// ─── Config Loader (was agents.config.ts) ───────────────────────

/**
 * Load config from a file path. Returns null if file doesn't exist
 * or can't be parsed as valid JSON.
 */
function loadConfigFile(filePath: string): CrewConfig | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as CrewConfig;

    // Validate structure — must have an "agents" object
    if (!parsed || typeof parsed !== "object") {
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

  // Merge: project overrides global
  const mergedAgents = {
    ...(globalConfig?.agents ?? {}),
    ...(projectConfig?.agents ?? {}),
  };

  // Merge mainAgent: project overrides global (full replace per field)
  const mergedMainAgent: MainAgentConfig = {
    ...(globalConfig?.mainAgent ?? {}),
    ...(projectConfig?.mainAgent ?? {}),
  };

  return {
    mainAgent: Object.keys(mergedMainAgent).length > 0 ? mergedMainAgent : undefined,
    agents: mergedAgents,
  };
}

// ─── Extension Resolver ─────────────────────────────────────────

function resolveExtension(ref: string, agentDir: string): AgentExtensionRef {
  // Mode 1: pi package (npm: atau git:)
  if (ref.startsWith("npm:") || ref.startsWith("git:")) {
    return { type: "pi-package", value: ref };
  }

  // Mode 2: absolute path
  if (ref.startsWith("/")) {
    return { type: "path", value: ref, resolved: ref };
  }

  // Mode 3: home directory expansion
  if (ref.startsWith("~")) {
    const resolved = path.join(os.homedir(), ref.slice(1));
    return { type: "path", value: ref, resolved };
  }

  // Mode 4: relative path (dari lokasi agent .md file)
  const resolved = path.resolve(agentDir, ref);
  return { type: "path", value: ref, resolved };
}

function resolveExtensions(
  rawExtensions: string[] | undefined,
  agentDir: string,
): AgentExtensionRef[] {
  if (!rawExtensions || rawExtensions.length === 0) return [];
  return rawExtensions.map((ref) => resolveExtension(ref.trim(), agentDir));
}

// ─── Agent Loading ──────────────────────────────────────────────

interface RawAgentDoc {
  frontmatter: FrontmatterFields;
  body: string;
  filePath: string;
  source: AgentConfig["source"];
}

function loadAgentFromDoc(doc: RawAgentDoc): { agent: AgentConfig | null; warnings: AgentDiscoveryWarning[] } {
  const fm = doc.frontmatter;
  const filePath = doc.filePath;
  const warnings: AgentDiscoveryWarning[] = [];

  if (!fm.name || !fm.description) {
    if (fm.name) {
      warnings.push(warn(filePath, `Subagent "${fm.name}": missing required field "description", skipping`));
    } else {
      warnings.push(warn(filePath, "Missing required fields (name + description), skipping"));
    }
    return { agent: null, warnings };
  }

  // Validate name: no whitespace
  if (/\s/.test(fm.name)) {
    warnings.push(warn(filePath, `Subagent name "${fm.name}" contains whitespace, skipping. Use "-" instead.`));
    return { agent: null, warnings };
  }

  // Model validation
  const { model, warning: modelWarning } = parseModel(fm.model);
  if (modelWarning) {
    modelWarning.filePath = filePath;
    warnings.push(modelWarning);
  }

  // Thinking validation
  const { thinking, warning: thinkingWarning } = parseThinking(fm.thinking);
  if (thinkingWarning) {
    thinkingWarning.filePath = filePath;
    warnings.push(thinkingWarning);
  }

  // Tools — handle both string and YAML array from SDK parser
  const rawTools = fm.tools;
  let tools: string[] | undefined;
  if (typeof rawTools === "string") {
    tools = rawTools.split(",").map((t: string) => t.trim()).filter(Boolean);
  } else if (Array.isArray(rawTools)) {
    tools = rawTools.map((t: unknown) => String(t).trim()).filter(Boolean);
  }

  // Skills — same as tools
  const rawSkills = fm.skills;
  let skills: string[] | undefined;
  if (typeof rawSkills === "string") {
    skills = rawSkills.split(",").map((s: string) => s.trim()).filter(Boolean);
  } else if (Array.isArray(rawSkills)) {
    skills = rawSkills.map((s: unknown) => String(s).trim()).filter(Boolean);
  }

  // Extensions — handle YAML array or comma-separated string from SDK
  const rawExtensions = fm.extensions;
  const extensionsList: string[] = Array.isArray(rawExtensions)
    ? rawExtensions.map((e: unknown) => String(e).trim()).filter(Boolean)
    : typeof rawExtensions === "string" && rawExtensions.trim()
      ? rawExtensions.split(",").map((e: string) => e.trim()).filter(Boolean)
      : [];

  const agentDir = path.dirname(filePath);
  const extensions = resolveExtensions(
    extensionsList.length > 0 ? extensionsList : undefined,
    agentDir,
  );

  // Booleans — SDK returns native boolean, handle both cases
  const interactive = fm.interactive === true || fm.interactive === "true";
  const compaction = fm.compaction !== false && fm.compaction !== "false";

  return {
    agent: {
      name: fm.name,
      description: fm.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: model || undefined,
      thinking: thinking || undefined,
      skills: skills && skills.length > 0 ? skills : undefined,
      systemPrompt: doc.body,
      source: doc.source,
      filePath,
      extensions,
      interactive,
      compaction,
    },
    warnings,
  };
}

// ─── Directory Discovery ────────────────────────────────────────

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function loadAgentsFromDir(
  dir: string,
  source: AgentConfig["source"],
): { agents: AgentConfig[]; warnings: AgentDiscoveryWarning[] } {
  const agents: AgentConfig[] = [];
  const warnings: AgentDiscoveryWarning[] = [];

  if (!fs.existsSync(dir)) return { agents, warnings };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { agents, warnings };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (entry.name.toLowerCase() === "agents.md") continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      warnings.push(warn(filePath, `Could not read file, skipping`));
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    const result = loadAgentFromDoc({ frontmatter, body, filePath, source });
    warnings.push(...result.warnings);
    if (result.agent) agents.push(result.agent);
  }

  return { agents, warnings };
}

// ─── Bundled Agents ─────────────────────────────────────────────

let bundledAgentsDir: string | null = null;

export function setBundledAgentsDir(dir: string) {
  bundledAgentsDir = dir;
}

function loadBundledAgents(): { agents: AgentConfig[]; warnings: AgentDiscoveryWarning[] } {
  if (!bundledAgentsDir) return { agents: [], warnings: [] };
  return loadAgentsFromDir(bundledAgentsDir, "bundled");
}

// ─── Config Override Application (was agents.config.ts) ─────────

/**
 * Apply config overrides to agent definitions.
 * Returns a new array with overrides applied (does not mutate original).
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
      const agentDir = path.dirname(agent.filePath);
      const rawExtensions = Array.isArray(overrides.extensions)
        ? overrides.extensions
        : [String(overrides.extensions)];
      updated.extensions = resolveExtensions(rawExtensions, agentDir);
    }

    if (overrides.skills !== undefined) {
      updated.skills = Array.isArray(overrides.skills)
        ? overrides.skills.map(String)
        : [String(overrides.skills)];
    }

    return updated;
  });
}

// ─── Main Discovery ─────────────────────────────────────────────

/**
 * Discover agents from all sources.
 * Priority: project > user > bundled (higher priority overrides lower).
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const allWarnings: AgentDiscoveryWarning[] = [];

  const userResult = scope !== "project"
    ? loadAgentsFromDir(userDir, "user")
    : { agents: [], warnings: [] as AgentDiscoveryWarning[] };
  allWarnings.push(...userResult.warnings);

  const projectResult = scope !== "user" && projectAgentsDir
    ? loadAgentsFromDir(projectAgentsDir, "project")
    : { agents: [], warnings: [] as AgentDiscoveryWarning[] };
  allWarnings.push(...projectResult.warnings);

  const bundledResult = scope !== "user" && scope !== "project"
    ? loadBundledAgents()
    : { agents: [], warnings: [] as AgentDiscoveryWarning[] };
  allWarnings.push(...bundledResult.warnings);

  // Merge with priority: project > user > bundled
  const agentMap = new Map<string, AgentConfig>();

  // Bundled first (lowest priority)
  for (const agent of bundledResult.agents) {
    agentMap.set(agent.name, agent);
  }

  // User overrides bundled
  if (scope !== "project") {
    for (const agent of userResult.agents) {
      agentMap.set(agent.name, agent);
    }
  }

  // Project overrides user
  if (scope !== "user" && projectAgentsDir) {
    for (const agent of projectResult.agents) {
      agentMap.set(agent.name, agent);
    }
  }

  return {
    agents: Array.from(agentMap.values()),
    projectAgentsDir,
    warnings: allWarnings,
  };
}

/**
 * Find a specific agent by name, with config overrides applied.
 */
export function findAgent(
  cwd: string,
  scope: AgentScope,
  agentName: string,
): AgentConfig | undefined {
  const { agents } = discoverAgents(cwd, scope);
  const config = loadCrewConfig(cwd);
  if (config && config.agents && Object.keys(config.agents).length > 0) {
    const overridden = applyConfigOverrides(agents, config);
    return overridden.find((a) => a.name === agentName);
  }
  return agents.find((a) => a.name === agentName);
}

