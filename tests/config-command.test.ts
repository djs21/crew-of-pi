import test from "node:test";
import assert from "node:assert/strict";
import {
  CUSTOM_MODEL_OPTION,
  buildDenyRows,
  buildHelpText,
  buildModelChoices,
  classifySubcommand,
  collectDeniedFromRows,
  computeArgumentCompletions,
} from "../slices/config";

// ─── S1: classifySubcommand ─────────────────────────────────────────
// RED: the guard must be expressible as data, so an unknown or partial
// subcommand can never fall through into the interactive picker.

test("S1: empty args classify as menu", () => {
  assert.deepEqual(classifySubcommand(""), { kind: "menu" });
});

test("S1: help aliases classify as help", () => {
  assert.deepEqual(classifySubcommand("help"), { kind: "help" });
  assert.deepEqual(classifySubcommand("-h"), { kind: "help" });
  assert.deepEqual(classifySubcommand("--help"), { kind: "help" });
});

test("S1: unknown subcommand classifies as unknown, never menu", () => {
  assert.deepEqual(classifySubcommand("bogus"), { kind: "unknown", sub: "bogus" });
});

test("S1: partial model subcommand classifies as incomplete, never menu", () => {
  assert.deepEqual(classifySubcommand("model"), { kind: "incomplete", sub: "model" });
  assert.deepEqual(classifySubcommand("model worker"), { kind: "incomplete", sub: "model" });
});

test("S1: complete model subcommand carries agent, model and default scope", () => {
  assert.deepEqual(classifySubcommand("model worker miayam/worker"), {
    kind: "model",
    agent: "worker",
    model: "miayam/worker",
    scope: "global",
  });
});

test("S1: explicit project scope is honoured", () => {
  assert.deepEqual(classifySubcommand("model worker miayam/worker project"), {
    kind: "model",
    agent: "worker",
    model: "miayam/worker",
    scope: "project",
  });
});

test("S1: deny splits the comma separated tool list", () => {
  assert.deepEqual(classifySubcommand("deny worker write,replace"), {
    kind: "deny",
    agent: "worker",
    tools: ["write", "replace"],
    scope: "global",
  });
});

// ─── S2: buildHelpText ──────────────────────────────────────────────
// The help text is the user-facing contract for the command surface, so it
// must name every reachable subcommand.

test("S2: help text names every subcommand and the command itself", () => {
  const text = buildHelpText();
  assert.ok(text.includes("/crew-of-pi"), "must name the command");
  for (const sub of ["show", "model", "deny", "reset", "menu", "help"]) {
    assert.ok(text.includes(sub), `help text must document "${sub}"`);
  }
});

// ─── S3: computeArgumentCompletions ─────────────────────────────────

test("S3: empty prefix offers every subcommand", () => {
  const items = computeArgumentCompletions("", ["worker"]);
  assert.ok(items, "expected completions for an empty prefix");
  assert.deepEqual(
    items.map((i) => i.value).sort(),
    ["deny", "help", "menu", "model", "reset", "show"],
  );
});

test("S3: prefix narrows the subcommand list", () => {
  const items = computeArgumentCompletions("mod", ["worker"]);
  assert.deepEqual(items, [
    { value: "model", label: "model", description: "Set an agent model override" },
  ]);
});

test("S3: unmatched prefix returns null, never an empty list", () => {
  assert.equal(computeArgumentCompletions("xyz", ["worker"]), null);
});

test("S3: after model/deny the completion offers agent names", () => {
  const items = computeArgumentCompletions("model ", ["worker", "scout"]);
  assert.deepEqual(
    items?.map((i) => i.value),
    ["model worker", "model scout"],
  );
});

test("S3: agent names are filtered by the typed fragment", () => {
  const items = computeArgumentCompletions("deny wo", ["worker", "scout"]);
  assert.deepEqual(items?.map((i) => i.value), ["deny worker"]);
});

test("S3: reset completes the scope", () => {
  const items = computeArgumentCompletions("reset ", []);
  assert.deepEqual(
    items?.map((i) => i.value),
    ["reset global", "reset project"],
  );
});

test("S3: menu takes no further arguments", () => {
  assert.equal(computeArgumentCompletions("menu ", []), null);
});

// ─── S4: buildModelChoices ──────────────────────────────────────────

test("S4: custom input always comes first", () => {
  assert.equal(buildModelChoices([])[0], CUSTOM_MODEL_OPTION);
});

test("S4: labels are provider/id, sorted and de-duplicated", () => {
  const choices = buildModelChoices([
    { provider: "zeta", id: "b" },
    { provider: "alpha", id: "a" },
    { provider: "zeta", id: "b" },
  ]);
  assert.deepEqual(choices, [CUSTOM_MODEL_OPTION, "alpha/a", "zeta/b"]);
});

// ─── S5: buildDenyRows / collectDeniedFromRows ──────────────────────

test("S5: locked tools are always denied and cannot be toggled", () => {
  const rows = buildDenyRows(["crew_spawn", "read"], ["read"], ["crew_spawn"]);
  assert.deepEqual(rows, [
    { name: "crew_spawn", value: "denied", locked: true },
    { name: "read", value: "denied", locked: false },
  ]);
});

test("S5: rows are sorted and unlisted tools default to allowed", () => {
  const rows = buildDenyRows(["write", "bash", "read"], [], []);
  assert.deepEqual(
    rows.map((r) => [r.name, r.value]),
    [
      ["bash", "allowed"],
      ["read", "allowed"],
      ["write", "allowed"],
    ],
  );
});

test("S5: locked tools never leak into the persisted denylist", () => {
  const rows = buildDenyRows(["crew_spawn", "write", "read"], ["write"], ["crew_spawn"]);
  assert.deepEqual(collectDeniedFromRows(rows), ["write"]);
});
