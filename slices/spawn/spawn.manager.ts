/**
 * Subagent process spawn lifecycle manager.
 * Spawns isolated pi processes with --no-extensions --no-session --mode json -p.
 * Results delivered as steering messages to the main session.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fsPromises from "node:fs/promises";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, SubagentHandle, SubagentStatus, UsageStats } from "../../shared/types";
import { generateId, INITIAL_USAGE, MAX_CONCURRENCY } from "../../shared/types";
import { getPiInvocation, type StreamingResult } from "./spawn.types";
import { syncWidgetFromRegistry } from "../widget/widget.updater";

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

// ─── Temp Prompt Writer ─────────────────────────────────────────

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await fsPromises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

const _activeTempDirs = new Set<string>();

function trackTempDir(dir: string): void {
  _activeTempDirs.add(dir);
}

function untrackTempDir(dir: string): void {
  _activeTempDirs.delete(dir);
}

// Clean up all remaining temp dirs on process exit
process.on("exit", () => {
  for (const dir of _activeTempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function cleanupTemp(dir: string, filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  try { fs.rmdirSync(dir); } catch { /* ignore */ }
}

// ─── Spawn Arguments Builder ────────────────────────────────────

function buildSpawnArgs(
  agentConfig: AgentConfig,
  task: string,
  extraArgs?: string[],
): string[] {
  const args: string[] = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--no-extensions",           // ⬅️ CEGAH endless spawning & blocker inheritance
  ];

  if (agentConfig.model) {
    args.push("--model", agentConfig.model);
  }

  if (agentConfig.tools && agentConfig.tools.length > 0) {
    args.push("--tools", agentConfig.tools.join(","));
  }

  // Tambahkan extension yang explicitly diminta
  if (agentConfig.extensions && agentConfig.extensions.length > 0) {
    for (const ext of agentConfig.extensions) {
      if (ext.resolved) {
        args.push("--extension", ext.resolved);
      } else if (ext.type === "pi-package") {
        args.push("--extension", ext.value);
      }
    }
  }

  // Tambahan extra args (model override, dll)
  if (extraArgs) {
    args.push(...extraArgs);
  }

  return args;
}

// ─── JSON Line Parser ───────────────────────────────────────────

interface ParseState {
  lastProcessedLen: number;
  pendingPartial: string;
}

function parseJsonLines(
  buffer: string,
  currentResult: StreamingResult,
  parseState: ParseState,
): void {
  // Only process new data since last call, prepend any pending partial line
  let newData = parseState.pendingPartial + buffer.slice(parseState.lastProcessedLen);
  parseState.lastProcessedLen = buffer.length;

  // If newData doesn't end with newline, save the last incomplete line
  if (!newData.endsWith("\n")) {
    const lastNewline = newData.lastIndexOf("\n");
    if (lastNewline >= 0) {
      parseState.pendingPartial = newData.slice(lastNewline + 1);
      newData = newData.slice(0, lastNewline + 1);
    } else {
      parseState.pendingPartial = newData;
      return;
    }
  } else {
    parseState.pendingPartial = "";
  }

  const lines = newData.split("\n");
  let fullResult = { ...currentResult };

  for (const line of lines) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "message_end" && event.message) {
      const msg = event.message as Message;
      const messages = [...fullResult.messages, msg];
      fullResult = { ...fullResult, messages };

      if (msg.role === "assistant") {
        const usage = msg.usage;
        if (usage) {
          fullResult.usage = {
            input: fullResult.usage.input + (usage.input || 0),
            output: fullResult.usage.output + (usage.output || 0),
            cacheRead: fullResult.usage.cacheRead + (usage.cacheRead || 0),
            cacheWrite: fullResult.usage.cacheWrite + (usage.cacheWrite || 0),
            cost: fullResult.usage.cost + (usage.cost?.total || 0),
            contextTokens: usage.totalTokens || 0,
            turns: fullResult.usage.turns + 1,
          };
        }
        if (!fullResult.model && msg.model) fullResult.model = msg.model;
        if (msg.stopReason) fullResult.stopReason = msg.stopReason;
        if (msg.errorMessage) fullResult.errorMessage = msg.errorMessage;
      }
    }
  }

  // Update currentResult in place (mutable for performance)
  currentResult.messages = fullResult.messages;
  currentResult.usage = fullResult.usage;
  currentResult.model = fullResult.model;
  currentResult.stopReason = fullResult.stopReason;
  currentResult.errorMessage = fullResult.errorMessage;
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function isFailedResult(result: StreamingResult): boolean {
  return result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted";
}

// ─── Main Spawn Function ────────────────────────────────────────

export interface SpawnSubagentResult {
  handle: SubagentHandle;
  output: string;
  streamingResult: StreamingResult;
}

