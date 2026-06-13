/**
 * YAML frontmatter parser for agent .md files.
 * Parses --- delimited frontmatter at the top of markdown files.
 */

import type { FrontmatterFields, ParsedAgentDoc } from "./agents.types";

/**
 * Parse frontmatter from a markdown string.
 * Extracts content between --- delimiters at the start of file.
 */
export function parseFrontmatter(content: string): {
  frontmatter: FrontmatterFields;
  body: string;
} {
  const lines = content.split("\n");

  // Must start with ---
  if (lines.length < 1 || !lines[0].trim().startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  // Find closing ---
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("---")) {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  // Parse YAML-like key-value pairs
  const frontmatter: FrontmatterFields = {};
  const yamlLines = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join("\n").trim();

  let currentKey: string | null = null;

  for (const line of yamlLines) {
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith("#")) continue;

    // Check for array items (list entries under a key)
    const arrayMatch = trimmed.match(/^-\s+(.+)$/);
    if (arrayMatch && currentKey) {
      const value = arrayMatch[1].trim();
      (frontmatter as any)[currentKey] = (frontmatter as any)[currentKey] || [];
      (frontmatter as any)[currentKey].push(value);
      continue;
    }

    // Check for key: value pairs
    const kvMatch = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      let value: string | boolean | string[] = kvMatch[2].trim();

      // Handle empty value (could be list on next lines)
      if (value === "") {
        (frontmatter as any)[currentKey] = [];
        continue;
      }

      // Handle quoted strings
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Handle booleans
      if (value === "true") value = true;
      else if (value === "false") value = false;

      (frontmatter as any)[currentKey] = value;
    }
  }

  return { frontmatter, body };
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
