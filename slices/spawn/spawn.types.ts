/**
 * Spawn-specific types.
 * Core types (SpawnConfig, SubagentHandle, etc.) live in shared/types.ts
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SpawnTask {
  agentName: string;
  task: string;
  cwd?: string;
  interactive?: boolean;
  signal?: AbortSignal;
  onUpdate?: (partial: any) => void;
  ctx: ExtensionContext;
}

export interface ProcessSpawnArgs {
  command: string;
  args: string[];
  cwd: string;
}

export interface StreamingResult {
  messages: any[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
  };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  exitCode: number;
}

export function getPiInvocation(args: string[]): ProcessSpawnArgs {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript) {
    try {
      if (require?.resolve && require.resolve(currentScript)) {
        return { command: process.execPath, args: [currentScript, ...args] };
      }
    } catch {
      // fall through
    }
  }

  const execName = require("node:path").basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}
