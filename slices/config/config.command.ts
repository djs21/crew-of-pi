/**
 * /crew-of-pi slash command — interactive config editor for crew-of-pi.json
 *
 * Subcommands:
 *   /crew-of-pi config          — Interactive wizard (agent → field → edit)
 *   /crew-of-pi config show     — Show current config as plain text
 *   /crew-of-pi help            — Usage info
 *
 * For each agent, allows editing:
 *   - model:        pick from available models
 *   - extensions:   pick from installed extensions + custom path
 *   - skills:       pick from installed skills + custom path
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

// ─── Types ──────────────────────────────────────────────────────

interface AgentOverride {
  model?: string;
  extensions?: string[];
  skills?: string[];
  [key: string]: unknown;
}

interface CrewConfig {
  agents: Record<string, AgentOverride>;
}

// ─── Config Path ────────────────────────────────────────────────

function getConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "crew-of-pi.json");
}

// ─── Read/Write Config ──────────────────────────────────────────

function readConfig(): CrewConfig {
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as CrewConfig;
    if (parsed && typeof parsed === "object" && parsed.agents && typeof parsed.agents === "object") {
      return parsed;
    }
    return { agents: {} };
  } catch {
    return { agents: {} };
  }
}

function writeConfig(config: CrewConfig): boolean {
  const configPath = getConfigPath();
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return true;
  } catch (err) {
    return false;
  }
}

// ─── Discover Available Models ──────────────────────────────────

function formatModelLabel(model: { provider: string; id: string; name?: string }): string {
  const label = `${model.provider}/${model.id}`;
  if (model.name) {
    return `${model.name} (${label})`;
  }
  return label;
}

function getModelId(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

// ─── Discover Installed Extensions ──────────────────────────────

interface ExtensionOption {
  label: string;
  value: string;
  type: "pi-package" | "path";
}

function discoverExtensions(): ExtensionOption[] {
  const discovered: ExtensionOption[] = [];
  const seen = new Set<string>();

  // 1. Installed from ~/.pi/agent/extensions/ (folder-based)
  const extDir = path.join(os.homedir(), ".pi", "agent", "extensions");
  try {
    if (fs.existsSync(extDir)) {
      for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          const extPath = path.join(extDir, entry.name);
          // Check for config.json or index.ts as extension marker
          if (fs.existsSync(path.join(extPath, "index.ts")) || fs.existsSync(path.join(extPath, "config.json"))) {
            const label = `📦 ${entry.name} (local)`;
            discovered.push({ label, value: extPath, type: "path" });
            seen.add(extPath);
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 2. Pi packages from settings.json
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw) as { packages?: string[] };
      if (settings.packages && Array.isArray(settings.packages)) {
        for (const pkg of settings.packages) {
          if (!seen.has(pkg)) {
            const label = `📦 ${pkg}`;
            discovered.push({ label, value: pkg, type: "pi-package" });
            seen.add(pkg);
          }
        }
      }
    }
  } catch {
    // ignore
  }

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
              const label = `🧪 ${entry.name} (dev)`;
              discovered.push({ label, value: extPath, type: "path" });
              seen.add(key);
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }

  return discovered;
}

// ─── Discover Installed Skills ──────────────────────────────────

interface SkillOption {
  label: string;
  value: string;
}

function discoverSkills(): SkillOption[] {
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
  } catch {
    // ignore
  }

  return skills;
}

// ─── Get Agent Names ────────────────────────────────────────────

function getAgentNames(): string[] {
  const config = readConfig();
  return Object.keys(config.agents);
}

// ─── Validation ─────────────────────────────────────────────────

function validateModel(modelStr: string): string | null {
  if (!modelStr.includes("/")) {
    return 'Format model harus "provider/model-id" (contoh: 9r/worker)';
  }
  const parts = modelStr.split("/");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    return 'Format model tidak valid. Gunakan "provider/model-id"';
  }
  return null;
}

function validatePath(p: string): string | null {
  if (!p.startsWith("/") && !p.startsWith("~") && !p.startsWith("npm:") && !p.startsWith("git:") && !p.startsWith("pluthenplay:")) {
    return 'Path harus absolute (/path), home (~/path), atau pi package (npm:, git:)';
  }
  // Untuk path fisik, cek eksistensi
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

// ─── Interactive Wizards ────────────────────────────────────────

/**
 * Pick or type an agent name. Returns the agent name or undefined if cancelled.
 */
