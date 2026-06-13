/**
 * Chain orchestrator — executes sequential subagent workflows.
 * Each step's output is injected into the next step via {previous} placeholder.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../shared/types";
import { generateId } from "../../shared/types";
import { findAgent } from "../agents/agents.discovery";
import { spawnSubagentProcess } from "../spawn/spawn.manager";
import { CHAIN_PLACEHOLDER, type ChainProgress, type ChainStepConfig, type ChainStepResult } from "./chain.types";

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

    // Spawn the subagent (blocking per step — chain is sequential)
    const result = await spawnSubagentProcess(
      agentConfig,
      taskWithContext,
      signal,
      step.cwd ?? cwd,
    );

    const stepResult: ChainStepResult = {
      step: i + 1,
      agent: step.agent,
      task: taskWithContext,
      output: result.output,
      exitCode: result.streamingResult.exitCode,
      turns: result.handle.turns,
      errorMessage: result.streamingResult.errorMessage,
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
      output: result.output,
      exitCode: result.streamingResult.exitCode,
    });

    // Handle failure
    if (result.handle.status === "failed" || result.handle.status === "aborted") {
      if (stopOnError) {
        progress.status = "failed";
        break;
      }
    }

    // Pass output to next step
    previousOutput = result.output;
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