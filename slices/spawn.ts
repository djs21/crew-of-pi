/**
 * spawn.ts — Subagent process spawn lifecycle manager and monitoring tools.
 * Uses pi SDK `createAgentSession` for in-process session management.
 * Subagents inherit all user extensions, but crew-of-pi / crew_* tools are omitted to prevent recursion.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  type AgentSessionEvent,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type {
  AgentConfig,
  AgentScope,
  SubagentHandle,
  SubagentStatus,
  TranscriptEntry,
  UsageStats,
} from "../shared/types";
import { generateId, INITIAL_USAGE, MAX_CONCURRENCY } from "../shared/types";
import { findAgent, getAgentRegistry } from "./agents";
import { type SubagentDb, getSubagentDb } from "./db";
import { validateOwnership } from "./lifecycle";
import { syncWidgetFromRegistry } from "./widget";

// ─── Spawn Infrastructure ──────────────────────────────────────────

export interface SpawnInfra {
  modelRegistry: ModelRegistry;
  modelRuntime?: any;
  agentDir: string;
  extensionDir: string;
  subagentDb: SubagentDb;
}

let _infra: SpawnInfra | undefined;

export function setSpawnInfra(infra: SpawnInfra): void {
  _infra = infra;
}

export function getSpawnInfra(): SpawnInfra | undefined {
  return _infra;
}

// ─── Concurrency Limiter ───────────────────────────────────────────

class ConcurrencyTracker {
  private active = 0;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENCY) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  get activeCount(): number {
    return this.active;
  }
}

const concurrencyTracker = new ConcurrencyTracker();

// ─── Helpers ───────────────────────────────────────────────────────

function getLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") return msg as AssistantMessage;
  }
  return undefined;
}

function getAssistantText(message: AssistantMessage | undefined): string | undefined {
  if (!message) return undefined;
  const texts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") texts.push(part.text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function taskPreview(task: string, maxLen = 50): string {
  if (task.length <= maxLen) return task;
  return task.slice(0, maxLen).trimEnd() + "…";
}

function resolveModel(
  agentConfig: AgentConfig,
  modelRegistry: ModelRegistry,
): { model: Model<Api> | undefined; warning?: string } {
  if (!agentConfig.model) return { model: undefined };
  const slashIdx = agentConfig.model.indexOf("/");
  if (slashIdx === -1) return { model: undefined, warning: `Invalid model "${agentConfig.model}"` };
  const provider = agentConfig.model.slice(0, slashIdx).trim();
  const modelId = agentConfig.model.slice(slashIdx + 1).trim();
  if (!provider || !modelId) return { model: undefined, warning: `Invalid model "${agentConfig.model}"` };
  const found = modelRegistry.find(provider, modelId);
  if (!found) return { model: undefined, warning: `Model "${agentConfig.model}" not found, using session default` };
  return { model: found };
}

/**
 * Resource loader: subagents inherit user extensions, but crew-of-pi itself is filtered out to prevent infinite recursion.
 */
function createSubagentResourceLoader(
  agentConfig: AgentConfig,
  cwd: string,
  infra: { agentDir: string; extensionDir: string },
): DefaultResourceLoader {
  const additionalPaths: string[] = [];
  for (const ext of agentConfig.extensions) {
    if (ext.type === "path" && ext.resolved) {
      additionalPaths.push(ext.resolved);
    } else if (ext.type === "pi-package") {
      const stripped = ext.value.replace(/^(git:|npm:)/, "");
      let pkgPath: string | null = null;
      if (ext.value.startsWith("git:")) {
        pkgPath = path.join(infra.agentDir, "git", stripped);
      } else if (ext.value.startsWith("npm:")) {
        const npmDir = path.join(infra.agentDir, "packages", stripped);
        const extDir = path.join(infra.agentDir, "extensions", stripped.split("/").pop() ?? stripped);
        pkgPath = fs.existsSync(npmDir) ? npmDir : fs.existsSync(extDir) ? extDir : null;
      }
      if (pkgPath && fs.existsSync(pkgPath)) {
        additionalPaths.push(pkgPath);
      }
    }
  }

  return new DefaultResourceLoader({
    cwd,
    agentDir: infra.agentDir,
    additionalExtensionPaths: additionalPaths.length > 0 ? additionalPaths : undefined,
    additionalSkillPaths: agentConfig.skills && agentConfig.skills.length > 0 ? agentConfig.skills : undefined,
    extensionsOverride: (base) => {
      // Exclude crew-of-pi extension to prevent recursion, keep all other extensions intact
      return {
        ...base,
        extensions: base.extensions.filter((ext) => {
          if (infra.extensionDir && ext.resolvedPath.startsWith(infra.extensionDir)) return false;
          return true;
        }),
      };
    },
  });
}

