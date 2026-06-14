# prompts — Workflow Templates

## Purpose

Prompt templates that expand into multi-step chain workflows. Each `.md` file describes a workflow sequence that the main agent can trigger as a `crew_chain` call.

## Ownership

| Template | Workflow | Steps |
|----------|----------|-------|
| **implement.md** | /implement | scout → planner → worker |
| **research.md** | /research | scout → researcher |

## Local Contracts

1. **First step is always discovery** — scout gathers context before deeper agents run
2. **`$@` placeholder** expands to the user's query/task
3. **`{previous}` placeholder** passes output between steps
4. **Each template maps to a single `crew_chain` invocation**

## Work Guidance

- Add new `.md` files for common multi-step workflows
- Keep templates minimal — just describe the chain steps, not full system prompts
- Reference agents by their `name` field from `agents/`

## Verification

- Each template must reference only agents that exist in the bundled or configured set
- Chain steps must be valid `{ agent, task }` shapes for `crew_chain`

## Child DOX Index

No child AGENTS.md files.
