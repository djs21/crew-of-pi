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
import * as fs from "node:fs";
import * as path from "node:path";
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
  const additionalPaths: string[] = [];
  for (const ext of agentConfig.extensions) {
    if (ext.type === "path" && ext.resolved) {
      additionalPaths.push(ext.resolved);
    } else if (ext.type === "pi-package") {
      // Resolve git: and npm: extensions to filesystem paths
      const stripped = ext.value.replace(/^(git:|npm:)/, "");
      let pkgPath: string | null = null;
      if (ext.value.startsWith("git:")) {
        pkgPath = path.join(infra.agentDir, "git", stripped);
      } else if (ext.value.startsWith("npm:")) {
        // Check packages/ first, then extensions/
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
    additionalSkillPaths: agentConfig.skills && agentConfig.skills.length > 0
      ? agentConfig.skills
      : undefined,
    extensionsOverride: (base) => {
      if (agentConfig.extensions.length === 0) {
        return { ...base, extensions: [] };
      }
      return {
        ...base,
        extensions: base.extensions.filter((ext) => {
          if (ext.resolvedPath.startsWith(infra.extensionDir)) return false;
          return agentConfig.extensions.some((agentExt) => {
            // Path type: exact match by resolved path
            if (agentExt.resolved && ext.resolvedPath === agentExt.resolved) return true;
            // Pi-package type: strip git:/npm: prefix, match by value
            const matchValue = agentExt.type === "pi-package"
              ? agentExt.value.replace(/^(git:|npm:)/, "")
              : agentExt.value;
            return ext.resolvedPath.includes(`/${matchValue}/`);
          });
        }),
      };
    },
    appendSystemPromptOverride: (base) =>
      agentConfig.systemPrompt.trim()
        ? [...base, agentConfig.systemPrompt]
        : base,
  });
}

// ─── Main Spawn Function ────────────────────────────────────────

export interface SpawnSessionResult {
  output: string;
  session: AgentSession;
  sessionFile?: string;
}

/**
 * Create a session for a subagent and run the prompt.
 * Mutates `handle` in-place (status, turns, session, usage).
 * Does NOT create a separate handle — caller owns one handle per subagent.
 */
export async function spawnSubagentSession(
  agentConfig: AgentConfig,
  task: string,
  signal: AbortSignal | undefined,
  cwd: string,
  handle: SubagentHandle,
  onProgress?: (turns: number, status: SubagentStatus, usage: UsageStats) => void,
  fork?: boolean,
  resolvedSessionFile?: string,
  parentSessionFile?: string,
): Promise<SpawnSessionResult> {
  const infra = getSpawnInfra();
  if (!infra) throw new Error("Spawn infrastructure not initialized. Call setSpawnInfra() in session_start.");

  // Resolve model
  const { model, warning: modelWarning } = resolveModel(agentConfig, infra.modelRegistry);
  if (modelWarning) {
    console.warn(`[crew-of-pi] ${agentConfig.name}: ${modelWarning}`);
  }

  // Setup resource loader with agent-specific extensions + system prompt
  const resourceLoader = createSubagentResourceLoader(agentConfig, cwd, infra);
  await resourceLoader.reload();

  // Setup session manager with compaction from agent config
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: agentConfig.compaction ?? true },
  });

  let sessionManager: SessionManager;
  if (resolvedSessionFile) {
    // Explicit session file → resume mode
    sessionManager = SessionManager.open(resolvedSessionFile);
  } else if (fork && parentSessionFile) {
    // Fork: copy parent session with lineage metadata (SDK handles ID + header)
    sessionManager = SessionManager.forkFrom(parentSessionFile, cwd);
  } else {
    // Default: new empty session
    sessionManager = SessionManager.create(cwd);
    sessionManager.newSession();
  }

  // Create agent session
  const { session } = await createAgentSession({
    cwd,
    agentDir: infra.agentDir,
    model,
    thinkingLevel: agentConfig.thinking as any,
    resourceLoader,
    sessionManager,
    settingsManager,
    authStorage: infra.modelRegistry.authStorage,
    modelRegistry: infra.modelRegistry,
    modelRuntime: infra.modelRuntime,
  });

  // Auto-merge: if agent has extensions, include their tools in the active set
  const allToolNames = session.getAllTools().map((t: any) => t.name);
  const activeTools = agentConfig.extensions?.length
    ? [...new Set([...(agentConfig.tools ?? []), ...allToolNames])]
    : agentConfig.tools;
  if (activeTools) {
    session.setActiveToolsByName(activeTools);
  }

  // Name the session for pi session list
  const brief = taskPreview(task);
  session.setSessionName(`crew: ${agentConfig.name} · ${brief}`);

  // Mutate handle in-place — ONE handle per subagent
  handle.session = session;
  handle.status = "running";

  // Live turn tracking via session subscription
  const usageAccum: UsageStats = { ...INITIAL_USAGE };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    // Track current tool for live widget updates
    if (event.type === "tool_execution_start") {
      handle['_tool'] = `${event.toolName}(${JSON.stringify(event.args).slice(0, 40)})`;
    } else if (event.type === "tool_execution_end") {
      handle['_tool'] = undefined;
    }

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
  let errorMessage: string | undefined;
  try {
    await session.prompt(task);

    // Determine outcome — mutates handle in-place
    const lastAssistant = getLastAssistantMessage(session.messages);
    if (lastAssistant?.stopReason === "error") {
      handle.status = "failed";
      errorMessage = getAssistantText(lastAssistant) || "Model error (no details)";
    } else if (lastAssistant?.stopReason === "aborted") {
      handle.status = "aborted";
    } else {
      handle.status = "completed";
    }

    handle.turns = usageAccum.turns;
    handle.usage = usageAccum;
  } catch (err: any) {
    errorMessage = err?.message ?? String(err);
    console.error(`[crew-of-pi] ${agentConfig.name} (${handle.id}) error:`, errorMessage);
    // Guard: don't overwrite "aborted" set by abort handler
    if (handle.status !== "aborted") {
      handle.status = "failed";
    }
    usageAccum.turns = Math.max(0, usageAccum.turns);
    handle.turns = usageAccum.turns;
    handle.usage = usageAccum;
  } finally {
    unsubscribe();
  }

  const output = getAssistantText(getLastAssistantMessage(session.messages)) || errorMessage || "";
  if (handle.status === "failed" && !errorMessage) {
    console.error(`[crew-of-pi] DEBUG ${agentConfig.name} (${handle.id}): failed but no errorMessage`);
  }
  const sessionFile = session.sessionFile;
  handle.sessionFile = sessionFile;

  return { output, session, sessionFile };
}