export interface SpawnSessionResult {
  output: string;
  exitCode: number;
  sessionFile?: string;
}

export async function spawnSubagentSession(
  agentConfig: AgentConfig,
  task: string,
  abortSignal: AbortSignal | undefined,
  cwd: string,
  handle: SubagentHandle,
  onProgress?: (turns: number, status: SubagentStatus, usage: UsageStats) => void,
  sessionFile?: string,
  parentSessionFile?: string,
): Promise<SpawnSessionResult> {
  const infra = getSpawnInfra();
  if (!infra) {
    return { output: "Spawn infra not initialized", exitCode: 1 };
  }

  const { model, warning: modelWarning } = resolveModel(agentConfig, infra.modelRegistry);
  if (modelWarning) {
    console.warn(`[crew-of-pi] ${modelWarning}`);
  }

  let sessionManager: SessionManager;
  if (sessionFile) {
    sessionManager = SessionManager.open(sessionFile);
  } else if (parentSessionFile) {
    sessionManager = SessionManager.forkFrom(parentSessionFile, cwd);
  } else {
    sessionManager = SessionManager.inMemory(cwd);
  }

  const resourceLoader = createSubagentResourceLoader(agentConfig, cwd, infra);

  const sessionAbortController = new AbortController();
  handle.abortController = sessionAbortController;

  const onParentAbort = () => sessionAbortController.abort();
  if (abortSignal) {
    abortSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  let session: AgentSession;
  try {
    const sessionResult = await createAgentSession({
      resourceLoader,
      sessionManager,
      model,
      thinkingLevel: (agentConfig.thinking as any) ?? undefined,
    });
    session = sessionResult.session;
  } catch (err: any) {
    return { output: `Failed to create agent session: ${err.message}`, exitCode: 1 };
  }

  handle.session = session;
  handle.sessionFile = sessionManager.getSessionFile();

  const transcript: TranscriptEntry[] = [];
  handle._transcript = transcript;

  const currentUsage: UsageStats = { ...INITIAL_USAGE };
  let lastHeartbeatTime = 0;

  const maybeHeartbeat = (status: SubagentStatus = "running") => {
    const now = Date.now();
    if (now - lastHeartbeatTime >= 5000 || handle.turns % 5 === 0) {
      lastHeartbeatTime = now;
      infra.subagentDb.upsertStatus(handle.id, {
        turns: handle.turns,
        usage_context_tokens: currentUsage.contextTokens,
        last_heartbeat: now,
        updated_at: now,
        status,
      });
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case "turn_start":
        handle.turns++;
        handle.status = "running";
        currentUsage.turns = handle.turns;
        maybeHeartbeat("running");
        infra.subagentDb.insertEvent(handle.id, "turn_start", "running", handle.turns, currentUsage.contextTokens);
        onProgress?.(handle.turns, "running", currentUsage);
        break;
      case "turn_end": {
        handle.status = "running";
        const msg = (event as any).message;
        if (msg && msg.role === "assistant" && msg.usage) {
          const u = msg.usage;
          currentUsage.input += u.input ?? 0;
          currentUsage.output += u.output ?? 0;
          currentUsage.cacheRead += u.cacheRead ?? 0;
          currentUsage.cacheWrite += u.cacheWrite ?? 0;
          currentUsage.cost += u.cost?.total ?? 0;
          currentUsage.contextTokens = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0);
        }
        maybeHeartbeat("running");
        infra.subagentDb.insertEvent(handle.id, "turn_end", "running", handle.turns, currentUsage.contextTokens);
        onProgress?.(handle.turns, "running", currentUsage);
        break;
      }
      case "tool_execution_start": {
        const toolName = (event as any).toolName || (event as any).tool?.name || (event as any).name || "tool";
        handle._tool = toolName;
        onProgress?.(handle.turns, "running", currentUsage);
        transcript.push({
          type: "tool_output",
          toolName,
          content: `Called tool: ${toolName}`,
          timestamp: Date.now(),
        });
        break;
      }
      case "tool_execution_end": {
        handle._tool = undefined;
        onProgress?.(handle.turns, "running", currentUsage);
        const toolName = (event as any).toolName || (event as any).tool?.name || (event as any).name || "tool";
        transcript.push({
          type: "tool_result",
          toolName,
          content: String(event.result ?? ""),
          timestamp: Date.now(),
          isError: event.isError,
        });
        break;
      }
    }
  });

  const subagentTask = agentConfig.systemPrompt
    ? `${agentConfig.systemPrompt}\n\nTask:\n${task}`
    : task;

  try {
    handle.status = "running";
    infra.subagentDb.upsertStatus(handle.id, {
      status: "running",
      session_file: handle.sessionFile ?? null,
      last_heartbeat: Date.now(),
      updated_at: Date.now(),
    });

    await session.prompt(subagentTask);

    const messages = session.messages as AgentMessage[];
    const lastAssistant = getLastAssistantMessage(messages);
    const outputText = getAssistantText(lastAssistant) ?? "(no output generated)";

    handle.status = "completed";
    handle.usage = { ...currentUsage };

    infra.subagentDb.upsertStatus(handle.id, {
      status: "completed",
      completed_at: Date.now(),
      updated_at: Date.now(),
      turns: handle.turns,
      usage_context_tokens: currentUsage.contextTokens,
    });
    infra.subagentDb.insertEvent(handle.id, "completed", "completed", handle.turns, currentUsage.contextTokens);

    return {
      output: outputText,
      exitCode: 0,
      sessionFile: handle.sessionFile,
    };
  } catch (err: any) {
    const isAborted = sessionAbortController.signal.aborted || abortSignal?.aborted;
    const finalStatus: SubagentStatus = isAborted ? "aborted" : "failed";
    handle.status = finalStatus;

    infra.subagentDb.upsertStatus(handle.id, {
      status: finalStatus,
      last_error: err.message,
      updated_at: Date.now(),
    });
    infra.subagentDb.insertEvent(handle.id, finalStatus, finalStatus, handle.turns, currentUsage.contextTokens, err.message);

    return {
      output: isAborted ? "Subagent aborted" : `Subagent failed: ${err.message}`,
      exitCode: 1,
      sessionFile: handle.sessionFile,
    };
  } finally {
    unsubscribe();
    if (abortSignal) {
      abortSignal.removeEventListener("abort", onParentAbort);
    }
    if (!agentConfig.interactive) {
      session.dispose();
    }
  }
}

