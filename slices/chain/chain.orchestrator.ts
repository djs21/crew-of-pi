/**
 * Chain orchestrator — executes sequential subagent workflows.
 * Each step's output is injected into the next step via {previous} placeholder.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, SubagentHandle } from "../../shared/types";
import { generateId, INITIAL_USAGE } from "../../shared/types";
import { findAgent } from "../agents/agents.discovery";
import { getAgentRegistry } from "../agents/agents.registry";
import { spawnSubagentProcess } from "../spawn/spawn.manager";
import { syncWidgetFromRegistry } from "../widget/widget.updater";
import { CHAIN_PLACEHOLDER, type ChainProgress, type ChainStepConfig, type ChainStepResult } from "./chain.types";
import { getMessageBus } from "../comms/comms.bus";

// ─── Inter-Agent Marker Protocol ─────────────────────────────────

const MARKER_INSTRUCTIONS = [
  "",
  "---",
  "Inter-Agent Communication:",
  "You are in a chain workflow. Use these markers at the end of your output:",
  "  [ASK to:<agent>] question — request clarification from another agent",
  "  [TELL to:<agent>] message — send information to another agent",
  "  [HANDOFF to:<agent>] context — transfer work context to another agent",
  "  [WAIT] reason — request main agent intervention",
  "Text outside markers will be passed to the next step.",
].join("\n");

interface ParsedMarkers {
  cleanText: string;
  markers: Array<{ type: string; to: string; content: string }>;
}

function parseMarkers(text: string): ParsedMarkers {
  const lines = text.split("\n");
  const clean: string[] = [];
  const markers: ParsedMarkers["markers"] = [];

  for (const line of lines) {
    const m = line.trim().match(
      /^\[(ASK|TELL|HANDOFF|WAIT)\s+to:(\w[\w-]*)\s*\](.+)$/i,
    );
    if (m) {
      markers.push({ type: m[1].toUpperCase(), to: m[2], content: m[3].trim() });
    } else {
      clean.push(line);
    }
  }

  return { cleanText: clean.join("\n").trim(), markers };
}

function buildTaskWithMessages(agentName: string, baseTask: string): string {
  const bus = getMessageBus();
  const msgs = bus.getMessagesFor(agentName);
  if (msgs.length === 0) return baseTask;

  let task = baseTask;
  for (const msg of msgs) {
    task = `[From ${msg.from}]: ${msg.content}\n\n${task}`;
  }
  return task;
}

export interface ChainExecutionOptions {
  chain: ChainStepConfig[];
  stopOnError?: boolean;
  signal?: AbortSignal;
  cwd: string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  onStepComplete?: (step: number, result: ChainStepResult, progress: ChainProgress) => void;
}

/**
 * Execute a chain of subagents sequentially.
 * Each step passes its output to the next via {previous} placeholder.
 */
