/**
 * Config wizard — interactive wizards for per-agent config fields.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionOption, SkillOption } from "./config.types";
import { MAIN_AGENT_KEY } from "./config.types";
import { formatModelLabel, discoverExtensions, discoverSkills, getAgentNames, validateModel, validatePath } from "./config.helpers";
import { showModelSelector, type ModelOption } from "./config.model-selector";

// ─── Agent Picker ───────────────────────────────────────────────

export async function pickAgent(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const existing = getAgentNames();
  const options = [MAIN_AGENT_KEY, ...existing];
  if (options.length === 1) {
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
  return choice === MAIN_AGENT_KEY ? MAIN_AGENT_KEY : choice;
}

// ─── Field Picker ───────────────────────────────────────────────

export async function pickField(ctx: ExtensionCommandContext): Promise<string | undefined> {
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

export async function editModel(
  agentName: string,
  currentModel: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  // Get only models with configured auth
  const allModels = ctx.modelRegistry.getAvailable();

  const modelOptions: ModelOption[] = allModels
    .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`))
    .map((m) => ({
      value: `${m.provider}/${m.id}`,
      label: formatModelLabel(m),
      provider: m.provider,
      id: m.id,
      searchText: `${m.provider} ${m.id} ${m.name ?? ""} ${formatModelLabel(m)}`,
    }));

  // Add "keep current" option at the top if there's a current model
  if (currentModel) {
    modelOptions.unshift({
      value: currentModel,
      label: `🔄 ${currentModel} (current)`,
      provider: currentModel.split("/")[0] ?? "",
      id: currentModel.split("/").slice(1).join("/"),
      searchText: `${currentModel} current`,
    });
  }

  // Also prepend a separator with manual input option as first item
  const result = await showModelSelector(modelOptions, ctx);

  if (result === undefined) {
    // User cancelled — ask if they want manual input
    const manual = await ctx.ui.input(
      "Masukkan model ID manual (format: provider/model-id) atau kosongkan untuk batal:",
      currentModel || "",
    );
    if (!manual?.trim()) return undefined;
    const err = validateModel(manual.trim());
    if (err) { ctx.ui.notify(`❌ ${err}`, "error"); return undefined; }
    return manual.trim();
  }

  return result;
}

// ─── Extensions Editor ──────────────────────────────────────────

export async function editExtensions(
  agentName: string,
  currentExtensions: string[] | undefined,
  ctx: ExtensionCommandContext,
): Promise<string[] | undefined> {
  const working = new Set(currentExtensions ?? []);
  const installed = discoverExtensions();

  while (true) {
    const choice = await ctx.ui.select(
      `Extensions untuk "${agentName}" (${working.size} aktif):`,
      buildExtOptions(working, installed),
    );

    if (!choice || choice === "❌ Batal") return undefined;
    if (choice === "✅ Selesai — simpan perubahan") break;

    if (choice.startsWith("🗑️ Hapus extension")) {
      const toRemove = await pickRemoveExtension(working, installed, ctx);
      if (toRemove) working.delete(toRemove);
      continue;
    }

    if (choice === "📂 Tambah path/folder kustom") {
      const customPath = await ctx.ui.input("Masukkan path extension (absolute / ~/path / npm:... / git:...):", "");
      if (!customPath?.trim()) continue;
      const err = validatePath(customPath.trim());
      if (err) { ctx.ui.notify(`❌ ${err}`, "error"); continue; }
      working.add(customPath.trim());
      continue;
    }

    toggleChoice(choice, working, installed);
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
    for (const ext of notAdded) opts.push(`➕ ${ext.label}`);
    opts.push("───");
  }
  if (working.size > 0) { opts.push("🗑️ Hapus extension"); opts.push("───"); }
  opts.push("📂 Tambah path/folder kustom");
  opts.push("✅ Selesai — simpan perubahan", "❌ Batal");
  return opts;
}

// ─── Skills Editor ──────────────────────────────────────────────

export async function editSkills(
  agentName: string,
  currentSkills: string[] | undefined,
  ctx: ExtensionCommandContext,
): Promise<string[] | undefined> {
  const working = new Set(currentSkills ?? []);
  const installed = discoverSkills();

  while (true) {
    const choice = await ctx.ui.select(
      `Skills untuk "${agentName}" (${working.size} aktif):`,
      buildSkillOptions(working, installed),
    );

    if (!choice || choice === "❌ Batal") return undefined;
    if (choice === "✅ Selesai — simpan perubahan") break;

    if (choice.startsWith("🗑️ Hapus skill")) {
      const toRemove = await pickRemoveSkill(working, installed, ctx);
      if (toRemove) working.delete(toRemove);
      continue;
    }

    if (choice === "📂 Tambah path/folder kustom") {
      const customPath = await ctx.ui.input("Masukkan path folder skill (absolute atau ~/path):", "");
      if (!customPath?.trim()) continue;
      const expanded = customPath.startsWith("~") ? path.join(os.homedir(), customPath.slice(1)) : customPath.trim();
      if ((customPath.startsWith("/") || customPath.startsWith("~")) && !fs.existsSync(expanded)) {
        ctx.ui.notify(`❌ Path "${customPath}" tidak ditemukan`, "error");
        continue;
      }
      working.add(customPath.trim());
      continue;
    }

    toggleChoice(choice, working, installed);
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
    for (const skill of notAdded) opts.push(`➕ ${skill.label}`);
    opts.push("───");
  }
  if (working.size > 0) { opts.push("🗑️ Hapus skill"); opts.push("───"); }
  opts.push("📂 Tambah path/folder kustom");
  opts.push("✅ Selesai — simpan perubahan", "❌ Batal");
  return opts;
}

// ─── Shared Helpers ─────────────────────────────────────────────

async function pickRemoveExtension(
  working: Set<string>,
  installed: ExtensionOption[],
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const removable = Array.from(working).map((v) => {
    const found = installed.find((i) => i.value === v);
    return found ? `❌ ${found.label}` : `❌ ${v} (custom)`;
  });
  removable.push("❌ Batal");
  const toRemove = await ctx.ui.select("Pilih extension yang dihapus:", removable);
  if (!toRemove || toRemove === "❌ Batal") return undefined;
  return resolveLabelToValue(toRemove.replace(/^❌ /, ""), installed);
}

async function pickRemoveSkill(
  working: Set<string>,
  installed: SkillOption[],
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const removable = Array.from(working).map((v) => {
    const found = installed.find((i) => i.value === v);
    return found ? `❌ ${found.label}` : `❌ ${v} (custom)`;
  });
  removable.push("❌ Batal");
  const toRemove = await ctx.ui.select("Pilih skill yang dihapus:", removable);
  if (!toRemove || toRemove === "❌ Batal") return undefined;
  return resolveLabelToValue(toRemove.replace(/^❌ /, ""), installed);
}

function resolveLabelToValue(label: string, installed: { label: string; value: string }[]): string | undefined {
  const found = installed.find((i) => i.label === label);
  if (found) return found.value;
  const customMatch = label.match(/^(.+) \(custom\)$/);
  return customMatch ? customMatch[1] : undefined;
}

function toggleChoice(
  choice: string,
  working: Set<string>,
  installed: { label: string; value: string }[],
): void {
  const prefix = choice.startsWith("➕ ") ? "➕ " : "✅ ";
  const label = choice.replace(prefix, "");
  const found = installed.find((i) => i.label === label);
  if (found) {
    if (working.has(found.value)) working.delete(found.value);
    else working.add(found.value);
  } else {
    const customMatch = label.match(/^(.+) \(custom\)$/);
    if (customMatch) {
      if (working.has(customMatch[1])) working.delete(customMatch[1]);
      else working.add(customMatch[1]);
    }
  }
}