// ─── Async Spawn with Steering Delivery ─────────────────────────

export function spawnSubagentAsync(
  pi: ExtensionAPI,
  agentConfig: AgentConfig,
  task: string,
  _signal: AbortSignal | undefined,
  cwd: string,
  ownerSession?: string,
  parentSessionFile?: string,
  fork?: boolean,
): SubagentHandle {
  const id = generateId(agentConfig.name);

  // Create dedicated AbortController for this subagent NOW
  // before any async work. This lets crew_abort work even when
  // the subagent is waiting for a concurrency slot.
  const abortController = new AbortController();

  // ONE handle per subagent — created here, mutated in-place by spawnSubagentSession
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
    abortController,
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

  // Background async spawn with concurrency limit
  (async () => {
    await concurrencyTracker.acquire();

    // If abort was called while waiting for concurrency slot, bail immediately
    if (abortController.signal.aborted) {
      handle.status = "aborted";
      syncWidgetFromRegistry(pi);
      pi.appendEntry("crew-subagent-result", {
        id: handle.id,
        agentName: agentConfig.name,
        status: "aborted",
        abortedAt: Date.now(),
        reason: "aborted before start",
      });
      return;
    }

    // Mark as running now that process is actually starting
    handle.status = "running";
    syncWidgetFromRegistry(pi);

    try {
      // Pass handle directly — spawnSubagentSession mutates it in-place
      const { output, session: resultSession, sessionFile } = await spawnSubagentSession(
        agentConfig, task, abortController.signal, cwd, handle,
        fork, undefined, parentSessionFile,
        // Live progress callback — turns/usage from session subscription
        (turns, _status, usage) => {
          handle.turns = turns;
          handle.usage = usage;
          syncWidgetFromRegistry(pi);
        },
      );

      // handle.status, handle.turns, handle.session, handle.usage
      // are already set in-place by spawnSubagentSession

      if (handle.status === "aborted") {
        // Already handled by crew_abort — just sync widget
        syncWidgetFromRegistry(pi);
      } else {
        // Persist result
        pi.appendEntry("crew-subagent-result", {
          id: handle.id,
          agentName: handle.agentName,
          output,
          usage: handle.usage,
          status: handle.status,
          completedAt: Date.now(),
          sessionFile,
        });

        // Update widget
        syncWidgetFromRegistry(pi);

        // Send result as steering message
        if (handle.status === "completed") {
          pi.sendMessage(
            {
              customType: "crew-subagent-result",
              content: `✅ **${agentConfig.name}** (${handle.id}) completed:\n\n${output}`,
              display: true,
              details: {
                subagentId: handle.id,
                agentName: agentConfig.name,
                output,
                usage: handle.usage,
                turns: handle.turns,
                sessionFile,
              },
            },
            { deliverAs: "steer", triggerTurn: true },
          );
        } else {
          const errorMsg = output || "(no output)";
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
      }
    } catch (error: any) {
      // If already aborted by crew_abort, don't send bogus crash message
      if (handle.status === "aborted") {
        syncWidgetFromRegistry(pi);
      } else {
        handle.status = "failed";
        pi.sendMessage(
          {
            customType: "crew-subagent-error",
            content: `❌ **${agentConfig.name}** (${handle.id}) crashed: ${error.message}`,
            display: true,
            details: { subagentId: handle.id, agentName: agentConfig.name, error: error.message },
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      }
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
