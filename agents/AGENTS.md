# agents — Bundled Subagent Definitions

## Purpose

Bundled subagent definitions that ship with crew-of-pi. Each `.md` file defines one agent with YAML frontmatter (name, tools, model, extensions) and a system prompt body.

## Ownership

| Agent | Tools | Role |
|-------|-------|------|
| **worker.md** | read, write, edit, grep, find, ls, bash | General implementation with full write capabilities |
| **scout.md** | read, grep, find, ls, bash | Fast codebase recon with structured findings |
| **researcher.md** | read, grep, find, ls, bash | Deep codebase research and dependency tracing |
| **planner.md** | read, grep, find, ls | Implementation planning (read-only, no write) |
| **reviewer.md** | read, grep, find, ls, bash | Code review for quality, security, maintainability |

## Local Contracts

1. **Every agent MUST have** `name`, `description`, and `tools` in frontmatter
2. **Worker is the only agent with write/edit** — all others are read-only
3. **Model override** via `crew-of-pi.json` config or `crew_spawn` `model` parameter
4. **Default spawn uses `--no-extensions`** — extensions only load if explicitly listed in frontmatter
5. **Priority hierarchy** for custom agents: project (`.pi/agents/*.md`) > user (`~/.pi/agent/agents/*.md`) > bundled (this dir)
6. **Output format** varies per agent type — each agent's system prompt defines its expected output structure

## Work Guidance

- Name must be lowercase, no whitespace (use hyphens): `name: my-agent`
- Tools list: comma-separated, no spaces around commas
- Model format: `provider/model-id` (e.g., `openrouter/deepseek/deepseek-v4-flash`)
- System prompt body should define expected output format for predictable parsing
- Extensions field: array of path/pi-package references

## Verification

- Every `.md` file in this directory must have valid YAML frontmatter
- Run `crew_list` to verify agents appear in registry after changes
- Model strings must match providers configured in the host pi installation
- No duplicate agent names across bundled, user, and project directories

## Child DOX Index

No child AGENTS.md files. Each file is a self-contained agent definition, not a subtree.