async function pickAgent(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const existing = getAgentNames();
  const options = [...existing];
  if (options.length === 0) {
    options.push("worker", "scout", "researcher", "planner", "reviewer");
  }
  options.push("✏️ Ketik nama agent baru...", "❌ Batal");

  const choice = await ctx.ui.select("Pilih agent:", options);
  if (!choice || choice === "❌ Batal") return undefined;
  if (choice === "✏️ Ketik nama agent baru...") {
    const name = await ctx.ui.input("Nama agent:", "contoh: worker");
    if (!name?.trim()) return undefined;
    return name.trim();
  }
  return choice;
}

async function pickField(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const choice = await ctx.ui.select("Pilih field yang ingin diedit:", [
    "🤖 model — Pilih model untuk agent ini",
    "🧩 extensions — Tambah/hapus extension",
    "🛠️ skills — Tambah/hapus skills",
    "👀 Lihat konfigurasi saat ini",
    "❌ Batal",
  ]);
  if (!choice || choice === "❌ Batal") return undefined;
  if (choice.startsWith("🤖")) return "model";
  if (choice.startsWith("🧩")) return "extensions";
  if (choice.startsWith("🛠️")) return "skills";
  if (choice.startsWith("👀")) return "show";
  return undefined;
}

// ─── Model Editor ───────────────────────────────────────────────

async function editModel(
  agentName: string,
  currentModel: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  // Get all available models from registry
  const allModels = ctx.modelRegistry.getAll();
  const modelOptions = allModels
    .sort((a, b) => {
      const aLabel = `${a.provider}/${a.id}`;
      const bLabel = `${b.provider}/${b.id}`;
      return aLabel.localeCompare(bLabel);
    })
    .map((m) => formatModelLabel(m));

  // Prepend current if set
  const selectOptions: string[] = [];
  if (currentModel) {
    selectOptions.push(`🔄 ${currentModel} (current)`);
  }
  selectOptions.push(...modelOptions);
  selectOptions.push("✏️ Ketik manual (provider/model-id)", "❌ Batal");

  const choice = await ctx.ui.select(
    `Pilih model untuk agent "${agentName}"${currentModel ? ` (current: ${currentModel})` : ""}:`,
    modelOptions.length > 200
      ? // If too many models, ask user to type instead
        ["✏️ Ketik manual (provider/model-id)", "❌ Batal"]
      : selectOptions,
  );

  if (!choice || choice === "❌ Batal") return undefined;

  if (choice.startsWith("🔄")) {
    // Keep current — extract model from "(current)" text
    const match = choice.match(/🔄 (.+) \(current\)/);
    return match ? match[1] : currentModel;
  }

  if (choice === "✏️ Ketik manual (provider/model-id)") {
    const manual = await ctx.ui.input(
      "Masukkan model ID (format: provider/model-id):",
      currentModel || "contoh: 9r/worker",
    );
    if (!manual?.trim()) return undefined;
    const err = validateModel(manual.trim());
    if (err) {
      ctx.ui.notify(`❌ ${err}`, "error");
      return undefined;
    }
    return manual.trim();
  }

  // Extract model from label — format "Name (provider/id)"
  const parenMatch = choice.match(/\((.+)\)$/);
  if (parenMatch) {
    return parenMatch[1];
  }

  // Fallback: just use the whole choice as model id
  return choice.trim();
}

// ─── Extensions Editor ──────────────────────────────────────────

