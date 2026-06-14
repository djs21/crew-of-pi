/**
 * YAML frontmatter parser for agent .md files.
 * Delegates to pi SDK parseFrontmatter for robust YAML parsing.
 */

import { parseFrontmatter as parseSDK } from "@earendil-works/pi-coding-agent";
import type { FrontmatterFields, ParsedAgentDoc } from "./agents.types";

/**
 * Parse frontmatter from a markdown string using the pi SDK parser.
 */
export function parseFrontmatter(content: string): {
  frontmatter: FrontmatterFields;
  body: string;
} {
  try {
    const parsed = parseSDK<Record<string, unknown>>(content);
    return {
      frontmatter: parsed.frontmatter as unknown as FrontmatterFields,
      body: parsed.body,
    };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

/**
 * Validate parsed frontmatter has required fields.
 */
export function validateAgentFrontmatter(
  frontmatter: FrontmatterFields,
  filePath: string,
): string[] {
  const errors: string[] = [];

  if (!frontmatter.name) {
    errors.push(`Agent at ${filePath} missing required field: name`);
  } else if (!/^[\w.-]+$/.test(frontmatter.name)) {
    errors.push(`Agent '${frontmatter.name}': name must contain only word chars, dots, and hyphens`);
  }

  if (!frontmatter.description) {
    errors.push(`Agent '${frontmatter.name ?? "?"}' missing required field: description`);
  }

  return errors;
}

/**
 * Convert parsed frontmatter + body into a ParsedAgentDoc.
 */
export function makeParsedDoc(
  content: string,
  filePath: string,
  source: ParsedAgentDoc["source"],
): ParsedAgentDoc {
  const { frontmatter, body } = parseFrontmatter(content);
  return { frontmatter, body, filePath, source };
}