export async function spawnSubagentAsync(
  agentConfig: AgentConfig,
  task: string,
  abortSignal: AbortSignal | undefined,
  cwd: string,
  pi: ExtensionAPI,
  parentSessionId: string,
  sessionFile?: string,
  parentSessionFile?: string,
): Promise<{ subagentId: string; status: SubagentStatus }> {
  const infra = getSpawnInfra();
  const subagentId = generateId(agentConfig.name);

  const handle: SubagentHandle = {
    id: subagentId,
    agentName: agentConfig.name,
    status: "spawned",
    task,
    model: agentConfig.model,
    interactive: agentConfig.interactive,
    spawnedAt: Date.now(),
    ownerSession: parentSessionId,
    turns: 0,
    usage: { ...INITIAL_USAGE },
  };

  const registry = getAgentRegistry();
  registry.registerRunning(handle);

  if (infra) {
    infra.subagentDb.upsertStatus(subagentId, {
      id: subagentId,
      agent_name: agentConfig.name,
      status: "spawned",
      task,
      model: agentConfig.model ?? null,
      interactive: agentConfig.interactive ? 1 : 0,
      spawned_at: handle.spawnedAt,
      owner_session: parentSessionId,
      turns: 0,
      last_heartbeat: Date.now(),
      updated_at: Date.now(),
    });
    infra.subagentDb.insertEvent(subagentId, "spawned", "spawned", 0, 0);
  }

  syncWidgetFromRegistry(pi);

  (async () => {
    await concurrencyTracker.acquire();
    try {
      const result = await spawnSubagentSession(
        agentConfig,
        task,
        abortSignal,
        cwd,
        handle,
        (turns, status, usage) => {
          registry.updateRunning(subagentId, { turns, status, usage, _tool: handle._tool });
          syncWidgetFromRegistry(pi);
        },
        sessionFile,
        parentSessionFile,
      );

      syncWidgetFromRegistry(pi);

      registry.updateRunning(subagentId, { status: handle.status, turns: handle.turns, usage: handle.usage });
      syncWidgetFromRegistry(pi);

      const isInteractiveWaiting = agentConfig.interactive && handle.status === "completed";
      const icon = result.exitCode === 0 ? (isInteractiveWaiting ? "💬" : "✅") : "❌";
      const preview = taskPreview(task);

      pi.sendMessage(
        {
          customType: "crew-subagent-result",
          content: `${icon} **${agentConfig.name}** (${subagentId}) finished:\n> ${preview}\n\n${result.output}`,
          display: true,
          details: {
            subagentId,
            agentName: agentConfig.name,
            task,
            status: handle.status,
            turns: handle.turns,
            output: result.output,
            exitCode: result.exitCode,
            interactive: agentConfig.interactive,
          },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    } catch (err: any) {
      registry.updateRunning(subagentId, { status: "failed" });
      syncWidgetFromRegistry(pi);
      pi.sendMessage(
        {
          customType: "crew-subagent-result",
          content: `❌ **${agentConfig.name}** (${subagentId}) encountered fatal error: ${err.message}`,
          display: true,
          details: { subagentId, error: err.message },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    } finally {
      concurrencyTracker.release();
    }
  })();

  return { subagentId, status: "spawned" };
}

// ─── crew_spawn Tool ───────────────────────────────────────────────

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Which agent directories to use. Default: "both" (user + project + bundled). Use "user" for user-only.',
  default: "both",
});

const SpawnParams = Type.Object({
  agent: Type.String({ description: "Name of the subagent to spawn (e.g., worker, scout, planner)" }),
  task: Type.String({ description: "Task description for the subagent" }),
  model: Type.Optional(Type.String({ description: "Override the subagent model" })),
  interactive: Type.Optional(Type.Boolean({ description: "Keep session alive for multi-turn conversations" })),
  agentScope: Type.Optional(AgentScopeSchema),
  cwd: Type.Optional(Type.String({ description: "Working directory for the subagent" })),
  fork: Type.Optional(Type.Boolean({ description: "Copy parent session history into the subagent session" })),
  sessionFile: Type.Optional(Type.String({ description: "Explicit session file to resume. Takes precedence over fork." })),
});

export function registerSpawnTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "crew_spawn",
    label: "Crew Spawn",
    description: [
      "Spawn a subagent in an isolated session with its own context window.",
      "Subagent runs ASYNC in the background. Results delivered as steering message when done.",
      "Subagents inherit user extensions. crew_* tools are omitted to prevent recursion.",
      "Use crew_list to check status. Use crew_abort to cancel.",
    ].join(" "),
    parameters: SpawnParams,
    promptSnippet: "Spawn a non-blocking subagent. Use crew_list first to see available subagents.",
    promptGuidelines: [
      "crew_spawn: Spawn a discovered subagent for one clearly delegated, self-contained task.",
      "crew_spawn: Use crew_list before spawning to discover available subagents.",
      "crew_spawn: Include needed context in task: constraints, relevant files, acceptance criteria.",
      "crew_spawn: Results arrive as steering messages — do NOT poll crew_list or fabricate results.",
      "crew_spawn: Subagents inherit all user tools (hashline, search, etc.) with recursion protection.",
    ],

    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const agentScope: AgentScope = params.agentScope ?? "both";
      const cwd = params.cwd ?? ctx.cwd;

      const registry = getAgentRegistry();
      let agentConfig = registry.get(params.agent);

      if (!agentConfig) {
        registry.refresh(cwd, agentScope);
        agentConfig = registry.get(params.agent);
      }

      if (!agentConfig) {
        agentConfig = findAgent(cwd, agentScope, params.agent);
      }

      if (!agentConfig) {
        registry.refresh(cwd, agentScope);
        const available = registry.getNames().join(", ") || "none";
        return {
          content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${available}.` }],
          details: { agents: available },
          isError: true,
        };
      }

      const configuredAgent: AgentConfig = {
        ...agentConfig,
        model: params.model ?? agentConfig.model,
        interactive: params.interactive !== undefined ? params.interactive : agentConfig.interactive,
      };

      const resolvedSessionFile = params.sessionFile;
      const useFork = !resolvedSessionFile && params.fork;
      const parentSessionFile = useFork ? ctx.sessionManager.getSessionFile() : undefined;

      const parentSessionId = ctx.sessionManager.getSessionId();
      const spawnResult = await spawnSubagentAsync(
        configuredAgent,
        params.task,
        signal,
        cwd,
        pi,
        parentSessionId,
        resolvedSessionFile,
        parentSessionFile,
      );

      ctx.ui.notify(`Spawned ${configuredAgent.name} (${spawnResult.subagentId})`, "info");
      syncWidgetFromRegistry(pi);

      return {
        content: [
          {
            type: "text",
            text: `Subagent **${configuredAgent.name}** spawned with ID: \`${spawnResult.subagentId}\`.\nTask: ${params.task}\nStatus: ${spawnResult.status}\n\nResult will arrive as a steering message when done.`,
          },
        ],
        details: {
          subagent_id: spawnResult.subagentId,
          agent: configuredAgent.name,
          task: params.task,
          status: spawnResult.status,
          interactive: configuredAgent.interactive,
        },
      };
    },

    renderCall(args: any, theme: any) {
      const agent = args.agent ?? "...";
      const preview = taskPreview(args.task ?? "");
      return new Text(`🚀 ${theme.fg("toolTitle", "spawn")} ${theme.fg("accent", agent)}\n  ${theme.fg("dim", preview)}`, 0, 0);
    },

    renderResult(result: any, _options: any, theme: any) {
      const details = result.details;
      const id = details?.subagent_id ?? "";
      const agent = details?.agent ?? "";
      return new Text(`${theme.fg("success", "✓")} ${agent} (${id}) running in background`, 0, 0);
    },
  });
}

