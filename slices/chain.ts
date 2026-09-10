/**
 * chain.ts — Sequential multi-agent workflow orchestration for crew-of-pi.
 * Steps execute in order, passing context via `{previous}` template placeholder.
 */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { AgentConfig, SubagentHandle } from "../shared/types";
import { generateId, INITIAL_USAGE } from "../shared/types";
import { findAgent, getAgentRegistry } from "./agents";
import { spawnSubagentSession } from "./spawn";
import { syncWidgetFromRegistry } from "./widget";
import { getMessageBus } from "./db";

export const CHAIN_PLACEHOLDER = "{previous}";

export interface ChainStepConfig {
  agent: string;
  task: string;
  cwd?: string;
  model?: string;
}

export interface ChainStepResult {
  step: number;
  agent: string;
  task: string;
  output: string;
  exitCode: number;
  turns: number;
  usage?: any;
  errorMessage?: string;
}

export interface ChainProgress {
  chainId: string;
  currentStep: number;
  totalSteps: number;
  status: "running" | "completed" | "failed" | "aborted";
  results: ChainStepResult[];
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

    if (signal?.aborted) {
      progress.status = "aborted";
      break;
    }

    const taskWithContext = step.task.replace(
      new RegExp(CHAIN_PLACEHOLDER, "g"),
      previousOutput,
    );

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

    const chainHandle: SubagentHandle = {
      id: generateId(step.agent),
      agentName: step.agent,
      status: "spawned",
      task: taskWithContext,
      model: agentConfig.model,
      interactive: false,
      spawnedAt: Date.now(),
      turns: 0,
      usage: { ...INITIAL_USAGE },
    };
    getAgentRegistry().registerRunning(chainHandle);
    syncWidgetFromRegistry(pi);

    const spawnResult = await spawnSubagentSession(
      agentConfig,
      taskWithContext,
      signal,
      step.cwd ?? cwd,
      chainHandle,
      (turns, _status, usage) => {
        getAgentRegistry().updateRunning(chainHandle.id, {
          turns,
          status: "running",
          usage,
        });
        syncWidgetFromRegistry(pi);
      },
    );

    syncWidgetFromRegistry(pi);

    const stepResult: ChainStepResult = {
      step: i + 1,
      agent: step.agent,
      task: taskWithContext,
      output: spawnResult.output,
      exitCode: chainHandle.status === "failed" || chainHandle.status === "aborted" ? 1 : 0,
      turns: chainHandle.turns,
      usage: chainHandle.usage,
      errorMessage: chainHandle.status === "failed" ? (spawnResult.output || "(failed)") : undefined,
    };

    progress.results.push(stepResult);
    progress.currentStep = i + 1;

    if (options.onStepComplete) {
      options.onStepComplete(i + 1, stepResult, progress);
    }

    pi.appendEntry("crew-chain-step", {
      chainId,
      step: i + 1,
      agent: step.agent,
      output: spawnResult.output,
      status: chainHandle.status,
    });

    if (chainHandle.status === "failed" || chainHandle.status === "aborted") {
      if (stopOnError) {
        progress.status = "failed";
        break;
      }
    }

    previousOutput = spawnResult.output;
  }

  if (progress.status === "running") {
    progress.status = "completed";
  }

  return progress;
}

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

const ChainStepSchema = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task description. Use {previous} to reference prior step output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this step" })),
});

const ChainParams = Type.Object({
  chain: Type.Array(ChainStepSchema, {
    description: "Array of {agent, task} steps executed sequentially",
  }),
  stopOnError: Type.Optional(
    Type.Boolean({ description: "Stop chain if a step fails. Default: true", default: true }),
  ),
});

export function registerChainTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "crew_chain",
    label: "Crew Chain",
    description: [
      "Execute a sequential workflow where each step's output feeds into the next.",
      'Use {previous} placeholder in task text to reference the previous step\'s output.',
      'Each step spawns an isolated subagent.',
      'All steps are notified to main agent via steering messages.',
    ].join(" "),
    parameters: ChainParams,
    promptSnippet: "Run a sequential multi-agent workflow with {previous} placeholder passing.",
    promptGuidelines: [
      "crew_chain: Execute a sequential workflow where each step's output feeds the next via {previous}.",
      "crew_chain: Each step spawns an isolated subagent with user extension inheritance.",
      "crew_chain: Use stopOnError: true to halt the chain on first failure.",
      "crew_chain: All step results are notified via steering messages as they complete.",
    ],

    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const chainSteps: ChainStepConfig[] = params.chain.map((step: any) => ({
        agent: step.agent,
        task: step.task,
        cwd: step.cwd ?? ctx.cwd,
      }));

      const stopOnError = params.stopOnError ?? true;

      ctx.ui.notify(`Chain started: ${chainSteps.length} steps`, "info");
      syncWidgetFromRegistry(pi);

      const progress = await executeChain({
        chain: chainSteps,
        stopOnError,
        signal,
        cwd: ctx.cwd,
        pi,
        ctx,
        onStepComplete: (step, result, prog) => {
          if (result.exitCode === 0) {
            pi.sendMessage(
              {
                customType: "crew-chain-step",
                content: `Step ${step}/${prog.totalSteps} (${result.agent}) completed ✅`,
                display: false,
                details: { step, agent: result.agent, output: result.output },
              },
              { deliverAs: "steer", triggerTurn: false },
            );
          } else {
            pi.sendMessage(
              {
                customType: "crew-chain-step",
                content: `Step ${step}/${prog.totalSteps} (${result.agent}) failed ❌: ${result.errorMessage}`,
                display: false,
                details: { step, agent: result.agent, error: result.errorMessage },
              },
              { deliverAs: "steer", triggerTurn: true },
            );
          }
        },
      });

      const lastResult = progress.results[progress.results.length - 1];
      const finalOutput = lastResult?.output ?? "(no output)";

      return {
        content: [
          {
            type: "text",
            text: formatChainProgress(progress) + "\n\n" + finalOutput,
          },
        ],
        details: {
          chainId: progress.chainId,
          status: progress.status,
          stepsCompleted: progress.currentStep,
          totalSteps: progress.totalSteps,
          results: progress.results,
        },
      };
    },

    renderCall(args: any, theme: any) {
      const steps = args.chain?.map((s: any) => s.agent).join(" → ") ?? "...";
      return new Text(`⛓️ ${theme.fg("toolTitle", "chain")} ${theme.fg("dim", steps)}`, 0, 0);
    },

    renderResult(result: any, _options: any, theme: any) {
      const details = result.details;
      const statusIcon = details?.status === "completed" ? "✓" : "✗";
      const statusColor = details?.status === "completed" ? "success" : "error";
      return new Text(
        `${theme.fg(statusColor, statusIcon)} Chain ${details?.chainId ?? ""} (${details?.stepsCompleted ?? 0}/${details?.totalSteps ?? 0} steps)`,
        0,
        0,
      );
    },
  });
}
