import test from "node:test";
import assert from "node:assert/strict";
import { buildSubagentSystemPrompt } from "../slices/spawn";
import { DEFAULT_PROMPT_CONFIG } from "../slices/prompt";
import type { AgentConfig } from "../shared/types";

function createMockAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "A test subagent",
    systemPrompt: "You are a test operative with a specialized mission.",
    source: "user",
    filePath: "/test/agent.md",
    ...overrides,
  };
}

test("buildSubagentSystemPrompt: accommodates and preserves agent primary character", () => {
  const scout = createMockAgent({
    name: "scout",
    description: "Fast codebase reconnaissance",
    systemPrompt: "You are a scout. Quickly investigate a codebase and return structured findings.",
  });

  const prompt = buildSubagentSystemPrompt(scout);

  assert.match(prompt, /You are a scout\. Quickly investigate a codebase/);
  assert.match(prompt, /# Character & Mission: scout/i);
});

test("buildSubagentSystemPrompt: falls back to description if systemPrompt is empty", () => {
  const custom = createMockAgent({
    name: "custom-bot",
    description: "Handles bespoke database migrations",
    systemPrompt: "",
  });

  const prompt = buildSubagentSystemPrompt(custom);

  assert.match(prompt, /Handles bespoke database migrations/);
  assert.match(prompt, /# Character & Mission: custom-bot/i);
});

test("buildSubagentSystemPrompt: injects OODA Loop operating discipline", () => {
  const agent = createMockAgent({ name: "worker" });
  const prompt = buildSubagentSystemPrompt(agent);

  assert.match(prompt, /OODA Loop/i);
  assert.match(prompt, /Observe/i);
  assert.match(prompt, /Orient/i);
  assert.match(prompt, /Decide/i);
  assert.match(prompt, /Act/i);
});

test("buildSubagentSystemPrompt: accommodates persona-specific OODA behavior", () => {
  const scout = createMockAgent({ name: "scout" });
  const scoutPrompt = buildSubagentSystemPrompt(scout);
  assert.match(scoutPrompt, /recon|investigat|coordinates|anchors/i);

  const worker = createMockAgent({ name: "worker" });
  const workerPrompt = buildSubagentSystemPrompt(worker);
  assert.match(workerPrompt, /minimal|verif|clean|diff/i);

  const reviewer = createMockAgent({ name: "reviewer" });
  const reviewerPrompt = buildSubagentSystemPrompt(reviewer);
  assert.match(reviewerPrompt, /adversarial|audit|regression|security/i);

  const planner = createMockAgent({ name: "planner" });
  const plannerPrompt = buildSubagentSystemPrompt(planner);
  assert.match(plannerPrompt, /sequenc|dependenc|risk|step/i);

  const researcher = createMockAgent({ name: "researcher" });
  const researcherPrompt = buildSubagentSystemPrompt(researcher);
  assert.match(researcherPrompt, /primary source|architect|compar/i);
});

test("buildSubagentSystemPrompt: enforces ironclad OODA guardrails", () => {
  const agent = createMockAgent({ name: "operative" });
  const prompt = buildSubagentSystemPrompt(agent);

  // Guardrail 1: Read before write/edit
  assert.match(prompt, /read before (you )?(write|edit)/i);

  // Guardrail 2: Confined to project root
  assert.match(prompt, /project root|workspace/i);

  // Guardrail 3: Safe introspection & no destructive bash
  assert.match(prompt, /destructive/i);

  // Guardrail 4: No guessing or hallucinating
  assert.match(prompt, /guess|hallucinat|assum/i);
});

test("DEFAULT_PROMPT_CONFIG: embeds Orc orchestrator and OODA doctrine", () => {
  assert.match(DEFAULT_PROMPT_CONFIG.preamble, /The Orc|Orchestrator|OODA/i);
  const rulesJoined = DEFAULT_PROMPT_CONFIG.rules.join(" ");
  assert.match(rulesJoined, /Observe/i);
  assert.match(rulesJoined, /Orient/i);
  assert.match(rulesJoined, /Decide/i);
  assert.match(rulesJoined, /Act/i);
  assert.match(rulesJoined, /Guardrails/i);
});
