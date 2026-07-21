/**
 * Config helpers — config file I/O, discovery, and validation.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CrewConfig, ExtensionOption, SkillOption } from "./config.types";

// ─── Config Path ────────────────────────────────────────────────

export function getConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "crew-of-pi.json");
}

export function getProjectConfigPath(cwd?: string): string | null {
  if (!cwd) return null;
  const projectPath = path.join(cwd, ".pi", "crew-of-pi.json");
  return fs.existsSync(path.dirname(projectPath)) ? projectPath : null;
}

// ─── Read/Write Config ──────────────────────────────────────────

export function readConfig(): CrewConfig {
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as CrewConfig;
    if (parsed && typeof parsed === "object") {
      if (!parsed.agents || typeof parsed.agents !== "object") {
        parsed.agents = {};
      }
      return parsed;
    }
    return { agents: {} };
  } catch {
    return { agents: {} };
  }
}

export function writeConfig(config: CrewConfig, targetPath?: string): boolean {
  const configPath = targetPath ?? getConfigPath();
  const configPath = getConfigPath();
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ─── Get Agent Names ────────────────────────────────────────────

export function getAgentNames(): string[] {
  const config = readConfig();
  return Object.keys(config.agents ?? {});
}

// ─── Discover Available Models ──────────────────────────────────

export function formatModelLabel(model: { provider: string; id: string; name?: string }): string {
  const label = `${model.provider}/${model.id}`;
  if (model.name) {
    return `${model.name} (${label})`;
  }
  return label;
}

// ─── Discover Installed Extensions ──────────────────────────────

export function discoverExtensions(): ExtensionOption[] {
  const discovered: ExtensionOption[] = [];
  const seen = new Set<string>();

  // 1. Installed from ~/.pi/agent/extensions/ (folder-based)
  const extDir = path.join(os.homedir(), ".pi", "agent", "extensions");
  try {
    if (fs.existsSync(extDir)) {
      for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          const extPath = path.join(extDir, entry.name);
          if (fs.existsSync(path.join(extPath, "index.ts")) || fs.existsSync(path.join(extPath, "config.json"))) {
            discovered.push({ label: `📦 ${entry.name} (local)`, value: extPath, type: "path" });
            seen.add(extPath);
          }
        }
      }
    }
  } catch { /* ignore */ }

  // 2. Pi packages from settings.json
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw) as { packages?: string[] };
      if (settings.packages && Array.isArray(settings.packages)) {
        for (const pkg of settings.packages) {
          if (!seen.has(pkg)) {
            discovered.push({ label: `📦 ${pkg}`, value: pkg, type: "pi-package" });
            seen.add(pkg);
          }
        }
      }
    }
  } catch { /* ignore */ }

  // 3. Also look in pluthenplay/extensions for dev extensions
  const ppExtDir = path.join(os.homedir(), ".pi", "agent", "pluthenplay", "extensions");
  try {
    if (fs.existsSync(ppExtDir)) {
      for (const entry of fs.readdirSync(ppExtDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          const extPath = path.join(ppExtDir, entry.name);
          if (fs.existsSync(path.join(extPath, "index.ts"))) {
            const key = `pluthenplay:${entry.name}`;
            if (!seen.has(key)) {
              discovered.push({ label: `🧪 ${entry.name} (dev)`, value: extPath, type: "path" });
              seen.add(key);
            }
          }
        }
      }
    }
  } catch { /* ignore */ }

  return discovered;
}

// ─── Discover Installed Skills ──────────────────────────────────

export function discoverSkills(): SkillOption[] {
  const skills: SkillOption[] = [];
  const skillsDir = path.join(os.homedir(), ".pi", "agent", "skills");

  try {
    if (fs.existsSync(skillsDir)) {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          const skillPath = path.join(skillsDir, entry.name);
          if (fs.existsSync(path.join(skillPath, "SKILL.md"))) {
            skills.push({ label: `⚡ ${entry.name}`, value: skillPath });
          } else {
            skills.push({ label: `📁 ${entry.name}`, value: skillPath });
          }
        }
      }
    }
  } catch { /* ignore */ }

  return skills;
}

// ─── Validation ─────────────────────────────────────────────────

export function validateModel(modelStr: string): string | null {
  if (!modelStr.includes("/")) {
    return 'Format model harus "provider/model-id" (contoh: 9r/worker)';
  }
  const parts = modelStr.split("/");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    return 'Format model tidak valid. Gunakan "provider/model-id"';
  }
  return null;
}

export function validatePath(p: string): string | null {
  if (!p.startsWith("/") && !p.startsWith("~") && !p.startsWith("npm:") && !p.startsWith("git:") && !p.startsWith("pluthenplay:")) {
    return 'Path harus absolute (/path), home (~/path), atau pi package (npm:, git:)';
  }
  if (p.startsWith("/") && !fs.existsSync(p)) {
    return `Path "${p}" tidak ditemukan`;
  }
  if (p.startsWith("~")) {
    const expanded = path.join(os.homedir(), p.slice(1));
    if (!fs.existsSync(expanded)) {
      return `Path "${p}" tidak ditemukan`;
    }
  }
  return null;
}
