/**
 * Config main-agent editor — toggle enabled/disabled tools for main agent.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CrewConfig } from "./config.types";
import { ALL_MAIN_AGENT_TOOLS, DEFAULT_DISABLED_TOOLS } from "./config.types";
import { writeConfig } from "./config.helpers";

// ─── Public API ─────────────────────────────────────────────────

export async function editMainAgentTools(config: CrewConfig, ctx: ExtensionCommandContext): Promise<void> {
  const disabled = new Set(config.mainAgent?.disabledTools ?? DEFAULT_DISABLED_TOOLS);

  while (true) {
    const choice = await ctx.ui.select(
      `Main Agent Tools (${ALL_MAIN_AGENT_TOOLS.length - disabled.size} enabled, ${disabled.size} disabled):`,
      buildOptions(disabled),
    );

    if (!choice || choice === "✅ Selesai — simpan") break;
    toggleTool(choice, disabled);
  }

  saveMainAgentConfig(config, disabled, ctx);
}

// ─── Internal ───────────────────────────────────────────────────

function buildOptions(disabled: Set<string>): string[] {
  const opts: string[] = ["━ Pilih tool untuk toggle enabled/disabled ─"];
  for (const tool of ALL_MAIN_AGENT_TOOLS) {
    if (disabled.has(tool)) {
      opts.push(`🔴 ${tool} (disabled)`);
    } else {
      opts.push(`🟢 ${tool} (enabled)`);
    }
  }
  opts.push("───", "✅ Selesai — simpan");
  return opts;
}

function toggleTool(choice: string, disabled: Set<string>): void {
  for (const tool of ALL_MAIN_AGENT_TOOLS) {
    if (choice === `🟢 ${tool} (enabled)` || choice === `🔴 ${tool} (disabled)`) {
      if (disabled.has(tool)) disabled.delete(tool);
      else disabled.add(tool);
      return;
    }
  }
}

function saveMainAgentConfig(config: CrewConfig, disabled: Set<string>, ctx: ExtensionCommandContext): void {
  const disabledArr = Array.from(disabled);
  if (disabledArr.length === 0) {
    delete config.mainAgent?.disabledTools;
    if (config.mainAgent && Object.keys(config.mainAgent).length === 0) {
      delete config.mainAgent;
    }
  } else {
    if (!config.mainAgent) config.mainAgent = {};
    config.mainAgent.disabledTools = disabledArr;
  }

  if (!config.agents) config.agents = {};

  if (writeConfig(config)) {
    ctx.ui.notify("✅ Main agent tool config saved! Jalankan /reload agar berlaku.", "info");
  } else {
    ctx.ui.notify("❌ Gagal menyimpan config!", "error");
  }
}