async function editExtensions(
  agentName: string,
  currentExtensions: string[] | undefined,
  ctx: ExtensionCommandContext,
): Promise<string[] | undefined> {
  const currentSet = new Set(currentExtensions ?? []);

  const installed = discoverExtensions();
  const selectOptions: string[] = [];

  // Show current extensions first
  if (currentExtensions && currentExtensions.length > 0) {
    selectOptions.push("━ Current extensions ─");
    for (const ext of currentExtensions) {
      const found = installed.find((i) => i.value === ext);
      if (found) {
        selectOptions.push(`✅ ${found.label}`);
      } else {
        selectOptions.push(`✅ ${ext} (custom)`);
      }
    }
    selectOptions.push("───");
  }

  // Show available to add
  const notAdded = installed.filter((i) => !currentSet.has(i.value));
  if (notAdded.length > 0) {
    selectOptions.push("━ Available extensions — pilih untuk tambah ─");
    for (const ext of notAdded) {
      selectOptions.push(`➕ ${ext.label}`);
    }
    selectOptions.push("───");
  }

  // Actions for removing
  if (currentExtensions && currentExtensions.length > 0) {
    selectOptions.push("🗑️ Hapus extension", "───");
  }

  selectOptions.push("📂 Tambah path/folder kustom");
  selectOptions.push("✅ Selesai — simpan perubahan");
  selectOptions.push("❌ Batal");

  // Multi-step: loop until they say "done"
  const working = new Set(currentExtensions ?? []);

  while (true) {
    const choice = await ctx.ui.select(
      `Extensions untuk "${agentName}" (${working.size} aktif):`,
      // Build dynamic options based on current working state
      buildExtOptions(working, installed),
    );

    if (!choice || choice === "❌ Batal") return undefined;
    if (choice === "✅ Selesai — simpan perubahan") break;

    if (choice.startsWith("🗑️ Hapus extension")) {
      // Show removable extensions
      const removable = Array.from(working).map((v) => {
        const found = installed.find((i) => i.value === v);
        return found ? `❌ ${found.label}` : `❌ ${v} (custom)`;
      });
      removable.push("❌ Batal");
      const toRemove = await ctx.ui.select("Pilih extension yang dihapus:", removable);
      if (!toRemove || toRemove === "❌ Batal") continue;
      // Extract value from label
      const removedLabel = toRemove.replace(/^❌ /, "");
      const found = installed.find((i) => i.label === removedLabel);
      if (found) {
        working.delete(found.value);
      } else {
        // Try matching by custom label
        const customMatch = removedLabel.match(/^(.+) \(custom\)$/);
        if (customMatch) {
          working.delete(customMatch[1]);
        }
      }
      continue;
    }

    if (choice === "📂 Tambah path/folder kustom") {
      const customPath = await ctx.ui.input(
        "Masukkan path extension (absolute / ~/path / npm:... / git:...):",
        "",
      );
      if (!customPath?.trim()) continue;
      const err = validatePath(customPath.trim());
      if (err) {
        ctx.ui.notify(`❌ ${err}`, "error");
        continue;
      }
      working.add(customPath.trim());
      continue;
    }

    // Toggle extension: if it starts with ➕, add it
    if (choice.startsWith("➕ ")) {
      const label = choice.replace(/^➕ /, "");
      const found = installed.find((i) => i.label === label);
      if (found) {
        if (working.has(found.value)) {
          working.delete(found.value);
        } else {
          working.add(found.value);
        }
      }
      continue;
    }

    // Toggle: if it starts with ✅, remove it
    if (choice.startsWith("✅ ")) {
      const label = choice.replace(/^✅ /, "");
      const found = installed.find((i) => i.label === label);
      if (found) {
        working.delete(found.value);
      } else {
        // Custom entry
        const customMatch = label.match(/^(.+) \(custom\)$/);
        if (customMatch) {
          working.delete(customMatch[1]);
        }
      }
      continue;
    }
  }

  return Array.from(working);
}

function buildExtOptions(working: Set<string>, installed: ExtensionOption[]): string[] {
  const opts: string[] = [];
  if (working.size > 0) {
    opts.push("━ Active ─");
    for (const v of working) {
      const found = installed.find((i) => i.value === v);
      opts.push(found ? `✅ ${found.label}` : `✅ ${v} (custom)`);
    }
    opts.push("───");
  }

  const notAdded = installed.filter((i) => !working.has(i.value));
  if (notAdded.length > 0) {
    opts.push("━ Available — pilih untuk tambah ─");
    for (const ext of notAdded) {
      opts.push(`➕ ${ext.label}`);
    }
    opts.push("───");
  }

  if (working.size > 0) {
    opts.push("🗑️ Hapus extension");
    opts.push("───");
  }

  opts.push("📂 Tambah path/folder kustom");
  opts.push("✅ Selesai — simpan perubahan");
  opts.push("❌ Batal");
  return opts;
}

// ─── Skills Editor ──────────────────────────────────────────────

