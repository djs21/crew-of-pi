import test from "node:test";
import assert from "node:assert/strict";
import { computeEffectiveDenyList, filterSubagentTools, GLOBAL_DENIED_TOOLS } from "../slices/spawn";
import type { AgentConfig } from "../shared/types";

test("TDD Seam 1: computeEffectiveDenyList merges frontmatter, config override, and anti-recursion", () => {
  const agentConfig: AgentConfig = {
    name: "researcher",
    description: "test",
    source: "bundled",
    filePath: "/test/researcher.md",
    systemPrompt: "test",
    extensions: [],
    interactive: false,
    compaction: true,
    denyTools: ["write", "replace"],
  };

  const effective = computeEffectiveDenyList(agentConfig);
  assert.ok(effective.includes("write"));
  assert.ok(effective.includes("replace"));
  for (const tool of GLOBAL_DENIED_TOOLS) {
    assert.ok(effective.includes(tool), `Must deny ${tool}`);
  }
});

test("TDD Seam 2: filterSubagentTools strips denied tools and anti-recursion tools", () => {
  const tools = [
    { name: "read" },
    { name: "write" },
    { name: "replace" },
    { name: "explore_code" },
    { name: "crew_spawn" },
    { name: "crew_list" },
  ];

  const denylist = ["write", "replace", ...GLOBAL_DENIED_TOOLS];
  const allowed = filterSubagentTools(tools, denylist);

  const allowedNames = allowed.map((t) => t.name);
  assert.deepEqual(allowedNames, ["read", "explore_code", "crew_list"]);
});

test("TDD Seam 3: worker agent with empty denyTools inherits all tools except anti-recursion", () => {
  const workerConfig: AgentConfig = {
    name: "worker",
    description: "test",
    source: "bundled",
    filePath: "/test/worker.md",
    systemPrompt: "test",
    extensions: [],
    interactive: false,
    compaction: true,
  };

  const allTools = [
    { name: "read" },
    { name: "write" },
    { name: "replace" },
    { name: "insert" },
    { name: "explore_code" },
    { name: "bash" },
    { name: "crew_spawn" },
    { name: "crew_chain" },
  ];

  const effective = computeEffectiveDenyList(workerConfig);
  const allowed = filterSubagentTools(allTools, effective);
  const allowedNames = allowed.map((t) => t.name);

  assert.deepEqual(allowedNames, ["read", "write", "replace", "insert", "explore_code", "bash"]);
});
