/**
 * Subagent process spawn lifecycle manager.
 * Uses pi SDK createAgentSession for native session management,
 * turn tracking, and session persistence.
 * Results delivered as steering messages to the main session.
 */

import type { AgentMessage, Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  DefaultResourceLoader,
  type ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, SubagentHandle, SubagentStatus, UsageStats } from "../../shared/types";
import { generateId, INITIAL_USAGE, MAX_CONCURRENCY } from "../../shared/types";
import { getSpawnInfra } from "./spawn.tool";
import { syncWidgetFromRegistry } from "../widget/widget.updater";

// ─── Helpers ────────────────────────────────────────────────────

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

// ─── Model Resolution ───────────────────────────────────────────

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

// ─── Resource Loader Per Subagent ───────────────────────────────

function createSubagentResourceLoader(
  agentConfig: AgentConfig,
  cwd: string,
  infra: { agentDir: string; extensionDir: string },
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir: infra.agentDir,
    // Filter out crew-of-pi itself to prevent recursive spawns
    extensionsOverride: (base) => {
      if (agentConfig.extensions.length === 0) {
        // No extensions listed → strip all (opt-in default)
        return { ...base, extensions: [] };
      }
      // Opt-in: keep only base extensions matching the agent's list
      return {
        ...base,
        extensions: base.extensions.filter((ext) => {
          // Always filter out crew-of-pi itself
          if (ext.resolvedPath.startsWith(infra.extensionDir)) return false;
          // Match by exact resolved path, or by extension name in path
          // (e.g. "git-checkpoint" matches .../extensions/git-checkpoint/index.ts)
          return agentConfig.extensions.some((agentExt) =>
            ext.resolvedPath === agentExt.resolved ||
            ext.resolvedPath.includes(`/${agentExt.value}/`),
          );
        }),
      };
    },
    // Inject agent's system prompt
    appendSystemPromptOverride: (base) =>
      agentConfig.systemPrompt.trim()
        ? [...base, agentConfig.systemPrompt]
        : base,
  });
}

// ─── Main Spawn Function ────────────────────────────────────────

export interface SpawnSubagentResult {
  handle: SubagentHandle;
  output: string;
  session: AgentSession;
  sessionFile?: string;
}

export async function spawnSubagentProcess(
  agentConfig: AgentConfig,
  task: string,
  signal: AbortSignal | undefined,
  cwd: string,
  onProgress?: (turns: number, status: SubagentStatus, usage: UsageStats) => void,
): Promise<SpawnSubagentResult> {
  const infra = getSpawnInfra();
  if (!infra) throw new Error("Spawn infrastructure not initialized. Call setSpawnInfra() in session_start.");

  const id = generateId(agentConfig.name);

  const handle: SubagentHandle = {
    id,
    agentName: agentConfig.name,
    status: "spawned",
    task,
    model: agentConfig.model,
    interactive: agentConfig.interactive,
    spawnedAt: Date.now(),
    turns: 0,
    usage: { ...INITIAL_USAGE },
  };

  // Resolve model
  const { model, warning: modelWarning } = resolveModel(agentConfig, infra.modelRegistry);

  // Setup resource loader with agent-specific extensions + system prompt
  const resourceLoader = createSubagentResourceLoader(agentConfig, cwd, infra);
  await resourceLoader.reload();

  // Setup session manager with compaction from agent config
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: agentConfig.compaction ?? true },
  });

  const sessionManager = SessionManager.create(cwd);
  sessionManager.newSession();

  // Create agent session
  const { session } = await createAgentSession({
    cwd,
    agentDir: infra.agentDir,
    model,
    thinkingLevel: agentConfig.thinking as any,
    tools: agentConfig.tools,
    resourceLoader,
    sessionManager,
    settingsManager,
    authStorage: infra.modelRegistry.authStorage,
    modelRegistry: infra.modelRegistry,
  });

  // Name the session for pi session list
  const brief = taskPreview(task);
  session.setSessionName(`crew: ${agentConfig.name} · ${brief}`);

  handle.session = session;
  handle.status = "running";

  // Live turn tracking via session subscription (NATIVE — no parseJsonLines)
  const usageAccum: UsageStats = { ...INITIAL_USAGE };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type !== "turn_end") return;

    const msg = event.message;
    if (msg.role === "assistant") {
      const asst = msg as AssistantMessage;
      usageAccum.turns++;
      if (asst.usage) {
        usageAccum.input += asst.usage.input || 0;
        usageAccum.output += asst.usage.output || 0;
        usageAccum.cacheRead += asst.usage.cacheRead || 0;
        usageAccum.cacheWrite += asst.usage.cacheWrite || 0;
        usageAccum.cost += asst.usage.cost?.total || 0;
        usageAccum.contextTokens = asst.usage.totalTokens || 0;
      }
      if (!handle.model && asst.model) handle.model = asst.model;
    }

    onProgress?.(usageAccum.turns, "running", usageAccum);
  });

  // Abort signal → session abort
  if (signal) {
    const abortSession = () => {
      handle.status = "aborted";
      session.abort().catch(() => {});
    };
    if (signal.aborted) abortSession();
    else signal.addEventListener("abort", abortSession, { once: true });
  }

  try {
    await session.prompt(task);

    // Determine outcome
    const lastAssistant = getLastAssistantMessage(session.messages);
    if (lastAssistant?.stopReason === "error") {
      handle.status = "failed";
    } else if (lastAssistant?.stopReason === "aborted") {
      handle.status = "aborted";
    } else {
      handle.status = "completed";
    }

    handle.turns = usageAccum.turns;
    handle.usage = usageAccum;
  } catch (err: any) {
    handle.status = "failed";
    usageAccum.turns = Math.max(0, usageAccum.turns);
    handle.turns = usageAccum.turns;
    handle.usage = usageAccum;
  } finally {
    unsubscribe();
  }

  const output = getAssistantText(getLastAssistantMessage(session.messages)) || "";
  const sessionFile = session.sessionFile;

  return { handle, output, session, sessionFile };
}

