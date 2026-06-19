/**
 * /crew-of-pi slash command — thin orchestrator.
 *
 * Delegates to:
 *   - config.wizard.ts       — agent config field wizards
 *   - config.main-agent.ts   — main agent tool policy editor
 *   - config.helpers.ts      — config I/O, formatting
 *   - config.types.ts        — types & constants
 *
 * Owns: command registration, argument completions, help text,
 *       top-level handler routing, and per-agent edit flow.
 */

import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { CrewConfig } from "./config.types";
import { DEFAULT_DISABLED_TOOLS, ALL_MAIN_AGENT_TOOLS, MAIN_AGENT_KEY } from "./config.types";
import { readConfig, writeConfig, getAgentNames } from "./config.helpers";
import { pickAgent, pickField, editModel, editExtensions, editSkills } from "./config.wizard";
import { editMainAgentTools } from "./config.main-agent";

// ─── Top-Level Handler ──────────────────────────────────────────

async function handleCrewOfPiCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();

  if (trimmed === "help" || trimmed === "" || trimmed === "--help" || trimmed === "-h") {
    ctx.ui.notify(showHelp(), "info");
    return;
  }

  if (trimmed === "config" || trimmed.startsWith("config ")) {
    const subArgs = trimmed.startsWith("config ") ? trimmed.slice(7) : "";
    await handleConfigSubcommand(subArgs, ctx);
    return;
  }

  ctx.ui.notify(`Unknown subcommand: "${trimmed}". Gunakan /crew-of-pi help`, "error");
}

// ─── Config Subcommand ──────────────────────────────────────────

async function handleConfigSubcommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();

  if (trimmed === "show") {
    ctx.ui.notify(formatConfig(readConfig()), "info");
    return;
  }

  // Direct edit: /crew-of-pi config <agent> <field>
  const parts = trimmed.split(/\s+/);
  const directAgentName = parts[0] && !["show", "help"].includes(parts[0]) ? parts[0] : undefined;
  const directField = parts[1] && ["model", "extensions", "skills"].includes(parts[1]) ? parts[1] : undefined;

  const config = readConfig();

  if (directAgentName && directField) {
    await editFieldForAgent(config, directAgentName, directField, ctx);
    return;
  }

  // Interactive wizard
  const agentName = await pickAgent(ctx);
  if (!agentName) return;

  if (agentName === MAIN_AGENT_KEY) {
    await editMainAgentTools(config, ctx);
    return;
  }

  const field = await pickField(ctx);
  if (!field) return;

  if (field === "show") {
    ctx.ui.notify(`Konfigurasi untuk "${agentName}":\n${formatAgentConfig(config, agentName)}`, "info");
    return;
  }

  await editFieldForAgent(config, agentName, field, ctx);
}

// ─── Per-Agent Edit + Save ──────────────────────────────────────

async function editFieldForAgent(
  config: CrewConfig,
  agentName: string,
  field: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!config.agents) config.agents = {};
  const agent = config.agents[agentName] ?? (config.agents[agentName] = {});

  if (field === "model") {
    const newModel = await editModel(agentName, agent.model, ctx);
    if (newModel === undefined) return;
    agent.model = newModel;
  } else if (field === "extensions") {
    const newExtensions = await editExtensions(agentName, agent.extensions, ctx);
    if (newExtensions === undefined) return;
    agent.extensions = newExtensions.length > 0 ? newExtensions : undefined;
  } else if (field === "skills") {
    const newSkills = await editSkills(agentName, agent.skills, ctx);
    if (newSkills === undefined) return;
    agent.skills = newSkills.length > 0 ? newSkills : undefined;
  }

  if (writeConfig(config)) {
    ctx.ui.notify(`✅ Config untuk "${agentName}" berhasil disimpan!`, "info");
    ctx.ui.notify(`ℹ️ Jalankan /reload agar perubahan langsung berlaku`, "info");
  } else {
    ctx.ui.notify(`❌ Gagal menyimpan config! Periksa permissions.`, "error");
  }
}

// ─── Display Formatting ─────────────────────────────────────────

