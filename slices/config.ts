/**
 * config.ts — Lean configuration management and slash command for crew-of-pi.
 * Reads/writes ~/.pi/agent/crew.json and .pi/crew.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CrewConfig } from "../shared/types";
import { getAgentRegistry } from "./agents";

function getGlobalConfigPaths(): string[] {
  const dir = getAgentDir();
  return [path.resolve(dir, "crew-of-pi.json"), path.resolve(dir, "crew.json")];
}

function getProjectConfigPaths(cwd: string): string[] {
  return [path.resolve(cwd, ".pi/crew-of-pi.json"), path.resolve(cwd, ".pi/crew.json")];
}

export function readConfig(cwd?: string): CrewConfig {
  let config: CrewConfig = {};

  // 1. Read global config (crew-of-pi.json takes precedence over crew.json)
  for (const p of getGlobalConfigPaths()) {
    if (fs.existsSync(p)) {
      try {
        config = JSON.parse(fs.readFileSync(p, "utf-8"));
        break;
      } catch {
        // ignore
      }
    }
  }

  // 2. Merge project config
  if (cwd) {
    for (const p of getProjectConfigPaths(cwd)) {
      if (fs.existsSync(p)) {
        try {
          const projectConfig = JSON.parse(fs.readFileSync(p, "utf-8"));
          config = {
            ...config,
            agents: {
              ...config.agents,
              ...projectConfig.agents,
            },
            mainAgent: projectConfig.mainAgent ?? config.mainAgent,
          };
          break;
        } catch {
          // ignore
        }
      }
    }
  }

  return config;
}
export function writeConfig(config: CrewConfig, scope: "global" | "project" = "global", cwd?: string): void {
  const targetPath = scope === "project" && cwd ? getProjectConfigPaths(cwd)[0] : getGlobalConfigPaths()[0];
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(targetPath, JSON.stringify(config, null, 2), "utf-8");
}

export function formatConfig(config: CrewConfig): string {
  const agents = config.agents ?? {};
  const entries = Object.entries(agents);

  if (entries.length === 0) {
    return "No agent configuration overrides set (using default .md definitions).";
  }

  const lines: string[] = ["## Current Crew Overrides", ""];
  for (const [name, cfg] of entries) {
    lines.push(`### ${name}`);
    if (cfg.model) lines.push(`- Model: \`${cfg.model}\``);
    if (cfg.thinking) lines.push(`- Thinking: \`${cfg.thinking}\``);
    if (cfg.extensions && cfg.extensions.length > 0) {
      lines.push(`- Extensions: ${cfg.extensions.map((e) => e.value).join(", ")}`);
    }
    if (cfg.skills && cfg.skills.length > 0) {
      lines.push(`- Skills: ${cfg.skills.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function handleConfigCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();

  const registry = getAgentRegistry();

  if (!sub || sub === "show") {
    const config = readConfig(ctx.cwd);
    ctx.ui.notify(formatConfig(config), "info");
    return;
  }

  if (sub === "reset") {
    const scope = (parts[1]?.toLowerCase() === "project" ? "project" : "global") as "global" | "project";
    writeConfig({}, scope, ctx.cwd);
    registry.refresh(ctx.cwd, "both");
    ctx.ui.notify(`Config reset (${scope}).`, "info");
    return;
  }

  if (sub === "model" && parts[1] && parts[2]) {
    const agentName = parts[1];
    const modelStr = parts[2];
    const scope = (parts[3]?.toLowerCase() === "project" ? "project" : "global") as "global" | "project";

    const config = readConfig(ctx.cwd);
    if (!config.agents) config.agents = {};
    if (!config.agents[agentName]) config.agents[agentName] = {};
    config.agents[agentName].model = modelStr;

    writeConfig(config, scope, ctx.cwd);
    registry.refresh(ctx.cwd, "both");
    ctx.ui.notify(`Set model for ${agentName} to \`${modelStr}\` (${scope}).`, "info");
    return;
  }

  // Interactive picker fallback if invoked without specific sub-args
  const agentNames = registry.getNames();
  if (agentNames.length === 0) {
    ctx.ui.notify("No agents discovered.", "warning");
    return;
  }

  const selectedAgent = await ctx.ui.select("Select agent to configure model override:", agentNames);
  if (!selectedAgent) return;

  const currentModel = registry.get(selectedAgent)?.model ?? "(none)";
  const newModel = await ctx.ui.input(
    `Enter model for "${selectedAgent}" (e.g. provider/model-id):`,
    currentModel !== "(none)" ? currentModel : undefined,
  );

  if (!newModel || newModel.trim() === "") return;

  const config = readConfig(ctx.cwd);
  if (!config.agents) config.agents = {};
  if (!config.agents[selectedAgent]) config.agents[selectedAgent] = {};
  config.agents[selectedAgent].model = newModel.trim();

  writeConfig(config, "global", ctx.cwd);
  registry.refresh(ctx.cwd, "both");
  ctx.ui.notify(`Updated ${selectedAgent} model to \`${newModel.trim()}\`.`, "info");
}

export function registerConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand("crew-of-pi", {
    description: "Manage crew-of-pi configuration: /crew-of-pi [show | model <agent> <model> | reset]",
    async handler(args: string, ctx: ExtensionCommandContext) {
      await handleConfigCommand(args, ctx);
    },
  });
}