// ─── Async Spawn with Steering Delivery ─────────────────────────

export function spawnSubagentAsync(
  pi: ExtensionAPI,
  agentConfig: AgentConfig,
  task: string,
  signal: AbortSignal | undefined,
  cwd: string,
  ownerSession?: string,
): SubagentHandle {
  const id = generateId(agentConfig.name);

  const handle: SubagentHandle = {
    id,
    agentName: agentConfig.name,
    status: "spawned",
    task,
    model: agentConfig.model,
    interactive: agentConfig.interactive,
    spawnedAt: Date.now(),
    turns: 0,
    usage: { ...INITIAL_USAGE },
    ownerSession,
  };

  // Persist spawn state
  pi.appendEntry("crew-subagent-spawn", {
    id,
    agentName: agentConfig.name,
    task,
    status: "running",
    spawnedAt: Date.now(),
    model: agentConfig.model,
    ownerSession,
  });

  // Update widget immediately after spawn
  syncWidgetFromRegistry(pi);

  // Background async spawn with concurrency limit (tidak await — non-blocking)
  (async () => {
    await concurrencyTracker.acquire();
    // Mark as running now that process is actually starting
    handle.status = "running";
    syncWidgetFromRegistry(pi);
    try {
      const result = await spawnSubagentProcess(
        agentConfig, task, signal, cwd,
        // Live progress callback — turns/usage from session subscription
        (turns, _status, usage) => {
          handle.turns = turns;
          handle.usage = usage;
          syncWidgetFromRegistry(pi);
        },
      );
      handle.status = result.handle.status;
      handle.turns = result.handle.turns;
      handle.session = result.session;
      handle.usage = result.handle.usage;

      // Persist result
      pi.appendEntry("crew-subagent-result", {
        id: result.handle.id,
        agentName: result.handle.agentName,
        output: result.output,
        usage: result.handle.usage,
        status: result.handle.status,
        completedAt: Date.now(),
        sessionFile: result.sessionFile,
      });

      // Update widget
      syncWidgetFromRegistry(pi);

      // Kirim hasil sebagai steering message
      if (result.handle.status === "completed") {
        pi.sendMessage(
          {
            customType: "crew-subagent-result",
            content: `✅ **${agentConfig.name}** (${handle.id}) completed:\n\n${result.output}`,
            display: true,
            details: {
              subagentId: handle.id,
              agentName: agentConfig.name,
              output: result.output,
              usage: result.handle.usage,
              turns: result.handle.turns,
              sessionFile: result.sessionFile,
            },
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      } else {
        const lastAssistant = getLastAssistantMessage(result.session.messages);
        const errorMsg = lastAssistant?.errorMessage || "(no output)";
        pi.sendMessage(
          {
            customType: "crew-subagent-error",
            content: `❌ **${agentConfig.name}** (${handle.id}) failed:\n\n${errorMsg}`,
            display: true,
            details: {
              subagentId: handle.id,
              agentName: agentConfig.name,
              error: errorMsg,
            },
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      }
    } catch (error: any) {
      pi.sendMessage(
        {
          customType: "crew-subagent-error",
          content: `❌ **${agentConfig.name}** (${handle.id}) crashed: ${error.message}`,
          display: true,
          details: { subagentId: handle.id, agentName: agentConfig.name, error: error.message },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    } finally {
      concurrencyTracker.release();
    }
  })();

  return handle;
}

// ─── Concurrency Limiter ────────────────────────────────────────

export class ConcurrencyTracker {
  private max: number;
  private current: number = 0;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.current = Math.max(0, this.current - 1);
    }
  }
}

const concurrencyTracker = new ConcurrencyTracker(MAX_CONCURRENCY);
