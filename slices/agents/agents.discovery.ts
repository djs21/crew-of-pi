/**
 * Agent discovery — discovers agents from user, project, and bundled locations.
 * Extension resolver: supports path-based (absolute/relative/~) and pi-package (npm:/git:).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentDiscoveryResult, AgentDiscoveryWarning, AgentExtensionRef, AgentScope } from "../../shared/types";
import type { FrontmatterFields } from "./agents.types";
import { parseFrontmatter } from "./agents.frontmatter";
import { loadCrewConfig, applyConfigOverrides } from "./agents.config";

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

// ─── Extension Resolver ─────────────────────────────────────────

/**
 * Resolve an extension reference from an agent definition.
 * Supports:
 *   - npm:@scope/name (pi-package from npm)
 *   - git:github.com/user/repo (pi-package from git)
 *   - /absolute/path (absolute file path)
 *   - ~/path (home directory expansion)
 *   - relative/path (relative to agent .md file directory)
 */
export function resolveExtension(ref: string, agentDir: string): AgentExtensionRef {
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

/**
 * Resolve all extensions for an agent config.
 */
export function resolveExtensions(
  rawExtensions: string[] | undefined,
  agentDir: string,
): AgentExtensionRef[] {
  if (!rawExtensions || rawExtensions.length === 0) return [];
  return rawExtensions.map((ref) => resolveExtension(ref.trim(), agentDir));
}

// ─── Agent Loading ──────────────────────────────────────────────

export interface RawAgentDoc {
  frontmatter: FrontmatterFields;
  body: string;
  filePath: string;
  source: AgentConfig["source"];
}

/**
 * Load agent config from a parsed .md file.
 * Returns null if required fields missing; collects warnings for invalid optional fields.
 */
export function loadAgentFromDoc(doc: RawAgentDoc): { agent: AgentConfig | null; warnings: AgentDiscoveryWarning[] } {
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

/**
 * Format agent list for display or system prompt injection.
 */
export function formatAgentList(
  agents: AgentConfig[],
): string {
  if (agents.length === 0) return "none";
  return agents
    .map((a) => {
      const parts = [`- **${a.name}**: ${a.description} (model: ${a.model ?? "default"}`];
      if (a.tools) parts.push(`tools: ${a.tools.join(", ")}`);
      if (a.extensions.length > 0) {
        parts.push(`extensions: ${a.extensions.map((e) => e.value).join(", ")}`);
      }
      parts.push(")");
      return parts.join(", ");
    })
    .join("\n");
}