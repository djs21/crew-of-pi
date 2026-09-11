/**
 * config.ts — Configuration management and the /crew-of-pi slash command.
 *
 * Config sources (crew-of-pi.json wins over crew.json):
 *   global  : <agentDir>/crew-of-pi.json
 *   project : <cwd>/.pi/crew-of-pi.json
 *
 * The command's logic lives in the pure helpers below (classifySubcommand,
 * buildHelpText, computeArgumentCompletions, buildModelChoices, buildDenyRows,
 * collectDeniedFromRows) and is unit-tested in tests/config-command.test.ts.
 * The TUI shell stays thin on purpose so it needs no test of its own.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SettingsList,
  type AutocompleteItem,
  type SettingItem,
} from "@earendil-works/pi-tui";
import type { AgentConfigOverride, CrewConfig } from "../shared/types";
import { type AgentRegistry, getAgentRegistry } from "./agents";
import { GLOBAL_DENIED_TOOLS } from "./spawn";

// ─── Config Files ───────────────────────────────────────────────────

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
    if (cfg.denyTools && cfg.denyTools.length > 0) {
      lines.push(`- Denied Tools: \`${cfg.denyTools.join(", ")}\``);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ─── Pure command logic (unit-tested) ───────────────────────────────

export type ConfigScope = "global" | "project";

export type Subcommand =
  | { kind: "menu" }
  | { kind: "help" }
  | { kind: "show" }
  | { kind: "reset"; scope: ConfigScope }
  | { kind: "model"; agent: string; model: string; scope: ConfigScope }
  | { kind: "deny"; agent: string; tools: string[]; scope: ConfigScope }
  | { kind: "incomplete"; sub: string }
  | { kind: "unknown"; sub: string };

function toScope(raw: string | undefined): ConfigScope {
  return raw?.toLowerCase() === "project" ? "project" : "global";
}

/**
 * Turn raw command arguments into a decision. Anything that is not a complete,
 * known subcommand becomes `unknown` or `incomplete` — never the interactive
 * menu — so a typo can no longer open a picker.
 */
export function classifySubcommand(args: string): Subcommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();

  if (!sub) return { kind: "menu" };
  if (sub === "menu") return { kind: "menu" };
  if (sub === "help" || sub === "-h" || sub === "--help") return { kind: "help" };
  if (sub === "show") return { kind: "show" };
  if (sub === "reset") return { kind: "reset", scope: toScope(parts[1]) };

  if (sub === "model") {
    if (!parts[1] || !parts[2]) return { kind: "incomplete", sub };
    return { kind: "model", agent: parts[1], model: parts[2], scope: toScope(parts[3]) };
  }

  if (sub === "deny") {
    if (!parts[1] || !parts[2]) return { kind: "incomplete", sub };
    const tools = parts[2].split(",").map((t) => t.trim()).filter(Boolean);
    if (tools.length === 0) return { kind: "incomplete", sub };
    return { kind: "deny", agent: parts[1], tools, scope: toScope(parts[3]) };
  }

  return { kind: "unknown", sub };
}

export function buildHelpText(): string {
  return [
    "## /crew-of-pi",
    "",
    "| Command | Description |",
    "| --- | --- |",
    "| `/crew-of-pi` | Open the interactive action menu (TUI) |",
    "| `/crew-of-pi show` | Show current overrides |",
    "| `/crew-of-pi model <agent> <model> [project\\|global]` | Set an agent model override |",
    "| `/crew-of-pi deny <agent> <tools> [project\\|global]` | Set an agent tool denylist (comma-separated) |",
    "| `/crew-of-pi reset [project\\|global]` | Clear configuration overrides |",
    "| `/crew-of-pi help` | Show this help |",
    "",
    "Interactive flows are TUI-only; every subcommand above also works without a TUI.",
  ].join("\n");
}

const SUBCOMMANDS: AutocompleteItem[] = [
  { value: "show", label: "show", description: "Show current overrides" },
  { value: "model", label: "model", description: "Set an agent model override" },
  { value: "deny", label: "deny", description: "Set an agent tool denylist" },
  { value: "reset", label: "reset", description: "Clear configuration overrides" },
  { value: "menu", label: "menu", description: "Open the interactive action menu" },
  { value: "help", label: "help", description: "Show usage" },
];

/**
 * Positional completion: subcommand -> agent name -> scope.
 * Contract: `RegisteredCommand.getArgumentCompletions` (pi-coding-agent
 * dist/core/extensions/types.d.ts:895). Never throws and returns null — not an
 * empty array — when there is nothing to offer.
 */
