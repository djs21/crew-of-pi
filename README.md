# crew-of-pi

**Async Non-Blocking Subagent Orchestration Extension for [pi](https://pi.dev)**

Spawn isolated subagents that work in parallel while your main session stays responsive. Each subagent runs in its own context window with specialized tools, skills, and extensions — orchestrated by a main agent that delegates automatically.

> Inspired by [pi-crew](https://github.com/melihmucuk/pi-crew) — extended with vertical slice architecture, per-agent extensibility, write/edit blocking for cost-efficient delegation, and an interactive config wizard.

---

## Features

- **🧹 Clean main context** — Subagents run in isolated sessions with their own context windows, keeping the main agent's context lean.
- **🧠 Memory efficient** — Subagents share the pi runtime (in-process AgentSession) instead of separate processes. ~3-5x less memory than child-process approach.
- **🔒 Main agent is read-only** — Main agent cannot `write` or `edit` files. All code changes are delegated to cheap `worker` subagents. Saves API costs.
- **⚡ Async non-blocking** — Subagents run in the background. Results are delivered as steering messages. Main agent stays interactive.
- **📋 Subagent listing** — `crew_list` shows available agent definitions and running subagents with status, turns, and costs.
- **💬 Inter-agent communication** — Subagents communicate via a message bus using text markers (`[ASK to:agent]`, `[TELL to:agent]`, `[HANDOFF to:agent]`, `[WAIT]`). Chain orchestrator parses markers and routes them through the bus. All communication is relayed to the main agent so it never loses context.
- **🤖 Automatic delegation** — System prompt injection makes the main agent aware of its crew. It decides: `scout` for recon, `planner` for planning, `worker` for code, `reviewer` for review.
- **🔌 Per-agent extensions** — Each subagent definition can load custom extensions (path-based or `pi install` packages). Different subagents get different capabilities.
- **⚙️ Config loader** — JSON-based agent overrides via `crew-of-pi.json` (`.pi/crew-of-pi.json` overrides `~/.pi/agent/crew-of-pi.json`).
- **💾 Session persistence + naming** — Subagent sessions persist as named session files (`crew: worker · JWT login`). Visible in `pi session list`, resumable via `/resume`.
- **📊 TUI status widget** — Live widget shows running subagents with real-time turns, token usage, and final status (completed/failed/aborted persist after finish).
- **🔐 Session ownership** — Each subagent is tracked to its spawning session. `crew_abort`, `crew_respond`, and `crew_done` validate ownership — preventing cross-session interference. `session_shutdown` aborts only owned agents.
- **⚠ Agent validation** — Invalid model format (`provider/model-id` required), unknown thinking levels, and missing frontmatter fields are caught at discovery and displayed as UI notifications.
- **🔗 Chain workflows** — Sequential multi-agent pipelines with `{previous}` placeholder injection. Chain steps appear in the TUI widget with live turn/context-token progress. Subagents can communicate across steps via marker protocol routed through the message bus.

---

## Installation

### Option 1: Local (Development)

Copy or symlink the extension into pi's extensions directory:

```bash
# If crew-of-pi is in your current project
mkdir -p ~/.pi/agent/extensions/crew-of-pi
cp -r /path/to/crew-of-pi/* ~/.pi/agent/extensions/crew-of-pi/

# Or symlink
ln -sf "$(pwd)/index.ts" ~/.pi/agent/extensions/crew-of-pi/index.ts
ln -sf "$(pwd)/shared" ~/.pi/agent/extensions/crew-of-pi/shared
ln -sf "$(pwd)/slices" ~/.pi/agent/extensions/crew-of-pi/slices
ln -sf "$(pwd)/agents" ~/.pi/agent/extensions/crew-of-pi/agents
ln -sf "$(pwd)/prompts" ~/.pi/agent/extensions/crew-of-pi/prompts
```

### Option 2: pi install (planned)

```bash
pi install git:github.com/user/crew-of-pi
```

### Verification

After installation, restart pi or run `/reload`. The extension auto-loads from `~/.pi/agent/extensions/crew-of-pi/`. You should see the `crew_spawn`, `crew_chain`, `crew_list`, `crew_abort`, `crew_respond`, and `crew_done` tools available.

---

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│                    MAIN PI SESSION                       │
│                                                          │
│  Main Agent (orchestrator, READ-ONLY)                    │
│  ├── Can: read, grep, find, ls, bash (read-only)        │
│  ├── Blocks: write, edit ← delegated to worker          │
│  │                                                       │
│  │  crew_spawn("worker", "implement login")              │
│  │  crew_spawn("scout", "find auth code")               │
│  │  crew_chain([scout → planner → worker])              │
│  │                                                       │
│  └── Results arrive as STEERING MESSAGES ↻               │
│                                                          │
└──────────────────────────────────────────────────────────┘
         │                                   ▲
         │ spawn (async, non-blocking)        │ steering message
         │ in-process AgentSession             │ (result)
         ▼                                   │
┌──────────────────────────────────────────────────────────┐
│               ISOLATED SUBAGENT SESSIONS                   │
│  (named session files, native turn tracking, compaction)  │
│                                                          │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌────────┐ │
│  │  Worker  │  │   Scout   │  │ Planner  │  │Reviewer│ │
│  │ write ✏️  │  │ read 👁️   │  │ read 👁️  │  │read 👁️  │ │
│  │  edit ✏️  │  │ grep 🔍   │  │ grep 🔍  │  │grep 🔍  │ │
│  │  bash ⚡  │  │ find 🔎   │  │ find 🔎  │  │ bash ⚡  │ │
│  │ deepseek $  │  │ deepseek $   │  │ deepseek $  │  │deepseek $  │ │
│  └──────────┘  └───────────┘  └──────────┘  └────────┘ │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## Usage

### Quick Start — Delegate a Task

```
> I need a login page with JWT authentication
```

The main agent (which is read-only) will automatically:

1. `crew_spawn("scout", "find all auth-related code in the project")`
2. When scout completes → steering message delivers results
3. `crew_spawn("planner", "create implementation plan for JWT login based on: {previous}")`
4. When planner completes → `crew_spawn("worker", "implement: {previous}")`
5. Worker writes the files → results sent back
6. `crew_spawn("reviewer", "review the implementation")`

All steps are **automatic** — the main agent decides the workflow based on the system prompt.

### Manual Spawning

```
> crew_spawn agent="scout" task="find all API endpoints and their authentication methods"
```

### Parallel Spawning

```
> spawn scout to find all models, and simultaneously spawn scout to find all controllers
```

The main agent can spawn multiple subagents in parallel. Each runs independently. Results arrive as they complete.

### Chain Workflow

```
> crew_chain with steps:
> 1. scout: find authentication code
> 2. planner: create implementation plan using {previous}
> 3. worker: implement the plan using {previous}
```

Each step's output replaces `{previous}` in the next step's task.

Chain steps appear in the TUI widget with live progress (turns, context tokens, status).

**Inter-agent markers in chain:** Subagents can communicate across steps using text markers in their output:

```
[ASK to:main] Should I use JWT or OAuth2 for this endpoint?
[TELL to:planner] API endpoints found: GET /users, POST /users, GET /users/:id
[HANDOFF to:worker] Full auth module spec ready for implementation
[WAIT] Need approval before proceeding with the database migration
```

The chain orchestrator strips markers from the `{previous}` pipeline and routes them through the message bus to the target agent. Messages addressed to a step are injected into that step's task as context.

### Check Status

```
> crew_list
```

Shows all available subagents and running ones with status, turns, and costs.

### Abort a Subagent

```
> crew_abort subagent_id="crew-scout-abc123"
> crew_abort all=true
```

### Respond to Interactive Subagent

```
> crew_respond subagent_id="crew-planner-xyz" message="yes, use the existing auth middleware"
```

### Close Interactive Session

```
> crew_done subagent_id="crew-planner-xyz"
```

---

## Slash Commands

### `/crew-of-pi config`

Interactive config editor for `crew-of-pi.json`. Manages per-agent overrides without manually editing JSON files.

| Subcommand | Description |
|---|---|
| `/crew-of-pi config` | Interactive wizard — pick an agent, then pick a field to edit |
| `/crew-of-pi config show` | Display current config as plain text |
| `/crew-of-pi config <agent> <field>` | Direct edit — skip wizard |
| `/crew-of-pi help` | Usage information |

**Editable fields per agent:**

| Field | Select from | Custom input |
|---|---|---|
| `model` | All available models from `ctx.modelRegistry.getAll()`, grouped by provider | Manual `provider/model-id` |
| `extensions` | Installed extensions from `~/.pi/agent/extensions/`, `settings.json` packages, and pluthenplay dev folders | Absolute path, `~/path`, `npm:`, `git:` |
| `skills` | Installed skills from `~/.pi/agent/skills/` with SKILL.md detection | Absolute path, `~/path` |

**Flow:**
1. Choose an agent (worker, scout, researcher, planner, reviewer, or custom)
2. Choose a field to edit
3. Pick from available options or enter a custom value
4. Automatically validates model format (`provider/model-id`) and path existence
5. Saves to `~/.pi/agent/crew-of-pi.json`
6. Notification: restart session for changes to take effect (`Ctrl+D` then `/start`)

**Tab completion:** `/crew-of-pi conf<TAB>` auto-completes subcommands and agent names.

---

## Tools Reference

### `crew_spawn`

Spawn a single subagent asynchronously.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent` | string | ✅ | Agent name (worker, scout, planner, reviewer, researcher) |
| `task` | string | ✅ | Task description for the subagent |
| `model` | string | ❌ | Override the agent's model |
| `interactive` | boolean | ❌ | Keep session alive for multi-turn |
| `agentScope` | string | ❌ | `user`, `project`, or `both` (default: `user`) |
| `cwd` | string | ❌ | Working directory (default: current) |

**Returns:** `{ subagent_id, status: "spawned" }`

**Result arrives later as a steering message:**
```
✅ worker (crew-worker-a1b2) completed:

## Completed
Implemented JWT authentication module
...
```

### `crew_chain`

Execute sequential multi-agent workflow.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chain` | array | ✅ | Array of `{ agent, task, cwd? }` steps |
| `stopOnError` | boolean | ❌ | Stop chain on step failure (default: true) |

Each step's output is injected into the next via `{previous}`. Chain steps appear in the TUI widget with live turn/context-token progress.

**Marker protocol:** Subagents can use text markers for cross-step communication:
- `[ASK to:<agent>] question` — request clarification
- `[TELL to:<agent>] message` — send information
- `[HANDOFF to:<agent>] context` — transfer work context
- `[WAIT] reason` — request main agent intervention

Markers are parsed by the orchestrator, routed through the message bus, and relayed to the main agent as steering messages. Text outside markers passes to the next step via `{previous}`.

**Returns after all steps complete:**
```
## Goal
Implement JWT-based authentication
## Plan
1. Create auth middleware...
...
```

### `crew_list`

List available agents and running subagents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | — | — | Lists all agents + running status |

### `crew_abort`

Abort one or all running subagents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subagent_id` | string | ❌ | ID of specific subagent to abort |
| `all` | boolean | ❌ | Abort all running subagents |

### `crew_respond`

Send follow-up to an interactive subagent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subagent_id` | string | ✅ | Target subagent ID |
| `message` | string | ✅ | Message to send |

### `crew_done`

Close an interactive subagent session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subagent_id` | string | ✅ | Subagent to close |

---

## Bundled Subagents

5 subagents ship with crew-of-pi. Each uses a cost-efficient model for delegation.

| Agent | Purpose | Tools | Model | Interactive |
|-------|---------|-------|-------|-------------|
| **worker** | General implementation with full write capabilities | `read, write, edit, grep, find, ls, bash` | `opencode/deepseek-v4-flash-free` | No |
| **scout** | Fast codebase recon, returns structured findings | `read, grep, find, ls, bash` | `openrouter/deepseek/deepseek-v4-flash` | No |
| **researcher** | Deep codebase research and analysis | `read, grep, find, ls, bash` | `deepseek/deepseek-v4-flash` | No |
| **planner** | Creates implementation plans (read-only) | `read, grep, find, ls` | `claudinio/claudinio` | No |
| **reviewer** | Code review for quality, security, maintainability | `read, grep, find, ls, bash` | `openrouter/deepseek/deepseek-v4-pro` | No |

### Example Worker Output Format

```markdown
## Completed
Implemented the JWT authentication middleware.

## Files Changed
- `src/middleware/auth.ts` — New JWT verification middleware
- `src/routes/auth.routes.ts` — Login and token refresh endpoints
- `src/utils/jwt.ts` — JWT sign/verify utilities

## Notes
- Tokens expire in 24 hours by default
- Refresh token rotation enabled
- Passwords hashed with bcrypt
```

---

## Custom Subagents

Define your own subagents as Markdown files with YAML frontmatter.

### Location & Priority

Subagents are discovered from **3 locations** in priority order:

1. **Project-local:** `.pi/agents/*.md` (highest priority)
2. **User-global:** `~/.pi/agent/agents/*.md`
3. **Bundled:** `~/.pi/agent/extensions/crew-of-pi/agents/*.md` (lowest priority)

When subagents share the same `name`, the higher-priority source overrides the lower one.

### Frontmatter Schema

```markdown
---
# Required
name: my-agent                  # Unique ID, no whitespace (use hyphens)
description: What this agent does

# Optional — Runtime
model: opencode/deepseek-v4-flash-free  # provider/model-id
thinking: off                           # off | minimal | low | medium | high | xhigh
tools: read, write, grep, find, ls      # comma-separated tool list
skills: ast-grep, my-skill              # comma-separated skill names
interactive: false                      # keep session alive for multi-turn
compaction: true                        # enable context compaction

# NEW — Extension Loading
extensions:
  - ~/.pi/agent/extensions/git-checkpoint.ts                    # absolute path (~ expansion)
  - ../../project-extensions/custom-linter.ts                   # relative path (from agent .md location)
  - npm:@earendil-works/pi-git-checkpoint                       # pi package from npm
  - git:github.com/user/security-auditor@v1.2.0                 # pi package from git
---

Your system prompt goes here. This is the body of the markdown file.

The subagent follows these instructions when executing tasks.
```

### Extension Loading Per Subagent

Each subagent loads **only** the extensions listed in its `extensions` field. Extension loading is controlled via the `DefaultResourceLoader` — extensions not in the agent's list are stripped by the `extensionsOverride` filter. This means:

- **Worker** with `git-checkpoint`: auto-stash before edits, rollback on failure
- **Scout** with `[]`: no extensions needed, pure read-only
- **Security-auditor** with `npm:security-linter`: custom security analysis tools

Supported extension reference formats:

| Format | Example | Type |
|--------|---------|------|
| `~/.pi/...` | `~/.pi/agent/extensions/my-tool.ts` | path |
| `/absolute/...` | `/home/user/projects/my-ext/index.ts` | path |
| `relative/...` | `../../project-ext/custom.ts` | path (from agent .md location) |
| `npm:@scope/pkg` | `npm:@vendor/pi-tool` | pi-package |
| `git:github.com/...` | `git:github.com/user/ext@v1.0` | pi-package |

### Example: Custom Worker with Git Checkpoint

**`~/.pi/agent/agents/worker.md`** (overrides bundled worker):

```markdown
---
name: worker
description: Worker with git checkpoint for safe edits
tools: read, write, edit, grep, find, ls, bash
model: anthropic/claude-sonnet-4-5
interactive: false
extensions:
  - npm:@earendil-works/pi-git-checkpoint
---

You are a worker agent. Execute the assigned implementation task.

Before any file modifications, use git_checkpoint to create a safe restore point.
If the task fails, roll back to the last checkpoint.

Output format:
## Completed — what was done
## Files Changed — list with descriptions
```

### Config Overrides (JSON)

Config overrides are loaded via the **config loader** from two locations. Project-level config (`.pi/crew-of-pi.json`) overrides global-level config (`~/.pi/agent/crew-of-pi.json`), giving you per-project customization without affecting other projects.

You can override subagent frontmatter fields without editing the `.md` files:

**`~/.pi/agent/crew-of-pi.json`** (global):
```json
{
  "agents": {
    "worker": {
      "model": "anthropic/claude-sonnet-4-5",
      "thinking": "low"
    },
    "scout": {
      "tools": ["read", "grep", "find", "ls"]
    }
  }
}
```

**.pi/crew-of-pi.json** (project-level, overrides global):
```json
{
  "agents": {
    "planner": {
      "thinking": "high"
    }
  }
}
```

---

## Workflow Templates

Crew-of-pi includes prompt templates that expand into chain workflows:

### `/implement`

Full implementation workflow — scout → planner → worker.

```
> /implement add Redis caching to the session store
```

Expands to:
```
crew_chain:
1. scout → find all session-related code
2. planner → create plan using {previous}
3. worker → implement using {previous}
```

### `/research`

Research workflow — scout → researcher.

```
> /research understand the authentication flow in this codebase
```

---

## TUI Widget

When subagents are running, a live status widget appears in the TUI:

**Widget updates in real-time during execution and keeps all statuses visible:**

**Parallel spawns (crew_spawn):**

```
┌─ Crew ──────────────────────────────────────────────────┐
│ ⏳ scout-abc123    [running]    2 turns   ctx:4.2k       │
│ ⏳ worker-def456   [running]    5 turns   ctx:12.1k      │
│ ✅ planner-ghi789  [completed]  3 turns   $0.042         │
│ ❌ reviewer-jkl0   [aborted]                              │
└─────────────────────────────────────────────────────────┘
```

**Chain workflow (crew_chain):** Steps appear sequentially with live progress — turns and context tokens update in real-time. Previous steps persist with ✅/❌ so you can see the full pipeline state.

**Widget updates automatically on:**
- Subagent spawned → row added (⏳ 0 turns)
- Each turn during execution → turns + context tokens update live
- Subagent completed/failed/aborted → status icon updates, row remains visible
- Session reload → restored from session entries

---

## Architecture

Crew-of-pi uses **vertical slice architecture**. Each capability is self-contained:

```
crew-of-pi/
├── index.ts                    # Entry point: imports & mounts all slices
├── shared/types.ts             # Shared interfaces (contract between slices)
├── slices/
│   ├── agents/                 # Agent discovery + registry
│   ├── spawn/                  # Async subagent spawning
│   ├── blockers/               # Write/edit blocking for main agent
│   ├── prompt/                 # System prompt injection
│   ├── chain/                  # Sequential multi-agent workflows
│   ├── comms/                  # Inter-agent message bus
│   ├── lifecycle/              # Abort, respond, done
│   ├── widget/                 # TUI status widget
│   ├── crew-list/              # crew_list tool
│   └── config/                 # /crew-of-pi config slash command
├── agents/                     # Bundled subagent definitions (.md)
├── docs/                       # Design documents, audit findings, plans
└── prompts/                    # Workflow templates
```

## DOX Framework

The project uses **DOX** (Document-Oriented eXecution) with an `AGENTS.md` hierarchy. Every file/folder has a DOX owner that defines its purpose, contracts, and verification rules. The hierarchy:

```
AGENTS.md (root) — project-wide rules, DOX framework, beads workflow
├── slices/AGENTS.md           — architecture, inter-slice contracts, naming
├── agents/AGENTS.md           — agent frontmatter schema, bundled specs
├── prompts/AGENTS.md          — template structure, chain steps
├── docs/AGENTS.md             — documentation standards, audit trails
└── shared/AGENTS.md           — type contracts, cross-slice interface governance
```

Key rules:
- Read the nearest `AGENTS.md` before editing any path
- Update owning AGENTS.md when behavior/contracts change
- DOX closeout: re-check changed paths, update affected docs, remove stale text

**Design principles:**
- Each slice is self-contained — develop, test, and remove independently
- Cross-slice communication only through `shared/types.ts` interfaces
- Add/remove features by adding/removing slice imports in `index.ts`
- Slash commands registered via `pi.registerCommand()` in their slice

---

## Event Hooks

Crew-of-pi registers **6 event hooks** across 4 pi extension events to orchestrate lifecycle, enforce policies, and update the TUI:

| Hook | Registration | Slice | Purpose |
|------|-------------|-------|---------|
| `session_start` | `index.ts` | agents + blockers + prompt | Discover agents, load config, set block policy, restore message bus |
| `session_start` | `widget/widget.updater.ts` | widget | Sync TUI widget state on session init |
| `session_shutdown` | `index.ts` | agents + lifecycle | Dispose owned subagent sessions, reset registry/bus/store |
| `session_shutdown` | `widget/widget.updater.ts` | widget | Clear widget state on shutdown |
| `before_agent_start` | `prompt/prompt.injector.ts` | prompt | Inject subagent crew description into main agent's system prompt |
| `tool_call` | `blockers/blockers.intercept.ts` | blockers | Block `write`/`edit` on main agent — delegate to worker instead |

All hooks are registered in `index.ts` via slice `register*` functions, keeping each slice self-contained.

---

## Architecture Evolution

The codebase underwent several consolidations to reduce file count and eliminate duplication:

| Consolidation | Before | After | Savings |
|--------------|--------|-------|---------|
| **Agent discovery pipeline** | 5 files (config, frontmatter, types, discovery, registry) | 2 files (discovery + registry) | 3 files removed |
| **Comms slice** | 4 files (bus, relay, persistence, types) | 1 file (`comms.ts`) | 3 files removed |
| **Lifecycle triplet** | 3 files inlining same ownership validation | 1 shared module (`lifecycle.shared.ts`) + 3 thin tools | Shared validation in one place |
| **Dual handle in spawn** | Inner handle created then field-copied to outer | Single handle mutated in-place | No field copying, simpler abort-race guards |
| **Chain step types** | Duplicated in `shared/types.ts` + `chain.types.ts` | Single source in `chain.types.ts` | Usage tracking added per step |
| **Spawning mechanism** | `child_process.spawn("pi", ...)` | `createAgentSession()` (SDK native) | 3-5x memory savings, native turn tracking, session naming |

---

## Design Documents

The `docs/` directory contains durable design records and audit findings:

| Document | Lines | Content |
|----------|-------|---------|
| [plan.md](./docs/plan.md) | 681 | Original architecture plan — design decisions, implementation details, timeline |
| [plan-migrate-create-agent-session.md](./docs/plan-migrate-create-agent-session.md) | 319 | Migration plan: `child_process` → `createAgentSession` (gap #9 fix) |
| [findings-2025-06-13.md](./docs/findings-2025-06-13.md) | 81 | Codebase audit — 12 findings, 9 fixed, 1 skipped |
| [findings-2025-06-14-pi-crew-comparison.md](./docs/findings-2025-06-14-pi-crew-comparison.md) | 413 | crew-of-pi vs pi-crew comparison — 13 temuan, 2 HIGH, 3 MEDIUM |
| [improve-architecture.md](./docs/improve-architecture.md) | 170 | Architecture improvement record — 5 consolidations (2025-06-18) |
| [crew-of-pi-example.json](./docs/crew-of-pi-example.json) | 25 | Example `crew-of-pi.json` config for reference |

**Note:** `plan.md` is historical — it reflects initial design intent. Implementation may have diverged; check `AGENTS.md` files for current behavior.

---

## Configuration

### Main Agent Write Blocking

By default, the main agent cannot `write` or `edit`. This is enforced via the `tool_call` interceptor. The block policy can be configured at runtime:

```typescript
// In a custom extension
setBlockPolicy({
  blockedTools: [
    { toolName: "write", reason: "Use crew_spawn to delegate" },
    { toolName: "edit", reason: "Use crew_spawn to delegate" },
  ],
  allowBashReadOnly: true,  // Allow git, grep, etc. in bash
});
```

### System Prompt Injection

The system prompt tells the main agent about available subagents. Configurable:

```typescript
setPromptConfig({
  enabled: true,
  includeAgentDescriptions: true,    // Show agent list with descriptions
  includeAgentExtensions: true,      // Show extensions loaded per agent
  includeRules: true,                // Show delegation rules
  customRules: [
    "Always use scout before planner to get context.",
    "Prefer parallel spawning for independent tasks.",
  ],
});
```

---

## Session Persistence + Naming

Each subagent runs in a named `AgentSession` with its own session file (`~/.pi/sessions/crew-*.session.json`). This means:

- **Named sessions** — `pi session list` shows `crew: worker · JWT login`
- **Resumable** — `/resume crew-worker-abc` opens the subagent's conversation
- **Full history** — Every turn, tool call, and result is stored in the session file
- **Lifecycle** — Subagents persist across `/reload`, `/resume`, and session restarts

Additional tracking via session entries:

- Running subagents are tracked via `crew-subagent-spawn` entries
- Completed results stored in `crew-subagent-result` entries
- Inter-agent messages stored in `crew-bus-message` entries
- Widget state restored on `session_start`

---

## Cost Efficiency

The main agent delegates code changes to cheap subagent models:

| Role | Model | Read/Write | Relative Cost |
|------|-------|-----------|---------------|
| Main Orchestrator | Session default (e.g., sonnet) | Read-only | $$$—$$$$ |
| Worker | opencode/deepseek-v4-flash-free | Read + Write | $ (free) |
| Scout | openrouter/deepseek/deepseek-v4-flash | Read-only | $ |
| Researcher | deepseek/deepseek-v4-flash | Read-only | $ |
| Planner | claudinio/claudinio | Read-only | $ |
| Reviewer | openrouter/deepseek/deepseek-v4-pro | Read-only | $$ |

The main agent only does **thinking & orchestration** (reading codebase, planning delegation). All expensive write operations run on cheap models in isolated sessions.

**Memory efficiency:** Because subagents share the pi runtime (in-process AgentSession), there's no per-subagent pi process overhead. Memory usage scales linearly with conversation history (~3MB/session) instead of spiking ~120MB per child process.

---

## Security

1. **Project-local agents** (`.pi/agents/*.md`) only load for trusted projects.
2. **Extension loading** from project-local paths requires trust confirmation.
3. **Subagent processes** inherit `cwd` from the main session.
4. **No network isolation** — subagents have same network access as main.
5. **Worker subagents can write files** — design your task scope carefully.

---

## Troubleshooting

### "Unknown agent: X"

Run `crew_list` to see available agents. If a custom agent isn't showing:
- Check the file is in `.pi/agents/` or `~/.pi/agent/agents/`
- Verify the `.md` file has valid YAML frontmatter with `name` and `description`
- Check for UI notifications at session start — invalid model format, unknown thinking levels, or whitespace in agent names will show warnings
- Run `/reload` if you just added the file

### Subagent seems stuck

Check the TUI widget — if a subagent shows `running` for a long time:
- Run `crew_list` to check status
- Run `crew_abort subagent_id="..."` to cancel it
- The main agent will be notified of the abort

### "Main agent is read-only" error

This is by design. The main agent cannot `write` or `edit`. Delegate to `worker`:
```
crew_spawn agent="worker" task="implement the changes described above"
```

### Extension not loading

- Verify the extension is at `~/.pi/agent/extensions/crew-of-pi/index.ts`
- Run `/reload` in pi
- Check pi's startup logs for load errors
- Make sure `@earendil-works/pi-coding-agent` and `typebox` are available

---

## Development

### Testing

```bash
# Test extension loading
pi -e ~/.pi/agent/extensions/crew-of-pi/index.ts

# Run with debug
pi --verbose

# Check tools are registered
crew_list   # in pi session
```

### Adding a New Slice

1. Create folder `slices/your-slice/`
2. Create `slices/your-slice/your-slice.types.ts`
3. Implement the slice in `slices/your-slice/your-slice.module.ts`
4. Import and mount in `index.ts`

### Adding a New Bundled Agent

1. Create `agents/new-agent.md` with frontmatter
2. Write the system prompt in the body
3. Run `/reload` — it will be auto-discovered

---

## License

MIT — See [LICENSE](./LICENSE)