// ─── crew_log & crew_inject Tools ──────────────────────────────────

const LogParams = Type.Object({
  subagent_id: Type.String({ description: "ID of the subagent to inspect" }),
  limit: Type.Optional(Type.Number({ description: "Number of latest transcript entries to show (default 10)", default: 10 })),
});

export function registerLogTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "crew_log",
    label: "Crew Log",
    description: "Read the latest transcript entries from a running subagent — shows thinking, text output, and tool results in real-time.",
    parameters: LogParams,
    promptSnippet: "Read real-time transcript output from a running subagent.",
    promptGuidelines: [
      "crew_log: Read transcript from a running subagent to see its thinking, text output, and tool results.",
      "crew_log: Use when a subagent is taking too long or you suspect it's going in the wrong direction.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const registry = getAgentRegistry();
      const callerSessionId = ctx.sessionManager.getSessionId();
      const owned = validateOwnership(params.subagent_id, registry, callerSessionId);
      if (!owned.ok) return owned.errorResponse;

      const transcript = owned.handle._transcript ?? [];
      const limit = Math.min(params.limit ?? 10, transcript.length);
      const entries = transcript.slice(-limit);

      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: `**${owned.handle.agentName}** (${owned.handle.id}) has no transcript entries yet.` }],
          details: { subagentId: params.subagent_id, entries: 0 },
        };
      }

      const lines: string[] = [
        `=== ${owned.handle.agentName} (${owned.handle.id}) ===`,
        `Status: ${owned.handle.status} · ${owned.handle.turns} turn(s)`,
        `Transcript: ${transcript.length} total entries, showing last ${limit}`,
        "",
      ];
      for (const entry of entries) {
        const prefix = entry.toolName ? `[${entry.type}: ${entry.toolName}]` : `[${entry.type}]`;
        const content = entry.content.length > 200 ? entry.content.slice(0, 200) + "…" : entry.content;
        lines.push(`${prefix} ${content}`);
        if (entry.isError) lines.push("  ⚠️ Error");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { subagentId: params.subagent_id, totalEntries: transcript.length, shown: limit },
      };
    },

    renderCall(args: any, theme: any) {
      return new Text(`📋 ${theme.fg("toolTitle", `log ${args.subagent_id}`)}`, 0, 0);
    },

    renderResult(result: any, _options: any, theme: any) {
      const text = result.content[0]?.text ?? "(empty)";
      return new Text(text, 0, 0);
    },
  });
}

