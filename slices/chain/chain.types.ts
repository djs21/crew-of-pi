/**
 * Chain types — sequential subagent workflow definitions.
 */

import type { UsageStats } from "../../shared/types";

export interface ChainStepConfig {
  agent: string;
  task: string;
  cwd?: string;
}

export interface ChainConfig {
  chain: ChainStepConfig[];
  stopOnError?: boolean;
}

export interface ChainProgress {
  chainId: string;
  currentStep: number;
  totalSteps: number;
  status: "running" | "completed" | "failed" | "aborted";
  results: ChainStepResult[];
}

export interface ChainStepResult {
  step: number;
  agent: string;
  task: string;
  output: string;
  exitCode: number;
  turns: number;
  usage: UsageStats;
  errorMessage?: string;
}

export const CHAIN_PLACEHOLDER = "{previous}";
