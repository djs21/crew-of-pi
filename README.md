# crew-of-pi

**Async Non-Blocking Subagent Orchestration Extension for [pi](https://pi.dev)**

Spawn isolated subagents that work in parallel while your main session stays responsive. Each subagent runs in its own context window with specialized tools, skills, and extensions — orchestrated by a main agent that delegates automatically.

> Inspired by [pi-crew](https://github.com/melihmucuk/pi-crew) — extended with vertical slice architecture, per-agent extensibility, and write/edit blocking for cost-efficient delegation.

---

## Features

- **🧹 Clean main context** — Subagents run in isolated `pi` processes (`--no-session`), keeping the main agent's context window lean.
- **🔒 Main agent is read-only** — Main agent cannot `write` or `edit` files. All code changes are delegated to cheap `worker` subagents. Saves API costs.
- **⚡ Async non-blocking** — Subagents run in the background. Results are delivered as steering messages. Main agent stays interactive.
- **💬 Inter-agent communication** — Subagents can talk to each other via a message bus. All communication is relayed to the main agent so it never loses context.
- **🤖 Automatic delegation** — System prompt injection makes the main agent aware of its crew. It decides: `scout` for recon, `planner` for planning, `worker` for code, `reviewer` for review.
- **🔌 Per-agent extensions** — Each subagent definition can load custom extensions (path-based or `pi install` packages). Different subagents get different capabilities.
- **📊 TUI status widget** — Live widget shows running subagents with status, turns, and token usage.
- **🔗 Chain workflows** — Sequential multi-agent pipelines with `{previous}` placeholder injection.

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
         │ --no-session --no-extensions        │ (result)
         ▼                                   │
┌──────────────────────────────────────────────────────────┐
│              ISOLATED SUBAGENT PROCESSES                  │
│                                                          │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌────────┐ │
│  │  Worker  │  │   Scout   │  │ Planner  │  │Reviewer│ │
│  │ write ✏️  │  │ read 👁️   │  │ read 👁️  │  │read 👁️  │ │
│  │  edit ✏️  │  │ grep 🔍   │  │ grep 🔍  │  │grep 🔍  │ │
│  │  bash ⚡  │  │ find 🔎   │  │ find 🔎  │  │ bash ⚡  │ │
│  │ haiku $  │  │ haiku $   │  │ haiku $  │  │haiku $  │ │
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

5 subagents ship with crew-of-pi. All use cheap models (`claude-haiku-4-5`) for cost-efficient delegation.

| Agent | Purpose | Tools | Model | Interactive |
|-------|---------|-------|-------|-------------|
| **worker** | General implementation with full write capabilities | `read, write, edit, grep, find, ls, bash` | `anthropic/claude-haiku-4-5` | No |
| **scout** | Fast codebase recon, returns structured findings | `read, grep, find, ls, bash` | `anthropic/claude-haiku-4-5` | No |
| **researcher** | Deep codebase research and analysis | `read, grep, find, ls, bash` | `anthropic/claude-haiku-4-5` | No |
| **planner** | Creates implementation plans (read-only) | `read, grep, find, ls` | `anthropic/claude-haiku-4-5` | No |
| **reviewer** | Code review for quality, security, maintainability | `read, grep, find, ls, bash` | `anthropic/claude-haiku-4-5` | No |

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
model: anthropic/claude-haiku-4-5      # provider/model-id
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

Each subagent loads **only** the extensions listed in its `extensions` field. The default spawn uses `--no-extensions` to prevent inherited extensions from the main session. This means:

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

```
┌─ Crew ──────────────────────────────────────────────────┐
│ 🟢 scout-abc123    [running]   2 turns   ctx:4.2k       │
│ 🟢 worker-def456   [running]   5 turns   ctx:12.1k      │
│ ✅ planner-ghi789  [done]      3 turns   $0.042         │
│ ❌ reviewer-jkl0   [aborted]                             │
│ ─── 2 running, 4 total ───                              │
└─────────────────────────────────────────────────────────┘
```

**Widget updates automatically on:**
- Subagent spawned → row added
- Subagent completed → status updated with cost
- Subagent failed/aborted → error status
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
│   └── widget/                 # TUI status widget
├── agents/                     # Bundled subagent definitions (.md)
└── prompts/                    # Workflow templates
```

**Design principles:**
- Each slice is self-contained — develop, test, and remove independently
- Cross-slice communication only through `shared/types.ts` interfaces
- Add/remove features by adding/removing slice imports in `index.ts`

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

## Session Persistence

All subagent state is persisted to session entries. If you `/resume`, `/reload`, or `/new`/`/fork`:

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
| Worker | claude-haiku-4-5 | Read + Write | $ |
| Scout | claude-haiku-4-5 | Read-only | $ |
| Researcher | claude-haiku-4-5 | Read-only | $ |
| Planner | claude-haiku-4-5 | Read-only | $ |
| Reviewer | claude-haiku-4-5 | Read-only | $ |

The main agent only does **thinking & orchestration** (reading codebase, planning delegation). All expensive write operations run on cheap models in isolated contexts.

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