async function editSkills(
  agentName: string,
  currentSkills: string[] | undefined,
  ctx: ExtensionCommandContext,
): Promise<string[] | undefined> {
  const currentSet = new Set(currentSkills ?? []);
  const installed = discoverSkills();

  const working = new Set(currentSkills ?? []);

  while (true) {
    const choice = await ctx.ui.select(
      `Skills untuk "${agentName}" (${working.size} aktif):`,
      buildSkillOptions(working, installed),
    );

    if (!choice || choice === "❌ Batal") return undefined;
    if (choice === "✅ Selesai — simpan perubahan") break;

    if (choice.startsWith("🗑️ Hapus skill")) {
      const removable = Array.from(working).map((v) => {
        const found = installed.find((i) => i.value === v);
        return found ? `❌ ${found.label}` : `❌ ${v} (custom)`;
      });
      removable.push("❌ Batal");
      const toRemove = await ctx.ui.select("Pilih skill yang dihapus:", removable);
      if (!toRemove || toRemove === "❌ Batal") continue;
      const removedLabel = toRemove.replace(/^❌ /, "");
      const found = installed.find((i) => i.label === removedLabel);
      if (found) {
        working.delete(found.value);
      } else {
        const customMatch = removedLabel.match(/^(.+) \(custom\)$/);
        if (customMatch) {
          working.delete(customMatch[1]);
        }
      }
      continue;
    }

    if (choice === "📂 Tambah path/folder kustom") {
      const customPath = await ctx.ui.input(
        "Masukkan path folder skill (absolute atau ~/path):",
        "",
      );
      if (!customPath?.trim()) continue;
      const expanded = customPath.startsWith("~")
        ? path.join(os.homedir(), customPath.slice(1))
        : customPath.trim();
      if (customPath.startsWith("/") || customPath.startsWith("~")) {
        if (!fs.existsSync(expanded)) {
          ctx.ui.notify(`❌ Path "${customPath}" tidak ditemukan`, "error");
          continue;
        }
      }
      working.add(customPath.trim());
      continue;
    }

    // Toggle from available
    if (choice.startsWith("➕ ")) {
      const label = choice.replace(/^➕ /, "");
      const found = installed.find((i) => i.label === label);
      if (found) {
        if (working.has(found.value)) {
          working.delete(found.value);
        } else {
          working.add(found.value);
        }
      }
      continue;
    }

    // Toggle from active
    if (choice.startsWith("✅ ")) {
      const label = choice.replace(/^✅ /, "");
      const found = installed.find((i) => i.label === label);
      if (found) {
        working.delete(found.value);
      } else {
        const customMatch = label.match(/^(.+) \(custom\)$/);
        if (customMatch) {
          working.delete(customMatch[1]);
        }
      }
      continue;
    }
  }

  return Array.from(working);
}

function buildSkillOptions(working: Set<string>, installed: SkillOption[]): string[] {
  const opts: string[] = [];
  if (working.size > 0) {
    opts.push("━ Active ─");
    for (const v of working) {
      const found = installed.find((i) => i.value === v);
      opts.push(found ? `✅ ${found.label}` : `✅ ${v} (custom)`);
    }
    opts.push("───");
  }

  const notAdded = installed.filter((i) => !working.has(i.value));
  if (notAdded.length > 0) {
    opts.push("━ Available — pilih untuk tambah ─");
    for (const skill of notAdded) {
      opts.push(`➕ ${skill.label}`);
    }
    opts.push("───");
  }

  if (working.size > 0) {
    opts.push("🗑️ Hapus skill");
    opts.push("───");
  }

  opts.push("📂 Tambah path/folder kustom");
  opts.push("✅ Selesai — simpan perubahan");
  opts.push("❌ Batal");
  return opts;
}

// ─── Show Config ────────────────────────────────────────────────