const InjectParams = Type.Object({
  subagent_id: Type.String({ description: "ID of the subagent to steer/interrupt" }),
  message: Type.String({ description: "Steering instruction to inject mid-turn" }),
});

export function registerInjectTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "crew_inject",
    label: "Crew Inject",
    description: "Inject a steering message into a running subagent mid-turn — corrects course without waiting for the current response to finish.",
    parameters: InjectParams,
    promptSnippet: "Interrupt and redirect a running subagent mid-turn.",
    promptGuidelines: [
      "crew_inject: Send a course-correction to a subagent that is currently generating or running tools.",
      "crew_inject: Message should be concise, specific, and directive.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const registry = getAgentRegistry();
      const callerSessionId = ctx.sessionManager.getSessionId();
      const owned = validateOwnership(params.subagent_id, registry, callerSessionId);
      if (!owned.ok) return owned.errorResponse;

      if (!owned.handle.session) {
        return {
          content: [{ type: "text", text: `Subagent ${owned.handle.agentName} (${params.subagent_id}) has no active session — cannot inject.` }],
          details: { error: "no session" },
          isError: true,
        };
      }

      if (owned.handle.status !== "running" && owned.handle.status !== "spawned") {
        return {
          content: [{ type: "text", text: `Subagent ${owned.handle.agentName} (${params.subagent_id}) is ${owned.handle.status} — can only inject into active subagents.` }],
          details: { error: "not active", status: owned.handle.status },
          isError: true,
        };
      }

      try {
        owned.handle.session.steer(params.message);
        return {
          content: [{ type: "text", text: `Steering injected into **${owned.handle.agentName}** (${params.subagent_id}):\n> "${params.message}"` }],
          details: { subagentId: params.subagent_id, message: params.message },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to inject steering into ${params.subagent_id}: ${err.message}` }],
          details: { error: err.message },
          isError: true,
        };
      }
    },

    renderCall(args: any, theme: any) {
      const preview = args.message?.length > 50 ? `${args.message.slice(0, 50)}...` : args.message ?? "...";
      return new Text(`💉 ${theme.fg("toolTitle", `inject ${args.subagent_id}`)}\n  ${theme.fg("dim", preview)}`, 0, 0);
    },

    renderResult(result: any, _options: any, theme: any) {
      const content = result.content[0];
      return new Text(`${theme.fg("success", "✓")} ${content?.text ?? "(injected)"}`, 0, 0);
    },
  });
}
