/**
 * crew-of-pi: Async Non-Blocking Subagent Orchestration Extension
 *
 * Entry point — mounts all consolidated slices:
 * - agents (discovery, registry, crew_list)
 * - spawn (process session management, crew_spawn, crew_log, crew_inject)
 * - chain (sequential agent execution, crew_chain)
 * - lifecycle (crew_abort, crew_respond, crew_done)
 * - prompt (system prompt injection)
 * - widget (TUI live monitoring)
 * - config (/crew-of-pi slash command)
 * - db (SQLite persistence)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  findAgent,
  getAgentRegistry,
  registerCrewListTool,
  resetAgentRegistry,
} from "./slices/agents";
import { registerChainTool } from "./slices/chain";
import { registerConfigCommand } from "./slices/config";
import { SubagentDb, initDb } from "./slices/db";
import {
  registerAbortTool,
  registerDoneTool,
  registerRespondTool,
} from "./slices/lifecycle";
import { registerPromptInjector } from "./slices/prompt";
import {
  registerInjectTool,
  registerLogTool,
  registerSpawnTool,
  setSpawnInfra,
} from "./slices/spawn";
import { registerWidgetUpdater } from "./slices/widget";

export default function (pi: ExtensionAPI) {
  const extensionDir = __dirname;

  // Session start lifecycle
  pi.on("session_start", async (_event, ctx) => {
    const registry = getAgentRegistry();
    registry.refresh(ctx.cwd, "both");

    // Init SQLite database
    const projectHash = crypto
      .createHash("sha256")
      .update(ctx.cwd)
      .digest("hex")
      .slice(0, 12);
    const dbPath = path.join(
      homedir(),
      ".local",
      "share",
      "pi",
      `crew-of-pi-${projectHash}.db`,
    );
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    const { subagentDb } = initDb(db);
    const orphaned = subagentDb.orphanStaleSessions();
    if (orphaned > 0) {
      ctx.ui.notify(
        `Found ${orphaned} stale subagent session(s) from previous run`,
        "warning",
      );
    }

    registry.setDb(subagentDb);
    await registry.restoreFromDb();

    // Spawn infrastructure
    setSpawnInfra({
      modelRegistry: ctx.modelRegistry,
      modelRuntime: (ctx.modelRegistry as any)["runtime"],
      agentDir: getAgentDir(),
      extensionDir,
      subagentDb,
    });

    for (const warning of registry.getWarnings()) {
      ctx.ui.notify(`${warning.message} (${warning.filePath})`, "error");
    }
  });

  // Session shutdown lifecycle
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const registry = getAgentRegistry();

    for (const handle of registry.getRunning()) {
      if (handle.ownerSession === sessionId && handle.session) {
        try {
          handle.session.dispose();
        } catch {
          // Ignore if already disposed
        }
      }
    }

    resetAgentRegistry();
  });

  // Register tools
  registerSpawnTool(pi);
  registerChainTool(pi);
  registerAbortTool(pi);
  registerRespondTool(pi);
  registerDoneTool(pi);
  registerCrewListTool(pi);
  registerLogTool(pi);
  registerInjectTool(pi);

  // Register commands
  registerConfigCommand(pi);

  // Register hooks
  registerPromptInjector(pi);
  registerWidgetUpdater(pi);
}
