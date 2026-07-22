/**
 * crew-of-pi: Async Non-Blocking Subagent Orchestration Extension
 *
 * Entry point — imports & mounts all vertical slices.
 * Each slice is self-contained. To add/remove a feature, add/remove one import.
 */

import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

// ─── Agent Discovery ────────────────────────────────────────────
import { getAgentRegistry, resetAgentRegistry } from "./slices/agents/agents.registry";
import { loadCrewConfig, setBundledAgentsDir } from "./slices/agents/agents.discovery";

// ─── Spawn ──────────────────────────────────────────────────────
import { registerSpawnTool, setSpawnInfra } from "./slices/spawn/spawn.tool";
import { SubagentDb } from "./slices/spawn/spawn.db";
import { getWidgetStore, resetWidgetStore } from "./slices/widget/widget.store";

// ─── Blockers ───────────────────────────────────────────────────
import { DEFAULT_MAIN_AGENT_DISABLED_TOOLS } from "./slices/blockers/blockers.types";
import { registerBlocker, setBlockPolicy } from "./slices/blockers/blockers.intercept";

// ─── Prompt ─────────────────────────────────────────────────────
import { registerPromptInjector, setPromptConfig } from "./slices/prompt/prompt.injector";

// ─── Chain ──────────────────────────────────────────────────────
import { registerChainTool } from "./slices/chain/chain.tool";

// ─── Comms ──────────────────────────────────────────────────────
import { getMessageBus, resetMessageBus, registerCommsRelay, initMessageBus } from "./slices/comms/comms";

// ─── Lifecycle ──────────────────────────────────────────────────
import { registerAbortTool } from "./slices/lifecycle/lifecycle.abort";
import { registerRespondTool } from "./slices/lifecycle/lifecycle.respond";
import { registerDoneTool } from "./slices/lifecycle/lifecycle.done";

// ─── Crew List ─────────────────────────────────────────────────
import { registerCrewListTool } from "./slices/crew-list/crew-list.tool";
import { registerLogTool, registerInjectTool } from "./slices/spawn/spawn.monitor";

// ─── Config Command ─────────────────────────────────────────────
import { registerConfigCommand } from "./slices/config/config.command";

// ─── Widget ─────────────────────────────────────────────────────
import { registerWidgetUpdater } from "./slices/widget/widget.updater";

export default function (pi: ExtensionAPI) {
  // ─── Init: Bundled Agents Path ─────────────────────────────
  // jiti provides CommonJS compat: __dirname always available
  const extensionDir = __dirname;
  const bundledAgentsPath = path.join(extensionDir, "agents");
  setBundledAgentsDir(bundledAgentsPath);

  // ─── Init: Session Start (discover agents + restore state) ──
  pi.on("session_start", async (_event, ctx) => {
    const registry = getAgentRegistry();
    registry.refresh(ctx.cwd, "both");

    // Ensure bundled agents dir is set
    setBundledAgentsDir(bundledAgentsPath);

    // Refresh with bundled agents
    registry.refresh(ctx.cwd, "both");

    // Init shared DB (single connection)
    const projectHash = crypto.createHash("sha256").update(ctx.cwd).digest("hex").slice(0, 12);
    const dbPath = path.join(homedir(), ".local", "share", "pi", `crew-of-pi-${projectHash}.db`);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");

    // Init shared instances
    initMessageBus(db);
    registerCommsRelay(pi);
    const subagentDb = new SubagentDb(db);

    // Orphan stale sessions from previous runs
    const orphaned = subagentDb.orphanStaleSessions();
    if (orphaned > 0) {
      ctx.ui.notify(`Found ${orphaned} stale sub-agent(s) from previous session`, "warning");
    }

    // Restore surviving handles from DB
    registry.setDb(subagentDb);
    await registry.restoreFromDb();

    // Store spawn infrastructure for subagent sessions
    setSpawnInfra({
      modelRegistry: ctx.modelRegistry,
      modelRuntime: ctx.modelRegistry['runtime'],
      agentDir: getAgentDir(),
      extensionDir: bundledAgentsPath,
      subagentDb,
    });

    // Load main agent tool config from crew-of-pi.json
    const crewConfig = loadCrewConfig(ctx.cwd);
    const disabledTools = crewConfig?.mainAgent?.disabledTools ?? DEFAULT_MAIN_AGENT_DISABLED_TOOLS;

    setBlockPolicy({
      blockedTools: disabledTools.map((toolName) => ({
        toolName,
        reason: `Main agent is orchestrator-only. Tool "${toolName}" is disabled via crew-of-pi.json config.`,
      })),
      allowBashReadOnly: !disabledTools.includes("bash"),
    });

    // Set prompt config
    setPromptConfig({
      enabled: true,
      includeAgentDescriptions: true,
      includeAgentExtensions: true,
      includeAgentSkills: true,
      includeRules: true,
    });


    // Display discovery warnings as notifications
    for (const warning of registry.getUnshownWarnings()) {
      ctx.ui.notify(`${warning.message} (${warning.filePath})`, "error");
    }

  });

  // ─── Init: Session Shutdown (cleanup) ───────────────────────
  pi.on("session_shutdown", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const registry = getAgentRegistry();

    // Dispose owned subagent sessions (session-based, no more PID kill)
    for (const handle of registry.getRunning()) {
      if (handle.ownerSession === sessionId) {
        if (handle.session) {
          try { handle.session.dispose(); } catch { /* already disposed */ }
        }
      }
    }

    resetAgentRegistry();
    resetMessageBus();
    resetWidgetStore();
    // DB connection is intentionally NOT closed here — it's a singleton
    // that could be reused. Process exit will clean it up.
  });

  // ─── Register Tools ─────────────────────────────────────────
  registerSpawnTool(pi);

  registerChainTool(pi);

  registerAbortTool(pi);
  registerRespondTool(pi);
  registerDoneTool(pi);
  registerCrewListTool(pi);
  registerLogTool(pi);
  registerInjectTool(pi);

  // ─── Register Commands ──────────────────────────────────────
  registerConfigCommand(pi);

  // ─── Register Events ────────────────────────────────────────
  registerBlocker(pi);
  registerPromptInjector(pi);
  registerWidgetUpdater(pi);
}