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
import type { AgentConfig, AgentExtensionRef, AgentDiscoveryResult, AgentScope } from "../../shared/types";
import type { FrontmatterFields } from "./agents.types";
import { parseFrontmatter } from "./agents.frontmatter";

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
 */
export function loadAgentFromDoc(doc: RawAgentDoc): AgentConfig | null {
  const fm = doc.frontmatter;

  if (!fm.name || !fm.description) return null;

  const tools = fm.tools
    ?.split(",")
    .map((t: string) => t.trim())
    .filter(Boolean);

  const skills = fm.skills
    ?.split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);

  const agentDir = path.dirname(doc.filePath);
  const extensions = resolveExtensions(
    Array.isArray(fm.extensions) ? fm.extensions : undefined,
    agentDir,
  );

  return {
    name: fm.name,
    description: fm.description,
    tools: tools && tools.length > 0 ? tools : undefined,
    model: fm.model || undefined,
    thinking: fm.thinking || undefined,
    skills: skills && skills.length > 0 ? skills : undefined,
    systemPrompt: doc.body,
    source: doc.source,
    filePath: doc.filePath,
    extensions,
    interactive: fm.interactive === true || fm.interactive === "true",
    compaction: fm.compaction !== false && fm.compaction !== "false",
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
): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) return agents;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    const agent = loadAgentFromDoc({ frontmatter, body, filePath, source });
    if (agent) agents.push(agent);
  }

  return agents;
}

// ─── Bundled Agents ─────────────────────────────────────────────

let bundledAgentsDir: string | null = null;

export function setBundledAgentsDir(dir: string) {
  bundledAgentsDir = dir;
}

function loadBundledAgents(): AgentConfig[] {
  if (!bundledAgentsDir) return [];
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

  const userAgents: AgentConfig[] = scope !== "project"
    ? loadAgentsFromDir(userDir, "user")
    : [];
  const projectAgents: AgentConfig[] = scope !== "user" && projectAgentsDir
    ? loadAgentsFromDir(projectAgentsDir, "project")
    : [];
  const bundledAgents: AgentConfig[] = scope !== "user" && scope !== "project"
    ? loadBundledAgents()
    : [];

  // Merge with priority: project > user > bundled
  const agentMap = new Map<string, AgentConfig>();

  // Bundled first (lowest priority)
  for (const agent of bundledAgents) {
    agentMap.set(agent.name, agent);
  }

  // User overrides bundled
  if (scope !== "project") {
    for (const agent of userAgents) {
      agentMap.set(agent.name, agent);
    }
  }

  // Project overrides user
  if (scope !== "user" && projectAgentsDir) {
    for (const agent of projectAgents) {
      agentMap.set(agent.name, agent);
    }
  }

  return {
    agents: Array.from(agentMap.values()),
    projectAgentsDir,
  };
}

/**
 * Find a specific agent by name.
 */
export function findAgent(
  cwd: string,
  scope: AgentScope,
  agentName: string,
): AgentConfig | undefined {
  const { agents } = discoverAgents(cwd, scope);
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