export async function spawnSubagentProcess(
  agentConfig: AgentConfig,
  task: string,
  signal: AbortSignal | undefined,
  cwd: string,
  extraSpawnArgs?: string[],
): Promise<SpawnSubagentResult> {
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

  const streamingResult: StreamingResult = {
    messages: [],
    usage: { ...INITIAL_USAGE },
    exitCode: 0,
  };

  const baseArgs = buildSpawnArgs(agentConfig, task, extraSpawnArgs);
  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  try {
    // Write system prompt to temp file if needed
    if (agentConfig.systemPrompt.trim()) {
      let promptContent = agentConfig.systemPrompt;
      if (agentConfig.interactive) {
        promptContent += `\n\n## Interactive Mode\n\nYou are running in INTERACTIVE mode. If you need clarification from the orchestrator, output a message starting with "CLARIFY:" and the orchestrator will respond. You will receive the response via stdin.\n`;
      }
      const tmp = await writePromptToTempFile(agentConfig.name, promptContent);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      trackTempDir(tmp.dir);
      baseArgs.push("--append-system-prompt", tmpPromptPath);
    }
    // Always pass task as positional prompt (user message)
    baseArgs.push(`Task: ${task}`);

    handle.status = "running";

    // Per-process parse state — avoids race condition when multiple subagents run concurrently
    const parseState: ParseState = { lastProcessedLen: 0, pendingPartial: "" };

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(baseArgs);
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: agentConfig.interactive ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      });

      handle.pid = proc.pid;
      if (agentConfig.interactive) {
        handle.proc = proc;
      }

      let buffer = "";

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        parseJsonLines(buffer, streamingResult, parseState);
      });

      proc.stderr.on("data", (data: Buffer) => {
        // stderr dari pi process (debug info, dll)
      });

      proc.on("close", (code) => {
        if (buffer.trim()) parseJsonLines(buffer, streamingResult, parseState);
        handle.proc = undefined;
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        resolve(1);
      });

      // Abort signal
      if (signal) {
        const killProc = () => {
          handle.status = "aborted";
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    streamingResult.exitCode = exitCode;
    handle.status = isFailedResult(streamingResult) ? "failed" : "completed";
    handle.turns = streamingResult.usage.turns;

    return {
      handle,
      output: getFinalOutput(streamingResult.messages),
      streamingResult,
    };
  } catch (error: any) {
    handle.status = "failed";
    streamingResult.exitCode = 1;
    streamingResult.errorMessage = error.message;
    return {
      handle,
      output: error.message,
      streamingResult,
    };
  } finally {
    if (tmpPromptPath && tmpPromptDir) {
      cleanupTemp(tmpPromptDir, tmpPromptPath);
      untrackTempDir(tmpPromptDir);
    }
  }
}

// ─── Async Spawn with Steering Delivery ─────────────────────────

export function spawnSubagentAsync(
  pi: ExtensionAPI,
  agentConfig: AgentConfig,
  task: string,
  signal: AbortSignal | undefined,
  cwd: string,
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
  };

  // Persist spawn state
  pi.appendEntry("crew-subagent-spawn", {
    id,
    agentName: agentConfig.name,
    task,
    status: "running",
    spawnedAt: Date.now(),
    model: agentConfig.model,
  });

  // Update widget immediately after spawn
  syncWidgetFromRegistry(pi);

  // Background async spawn with concurrency limit (tidak await — non-blocking)
  (async () => {
    await concurrencyTracker.acquire();
    try {
      const result = await spawnSubagentProcess(agentConfig, task, signal, cwd);
      handle.status = result.handle.status;
      handle.turns = result.handle.turns;
      handle.proc = result.handle.proc;

      // Persist result
      pi.appendEntry("crew-subagent-result", {
        id: result.handle.id,
        agentName: result.handle.agentName,
        output: result.output,
        usage: result.streamingResult.usage,
        exitCode: result.streamingResult.exitCode,
        status: result.handle.status,
        completedAt: Date.now(),
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
              usage: result.streamingResult.usage,
              turns: result.handle.turns,
            },
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      } else {
        const errorMsg = result.streamingResult.errorMessage || "(no output)";
        pi.sendMessage(
          {
            customType: "crew-subagent-error",
            content: `❌ **${agentConfig.name}** (${handle.id}) failed:\n\n${errorMsg}`,
            display: true,
            details: {
              subagentId: handle.id,
              agentName: agentConfig.name,
              error: errorMsg,
              exitCode: result.streamingResult.exitCode,
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

/**
 * Abort a running subagent process by PID.
 */
export function abortSubagentProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    setTimeout(() => {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }, 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Track concurrency for parallel spawns using a semaphore.
 */
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

// ─── Concurrency Limiter ────────────────────────────────────────

const concurrencyTracker = new ConcurrencyTracker(MAX_CONCURRENCY);