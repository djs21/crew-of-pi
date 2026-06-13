/**
 * Agent types — specific to the agents discovery slice.
 * Shared interfaces (AgentConfig, AgentExtensionRef, etc.) live in shared/types.ts
 */

import type { AgentExtensionRef } from "../../shared/types";

export interface FrontmatterFields {
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
  thinking?: string;
  skills?: string;
  extensions?: string[];
  interactive?: string;
  compaction?: string;
}

export interface ParsedAgentDoc {
  frontmatter: FrontmatterFields;
  body: string;
  filePath: string;
  source: "user" | "project" | "bundled";
}

export interface ExtensionResolverResult {
  ref: AgentExtensionRef;
  error?: string;
}

export interface DiscoveryOptions {
  scope: "user" | "project" | "both";
  cwd: string;
  includeBundled?: boolean;
}
