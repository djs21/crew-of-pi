/**
 * crew_chain tool — sequential multi-agent workflow.
 * Each step's output is injected into the next via {previous} placeholder.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { executeChain, formatChainProgress } from "./chain.orchestrator";
import { syncWidgetFromRegistry } from "../widget/widget.updater";
import type { ChainStepConfig } from "./chain.types";

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

    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const chainSteps: ChainStepConfig[] = params.chain.map((step: any) => ({
        agent: step.agent,
        task: step.task,
        cwd: step.cwd ?? ctx.cwd,
      }));

      const stopOnError = params.stopOnError ?? true;

      ctx.ui.notify(`Chain started: ${chainSteps.length} steps`, "info");
      syncWidgetFromRegistry(pi);

      // Execute chain (sequential — each step awaits)
      const progress = await executeChain({
        chain: chainSteps,
        stopOnError,
        signal,
        cwd: ctx.cwd,
        pi,
        ctx,
        onStepComplete: (step, result, prog) => {
          // Notify main agent about each step via steering
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

      // Get final output
      const lastResult = progress.results[progress.results.length - 1];
      const finalOutput = lastResult?.output ?? "(no output)";

      return {
        content: [
          {
            type: "text",
            text: progress.status === "completed"
              ? finalOutput
              : `Chain ${progress.status}: ${formatChainProgress(progress)}`,
          },
        ],
        details: {
          chainId: progress.chainId,
          status: progress.status,
          steps: progress.totalSteps,
          completed: progress.currentStep,
          results: progress.results,
        },
        isError: progress.status === "failed",
      };
    },

    renderCall(args: any, theme: any) {
      const steps = args.chain?.length ?? 0;
      let text = `🔗 ${theme.fg("toolTitle", "chain ")}${theme.fg("accent", `${steps} steps`)}`;
      for (const step of (args.chain ?? []).slice(0, 3)) {
        const preview = (step.task || "").replace(/\{previous\}/g, "").trim();
        const truncated = preview.length > 40 ? `${preview.slice(0, 40)}...` : preview;
        text += `\n  ${theme.fg("muted", `${step.agent}`)}${theme.fg("dim", ` ${truncated}`)}`;
      }
      if (steps > 3) text += `\n  ${theme.fg("muted", `... +${steps - 3} more`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result: any, _options: any, theme: any) {
      const details = result.details;
      if (!details) return new Text(result.content[0]?.text ?? "(no output)", 0, 0);

      const status = details.status;
      const icon = status === "completed" ? "✅" : status === "failed" ? "❌" : "⏳";

      let text = `${icon} ${theme.fg("toolTitle", `Chain ${status}`)} (${details.completed}/${details.steps})`;

      for (const r of details.results ?? []) {
        const rIcon = r.exitCode === 0 ? "✅" : "❌";
        text += `\n  ${rIcon} Step ${r.step}: ${r.agent}`;
        if (r.output) {
          const preview = r.output.length > 80 ? `${r.output.slice(0, 80)}...` : r.output;
          text += `\n    ${theme.fg("dim", preview)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}