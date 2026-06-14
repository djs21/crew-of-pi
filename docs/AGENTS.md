# docs — Project Documentation

## Purpose

Working documents for crew-of-pi development: architecture plans, audit findings, design decisions. These are durable records that inform future development.

## Ownership

| File | Content |
|------|---------|
| **plan.md** | Original work plan — architecture, implementation details, timeline, design decisions |
| **findings-2025-06-13.md** | Codebase audit results — 12 findings, 9 fixed, 1 skipped |

## Local Contracts

1. **Durable records** — do not delete unless content is fully superseded by ADRs or AGENTS.md docs
2. **Plan.md is historical** — reflects the design intent during initial development. If the implementation has diverged, note the divergence rather than rewriting history
3. **Findings are auditable** — includes commit refs, status per finding, and rationale for skips

## Work Guidance

- Add new docs for significant architecture decisions (ADR style)
- Update `findings-*.md` when new audits are performed with a new dated file

## Verification

- Doc content must not contradict current AGENTS.md or code behavior
- File names should include date for chronological ordering

## Child DOX Index

No child AGENTS.md files.