function formatConfig(config: CrewConfig): string {
  const lines: string[] = ["## crew-of-pi.json Config\n"];

  const disabledTools = config.mainAgent?.disabledTools ?? DEFAULT_DISABLED_TOOLS;
  lines.push("### Main Agent");
  lines.push(`- disabled tools: ${disabledTools.length ? disabledTools.join(", ") : "(none)"}`);
  const enabledTools = ALL_MAIN_AGENT_TOOLS.filter((t) => !disabledTools.includes(t));
  lines.push(`- enabled tools: ${enabledTools.length ? enabledTools.join(", ") : "(none)"}`);
  lines.push("");

  const agentNames = Object.keys(config.agents ?? {});
  if (agentNames.length === 0) {
    lines.push("No agents configured.");
  } else {
    for (const name of agentNames) {
      const agent = (config.agents ?? {})[name];
      lines.push(`### ${name}`);
      lines.push(`- model: ${agent.model ?? "(default)"}`);
      lines.push(`- extensions: ${agent.extensions?.length ? agent.extensions.join(", ") : "(none)"}`);
      lines.push(`- skills: ${agent.skills?.length ? agent.skills.join(", ") : "(none)"}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function formatAgentConfig(config: CrewConfig, agentName: string): string {
  if (agentName === MAIN_AGENT_KEY) {
    const disabledTools = config.mainAgent?.disabledTools ?? DEFAULT_DISABLED_TOOLS;
    const enabledTools = ALL_MAIN_AGENT_TOOLS.filter((t) => !disabledTools.includes(t));
    return [
      `disabled tools: ${disabledTools.length ? disabledTools.join(", ") : "(none)"}`,
      `enabled tools: ${enabledTools.length ? enabledTools.join(", ") : "(none)"}`,
    ].join("\n");
  }

  const agent = config.agents?.[agentName];
  if (!agent) return "Belum ada konfigurasi.";
  return [
    `model: ${agent.model ?? "(default)"}`,
    `extensions: ${agent.extensions?.length ? agent.extensions.join(", ") : "(none)"}`,
    `skills: ${agent.skills?.length ? agent.skills.join(", ") : "(none)"}`,
  ].join("\n");
}

// ─── Help ───────────────────────────────────────────────────────

function showHelp(): string {
  return [
    "## /crew-of-pi — Crew Config Manager",
    "",
    "**Usage:**",
    "  `/crew-of-pi config`       — Interactive wizard: pilih agent → pilih field → edit",
    "  `/crew-of-pi config show`  — Tampilkan konfigurasi saat ini",
    "  `/crew-of-pi help`         — Tampilkan pesan ini",
    "",
    "**Fields yang bisa diedit per agent:**",
    "  `model`      — Pilih model dari yang tersedia atau ketik manual",
    "  `extensions` — Pilih dari installed extensions, pi packages, atau path kustom",
    "  `skills`     — Pilih dari installed skills atau path kustom",
    "",
    "**Main Agent:**",
    "  Pilih '🤖 Main Agent (tool policy)' untuk toggle enabled/disabled tools",
    "  Tools: read, bash, grep, find, ls, write, edit",
    "  Default disabled: write, edit",
    "",
    "**Lokasi config:** `~/.pi/agent/crew-of-pi.json`",
  ].join("\n");
}

// ─── Argument Completions ───────────────────────────────────────

function getArgumentCompletions(argumentPrefix: string): { value: string; label: string; description?: string }[] | null {
  const prefix = argumentPrefix.toLowerCase();

  if (prefix === "" || "config".startsWith(prefix)) {
    return [
      { value: "config", label: "config", description: "Edit crew-of-pi.json config interactively" },
      { value: "config show", label: "config show", description: "Show current config" },
      { value: "help", label: "help", description: "Show usage information" },
    ];
  }

  if ("config ".startsWith(prefix) || prefix.startsWith("config ")) {
    const sub = prefix.startsWith("config ") ? prefix.slice(7) : "";
    const agentNames = getAgentNames();
    const agentCompletions = agentNames.map((name) => ({
      value: `config ${name}`, label: `config ${name}`, description: `Configure agent "${name}"`,
    }));
    const fieldCompletions = ["model", "extensions", "skills"].map((f) => ({
      value: `config <agent> ${f}`, label: `config <agent> ${f}`, description: `Edit ${f}`,
    }));

    if (!sub || agentNames.some((n) => n.startsWith(sub))) {
      const matching = agentNames.filter((n) => n.startsWith(sub));
      if (matching.length > 0) return matching.map((n) => ({ value: `config ${n}`, label: `config ${n}`, description: `Configure agent "${n}"` }));
      return [
        { value: "config show", label: "config show", description: "Show current config" },
        ...agentCompletions,
        ...fieldCompletions,
      ];
    }

    const firstArg = sub.split(/\s+/)[0];
    if (firstArg && agentNames.includes(firstArg)) {
      const fieldPrefix = sub.split(/\s+/)[1] || "";
      return ["model", "extensions", "skills"]
        .filter((f) => f.startsWith(fieldPrefix))
        .map((f) => ({ value: `config ${firstArg} ${f}`, label: `config ${firstArg} ${f}`, description: `Edit ${f} for "${firstArg}"` }));
    }
  }

  return null;
}

// ─── Registration ───────────────────────────────────────────────

export function registerConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand("crew-of-pi", {
    description: "Manage crew-of-pi config — model, extensions, skills per agent, main agent tool policy",
    handler: handleCrewOfPiCommand,
    getArgumentCompletions,
  } as Omit<RegisteredCommand, "name" | "sourceInfo">);
}