export async function executeChain(options: ChainExecutionOptions): Promise<ChainProgress> {
  const chainId = generateId("chain");
  const totalSteps = options.chain.length;

  const progress: ChainProgress = {
    chainId,
    currentStep: 0,
    totalSteps,
    status: "running",
    results: [],
  };

  const { cwd, chain, stopOnError = true, signal, pi } = options;
  let previousOutput = "";

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];

    // Check for abort signal
    if (signal?.aborted) {
      progress.status = "aborted";
      break;
    }

    // Replace {previous} placeholder with actual previous output
    const taskWithContext = step.task.replace(
      new RegExp(CHAIN_PLACEHOLDER, "g"),
      previousOutput,
    );

    // Find the agent config
    const agentConfig = findAgent(cwd, "both", step.agent);
    if (!agentConfig) {
      const errorMsg = `Unknown agent at step ${i + 1}: "${step.agent}"`;
      progress.results.push({
        step: i + 1,
        agent: step.agent,
        task: taskWithContext,
        output: errorMsg,
        exitCode: 1,
        turns: 0,
        errorMessage: errorMsg,
      });
      if (stopOnError) {
        progress.status = "failed";
        break;
      }
      continue;
    }

    // POINT A: augment task with bus messages + marker protocol
    const augmentedTask = buildTaskWithMessages(step.agent, taskWithContext) + MARKER_INSTRUCTIONS;

    // Register handle with registry + widget so chain progress is visible
    const chainHandle: SubagentHandle = {
      id: generateId(step.agent),
      agentName: step.agent,
      status: "spawned",
      task: augmentedTask,
      model: agentConfig.model,
      interactive: false,
      spawnedAt: Date.now(),
      turns: 0,
      usage: { ...INITIAL_USAGE },
    };
    getAgentRegistry().registerRunning(chainHandle);
    syncWidgetFromRegistry(pi);

    // Spawn the subagent (blocking per step — chain is sequential)
    const spawnResult = await spawnSubagentProcess(
      agentConfig,
      augmentedTask,
      signal,
      step.cwd ?? cwd,
      // Live progress: update widget turns/usage each turn
      (turns, _status, usage) => {
        getAgentRegistry().updateRunning(chainHandle.id, {
          turns,
          status: "running",
          usage,
        });
        syncWidgetFromRegistry(pi);
      },
    );

    // Update final status in registry + widget
    const finalStatus = spawnResult.handle.status;
    getAgentRegistry().updateRunning(chainHandle.id, {
      turns: spawnResult.handle.turns,
      status: finalStatus,
      usage: spawnResult.handle.usage,
    });
    syncWidgetFromRegistry(pi);

    // POINT B: parse inter-agent markers, route to message bus
    const { cleanText, markers } = parseMarkers(spawnResult.output);
    const bus = getMessageBus();
    for (const marker of markers) {
      const msgType = marker.type === "ASK" ? "clarification"
        : marker.type === "TELL" ? "report"
        : marker.type === "HANDOFF" ? "handoff"
        : "clarification";
      bus.send(
        chainHandle.id,
        marker.to,
        msgType as any,
        marker.content,
      );
    }

    const stepResult: ChainStepResult = {
      step: i + 1,
      agent: step.agent,
      task: augmentedTask,
      output: cleanText || spawnResult.output,
      exitCode: spawnResult.handle.status === "failed" || spawnResult.handle.status === "aborted" ? 1 : 0,
      turns: spawnResult.handle.turns,
      errorMessage: spawnResult.handle.status === "failed" ? (spawnResult.output || "(failed)") : undefined,
    };

    progress.results.push(stepResult);
    progress.currentStep = i + 1;

    // Notify step completion
    if (options.onStepComplete) {
      options.onStepComplete(i + 1, stepResult, progress);
    }

    // Persist step result
    pi.appendEntry("crew-chain-step", {
      chainId,
      step: i + 1,
      agent: step.agent,
      output: spawnResult.output,
      status: spawnResult.handle.status,
    });

    // Handle failure
    if (spawnResult.handle.status === "failed" || spawnResult.handle.status === "aborted") {
      if (stopOnError) {
        progress.status = "failed";
        break;
      }
    }

    // Pass clean output (no markers) to next step
    previousOutput = cleanText || spawnResult.output;
  }

  // Mark completed if still running
  if (progress.status === "running") {
    progress.status = "completed";
  }

  return progress;
}

/**
 * Format chain progress for display.
 */
export function formatChainProgress(progress: ChainProgress): string {
  const lines: string[] = [];
  lines.push(`Chain ${progress.chainId}: ${progress.status}`);
  lines.push(`Steps: ${progress.currentStep}/${progress.totalSteps}`);

  for (const result of progress.results) {
    const icon = result.exitCode === 0 ? "✅" : "❌";
    const outputPreview = result.output.length > 100
      ? result.output.slice(0, 100) + "..."
      : result.output;
    lines.push(`  ${icon} Step ${result.step}: ${result.agent}`);
    lines.push(`     ${outputPreview}`);
  }

  return lines.join("\n");
}