export function computeArgumentCompletions(
  prefix: string,
  agentNames: string[],
): AutocompleteItem[] | null {
  try {
    const parts = prefix.trimStart().split(/\s+/);
    const head = parts[0] ?? "";

    if (parts.length <= 1) {
      const hits = SUBCOMMANDS.filter((s) => s.value.startsWith(head.toLowerCase()));
      return hits.length > 0 ? hits : null;
    }

    const sub = head.toLowerCase();

    if ((sub === "model" || sub === "deny") && parts.length === 2) {
      const needle = parts[1] ?? "";
      const hits = agentNames
        .filter((a) => a.startsWith(needle))
        .map((a) => ({ value: `${sub} ${a}`, label: a, description: `Configure ${a}` }));
      return hits.length > 0 ? hits : null;
    }

    if (sub === "reset" && parts.length === 2) {
      const needle = parts[1] ?? "";
      const hits = ["global", "project"]
        .filter((s) => s.startsWith(needle))
        .map((s) => ({ value: `reset ${s}`, label: s, description: `${s} scope` }));
      return hits.length > 0 ? hits : null;
    }

    return null;
  } catch {
    return null;
  }
}

export const CUSTOM_MODEL_OPTION = "[ Custom input... ]";

/**
 * Build the model picker labels: `<provider>/<id>`, de-duplicated and sorted,
 * with the free-form escape hatch pinned first.
 */
export function buildModelChoices(models: { provider: string; id: string }[]): string[] {
  const labels = new Set<string>();
  for (const m of models) {
    if (!m?.provider || !m?.id) continue;
    labels.add(`${m.provider}/${m.id}`);
  }
  return [CUSTOM_MODEL_OPTION, ...Array.from(labels).sort()];
}

export interface DenyRow {
  name: string;
  value: "allowed" | "denied";
  locked: boolean;
}

/**
 * One row per tool. Tools in `lockedTools` are always denied and cannot be
 * re-enabled — the anti-recursion crew_* tools are enforced in code by
 * computeEffectiveDenyList(), so offering them as toggles would be a lie.
 */
export function buildDenyRows(
  toolNames: string[],
  existingDeny: string[],
  lockedTools: string[],
): DenyRow[] {
  const locked = new Set(lockedTools);
  const denied = new Set(existingDeny);
  const seen = new Set<string>();
  const rows: DenyRow[] = [];

  for (const name of toolNames) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (locked.has(name)) {
      rows.push({ name, value: "denied", locked: true });
    } else if (denied.has(name)) {
      rows.push({ name, value: "denied", locked: false });
    } else {
      rows.push({ name, value: "allowed", locked: false });
    }
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Only the user-managed denies; locked crew_* are implied and never persisted. */
export function collectDeniedFromRows(rows: DenyRow[]): string[] {
  return rows
    .filter((r) => !r.locked && r.value === "denied")
    .map((r) => r.name)
    .sort();
}

// ─── Interactive flows (thin TUI shell) ─────────────────────────────

function applyAgentOverride(
  ctx: ExtensionCommandContext,
  scope: ConfigScope,
  agentName: string,
  mutate: (override: AgentConfigOverride) => void,
): void {
  const config = readConfig(ctx.cwd);
  if (!config.agents) config.agents = {};
  if (!config.agents[agentName]) config.agents[agentName] = {};
  mutate(config.agents[agentName]);
  writeConfig(config, scope, ctx.cwd);
  getAgentRegistry().refresh(ctx.cwd, "both");
}

function requireTui(ctx: ExtensionCommandContext): boolean {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/crew-of-pi interactive mode requires a TUI.", "error");
    return false;
  }
  return true;
}

async function pickAgent(ctx: ExtensionCommandContext, registry: AgentRegistry): Promise<string | undefined> {
  const agentNames = registry.getNames();
  if (agentNames.length === 0) {
    ctx.ui.notify("No agents discovered.", "warning");
    return undefined;
  }
  return await ctx.ui.select("Select agent", agentNames);
}

async function pickScope(ctx: ExtensionCommandContext): Promise<ConfigScope | undefined> {
  const label = await ctx.ui.select("Save to scope", ["global", "project"]);
  if (!label) return undefined;
  return label === "project" ? "project" : "global";
}

/** List all available (auth-configured) models from the ModelRegistry; fallback to all models. */
function modelCatalogue(ctx: ExtensionCommandContext): { provider: string; id: string }[] {
  const available = ctx.modelRegistry?.getAvailable?.() ?? [];
  if (available.length > 0) {
    return available.map((m) => ({ provider: String(m.provider), id: m.id }));
  }
  const all = ctx.modelRegistry?.getAll?.() ?? [];
  return all.map((m) => ({ provider: String(m.provider), id: m.id }));
}

async function runModelFlow(
  ctx: ExtensionCommandContext,
  registry: AgentRegistry,
): Promise<void> {
  const agent = await pickAgent(ctx, registry);
  if (!agent) return;

  const choice = await ctx.ui.select(`Select model for ${agent}`, buildModelChoices(modelCatalogue(ctx)));
  if (!choice) return;

  let model = choice;
  if (choice === CUSTOM_MODEL_OPTION) {
    const typed = await ctx.ui.input("Model (provider/model-id)", registry.get(agent)?.model ?? undefined);
    if (!typed || !typed.trim()) return;
    model = typed.trim();
  }

  const scope = await pickScope(ctx);
  if (!scope) return;

  applyAgentOverride(ctx, scope, agent, (override) => {
    override.model = model;
  });
  ctx.ui.notify(`Set ${agent} model to \`${model}\` (${scope}).`, "info");
}