function formatConfig(config: CrewConfig): string {
  const lines: string[] = ["## crew-of-pi.json Config\n"];
  const agentNames = Object.keys(config.agents);
  if (agentNames.length === 0) {
    lines.push("No agents configured.");
  } else {
    for (const name of agentNames) {
      const agent = config.agents[name];
      lines.push(`### ${name}`);
      lines.push(`- model: ${agent.model ?? "(default)"}`);
      lines.push(`- extensions: ${agent.extensions?.length ? agent.extensions.join(", ") : "(none)"}`);
      lines.push(`- skills: ${agent.skills?.length ? agent.skills.join(", ") : "(none)"}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ─── Show Help ──────────────────────────────────────────────────

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
    "**Lokasi config:** `~/.pi/agent/crew-of-pi.json`",
  ].join("\n");
}

// ─── Config Command Handler ─────────────────────────────────────

async function handleConfigSubcommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();

  // /crew-of-pi config show
  if (trimmed === "show") {
    const config = readConfig();
    const formatted = formatConfig(config);
    // Send as steer message so user sees it
    ctx.ui.notify(formatted, "info");
    return;
  }

  // /crew-of-pi config <agent-name> <field> — direct mode
  const parts = trimmed.split(/\s+/);
  const directAgentName = parts[0] && !["show", "help"].includes(parts[0]) ? parts[0] : undefined;
  const directField = parts[1] && ["model", "extensions", "skills"].includes(parts[1]) ? parts[1] : undefined;

  const config = readConfig();

  if (directAgentName && directField) {
    // Direct edit mode: skip agent & field picker
    await editFieldForAgent(config, directAgentName, directField, ctx);
    return;
  }

  // ─── Interactive Wizard ─────────────────────────────────────

  // Step 1: Pick agent
  const agentName = await pickAgent(ctx);
  if (!agentName) return;

  // Step 2: Pick field
  const field = await pickField(ctx);
  if (!field) return;
  if (field === "show") {
    const config = readConfig();
    ctx.ui.notify(`Konfigurasi untuk "${agentName}":\n${formatAgentConfig(config, agentName)}`, "info");
    return;
  }

  await editFieldForAgent(config, agentName, field, ctx);
}

async function editFieldForAgent(
  config: CrewConfig,
  agentName: string,
  field: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const agent = config.agents[agentName] ?? (config.agents[agentName] = {});

  if (field === "model") {
    const newModel = await editModel(agentName, agent.model, ctx);
    if (newModel === undefined) return; // cancelled
    agent.model = newModel;
  } else if (field === "extensions") {
    const newExtensions = await editExtensions(agentName, agent.extensions, ctx);
    if (newExtensions === undefined) return; // cancelled
    agent.extensions = newExtensions.length > 0 ? newExtensions : undefined;
  } else if (field === "skills") {
    const newSkills = await editSkills(agentName, agent.skills, ctx);
    if (newSkills === undefined) return; // cancelled
    agent.skills = newSkills.length > 0 ? newSkills : undefined;
  }

  const success = writeConfig(config);
  if (success) {
    ctx.ui.notify(`✅ Config untuk "${agentName}" berhasil disimpan!`, "info");
    ctx.ui.notify(`ℹ️ Restart session agar perubahan berlaku (Ctrl+D lalu /start)`, "info");
  } else {
    ctx.ui.notify(`❌ Gagal menyimpan config! Periksa permissions.`, "error");
  }
}

function formatAgentConfig(config: CrewConfig, agentName: string): string {
  const agent = config.agents[agentName];
  if (!agent) return "Belum ada konfigurasi.";
  const lines: string[] = [];
  lines.push(`model: ${agent.model ?? "(default)"}`);
  lines.push(`extensions: ${agent.extensions?.length ? agent.extensions.join(", ") : "(none)"}`);
  lines.push(`skills: ${agent.skills?.length ? agent.skills.join(", ") : "(none)"}`);
  return lines.join("\n");
}

// ─── Main Command Handler ───────────────────────────────────────

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

  // Unknown subcommand
  ctx.ui.notify(`Unknown subcommand: "${trimmed}". Gunakan /crew-of-pi help`, "error");
}

// ─── Argument Completions ───────────────────────────────────────

function getArgumentCompletions(argumentPrefix: string): { label: string; detail?: string }[] | null {
  const prefix = argumentPrefix.toLowerCase();

  if (prefix === "" || "config".startsWith(prefix)) {
    return [
      { label: "config", detail: "Edit crew-of-pi.json config interactively" },
      { label: "config show", detail: "Show current config" },
      { label: "help", detail: "Show usage information" },
    ];
  }

  if ("config ".startsWith(prefix) || prefix.startsWith("config ")) {
    const sub = prefix.startsWith("config ") ? prefix.slice(7) : "";

    // Agent name completion
    const agentNames = getAgentNames();
    const agentCompletions = agentNames.map((name) => ({
      label: `config ${name}`,
      detail: `Configure agent "${name}"`,
    }));

    // Field completions
    const fieldCompletions = ["model", "extensions", "skills"].map((field) => ({
      label: `config <agent> ${field}`,
      detail: `Edit ${field}`,
    }));

    if (!sub || agentNames.some((n) => n.startsWith(sub))) {
      const matching = agentNames.filter((n) => n.startsWith(sub));
      return matching.length > 0
        ? matching.map((n) => ({ label: `config ${n}`, detail: `Configure agent "${n}"` }))
        : [{ label: "config show", detail: "Show current config" }, ...agentCompletions, ...fieldCompletions];
    }

    // If first word after "config " looks like an agent name, suggest fields
    const firstArg = sub.split(/\s+/)[0];
    if (firstArg && agentNames.includes(firstArg)) {
      const fieldPrefix = sub.split(/\s+/)[1] || "";
      return ["model", "extensions", "skills"]
        .filter((f) => f.startsWith(fieldPrefix))
        .map((f) => ({ label: `config ${firstArg} ${f}`, detail: `Edit ${f} for "${firstArg}"` }));
    }
  }

  return null;
}

// ─── Registration ───────────────────────────────────────────────

export function registerConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand("crew-of-pi", {
    description: "Manage crew-of-pi config — model, extensions, skills per agent",
    handler: handleCrewOfPiCommand,
    getArgumentCompletions,
  } as Omit<RegisteredCommand, "name" | "sourceInfo">);
}