async function openDenySelector(
  ctx: ExtensionCommandContext,
  agent: string,
  rows: DenyRow[],
): Promise<Map<string, "allowed" | "denied">> {
  const locked = new Set(rows.filter((r) => r.locked).map((r) => r.name));
  const working = new Map<string, "allowed" | "denied">(rows.map((r) => [r.name, r.value]));

  const items: SettingItem[] = rows.map((r) => ({
    id: r.name,
    label: r.name,
    description: r.locked ? "always denied — cannot be enabled" : undefined,
    currentValue: r.value,
    values: r.locked ? undefined : ["allowed", "denied"],
  }));

  await ctx.ui.custom<undefined>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild({
      render: () => [theme.fg("accent", theme.bold(`Denied tools — ${agent}`)), ""],
      invalidate() {},
    });
    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, newValue) => {
        if (locked.has(id)) return;
        working.set(id, newValue === "denied" ? "denied" : "allowed");
      },
      () => done(undefined),
    );
    container.addChild(list);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput?.(data);
        tui.requestRender();
      },
    };
  });

  return working;
}

async function runDenyFlow(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  registry: AgentRegistry,
): Promise<void> {
  const agent = await pickAgent(ctx, registry);
  if (!agent) return;

  const scope = await pickScope(ctx);
  if (!scope) return;

  const rows = buildDenyRows(
    pi.getAllTools().map((t) => t.name),
    registry.get(agent)?.denyTools ?? [],
    GLOBAL_DENIED_TOOLS,
  );

  const working = await openDenySelector(ctx, agent, rows);
  const denied = collectDeniedFromRows(
    rows.map((r) => ({ ...r, value: working.get(r.name) ?? r.value })),
  );

  applyAgentOverride(ctx, scope, agent, (override) => {
    override.denyTools = denied;
  });
  ctx.ui.notify(
    `Set ${agent} denied tools: [${denied.join(", ") || "none"}] (${scope}).`,
    "info",
  );
}

async function runRootMenu(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  registry: AgentRegistry,
): Promise<void> {
  if (!requireTui(ctx)) return;

  const action = await ctx.ui.select("crew-of-pi — choose an action", [
    "Show configuration",
    "Configure agent model",
    "Configure denied tools",
    "Reset overrides",
    "Help",
  ]);
  if (!action) return;

  switch (action) {
    case "Show configuration":
      ctx.ui.notify(formatConfig(readConfig(ctx.cwd)), "info");
      return;
    case "Configure agent model":
      await runModelFlow(ctx, registry);
      return;
    case "Configure denied tools":
      await runDenyFlow(ctx, pi, registry);
      return;
    case "Reset overrides": {
      const scope = await pickScope(ctx);
      if (!scope) return;
      writeConfig({}, scope, ctx.cwd);
      registry.refresh(ctx.cwd, "both");
      ctx.ui.notify(`Config reset (${scope}).`, "info");
      return;
    }
    case "Help":
      ctx.ui.notify(buildHelpText(), "info");
      return;
  }
}

// ─── Command dispatch ───────────────────────────────────────────────

async function handleConfigCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const cmd = classifySubcommand(args);
  const registry = getAgentRegistry();

  switch (cmd.kind) {
    case "help":
      ctx.ui.notify(buildHelpText(), "info");
      return;
    case "unknown":
      ctx.ui.notify(`Unknown subcommand '${cmd.sub}'. Run /crew-of-pi help for usage.`, "error");
      return;
    case "incomplete":
      ctx.ui.notify(
        `/crew-of-pi ${cmd.sub} needs more arguments. Run /crew-of-pi help for usage.`,
        "warning",
      );
      return;
    case "show":
      ctx.ui.notify(formatConfig(readConfig(ctx.cwd)), "info");
      return;
    case "reset":
      writeConfig({}, cmd.scope, ctx.cwd);
      registry.refresh(ctx.cwd, "both");
      ctx.ui.notify(`Config reset (${cmd.scope}).`, "info");
      return;
    case "model":
      applyAgentOverride(ctx, cmd.scope, cmd.agent, (override) => {
        override.model = cmd.model;
      });
      ctx.ui.notify(`Set model for ${cmd.agent} to \`${cmd.model}\` (${cmd.scope}).`, "info");
      return;
    case "deny":
      applyAgentOverride(ctx, cmd.scope, cmd.agent, (override) => {
        override.denyTools = cmd.tools;
      });
      ctx.ui.notify(`Set denied tools for ${cmd.agent} to [${cmd.tools.join(", ")}] (${cmd.scope}).`, "info");
      return;
    case "menu":
      await runRootMenu(ctx, pi, registry);
      return;
  }
}

export function registerConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand("crew-of-pi", {
    description:
      "Manage crew-of-pi configuration: /crew-of-pi [menu | show | model <agent> <model> | deny <agent> <tools> | reset | help]",
    getArgumentCompletions: (prefix: string) =>
      computeArgumentCompletions(prefix, getAgentRegistry().getNames()),
    async handler(args: string, ctx: ExtensionCommandContext) {
      await handleConfigCommand(args, ctx, pi);
    },
  });
}
