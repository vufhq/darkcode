---
name: darkcode-p5-kiro-specs
description: Implement Phase 5 of the DarkCode plan — Kiro-style spec-driven development with Requirements → Design → Tasks phases, EARS acceptance criteria, approval gates, and dependency-aware task execution. Use when the user asks to add spec workflows, EARS linting, or task wave execution. Scope is the spec engine and its CLI commands.
model: opus
---

# DarkCode P5 — Kiro spec engine

You are building a first-class spec workflow into DarkCode: take a feature description, drive it through three approval-gated phases, then execute tasks in dependency waves.

## Read first

- `darkcode-cli-implementation-plan.md` §5 — the full design including EARS templates, workflow variants, state machine, and `tasks.md` format.
- `CLAUDE.md` for the stack and the rule that tool dispatch is client-side.
- `packages/shared/src/schemas.ts` to see how tools are declared.

## Where things live

- New package: `packages/cli/src/lib/specs/` for the engine logic.
- Spec files: `.darkcode/specs/<feature>/{requirements.md, design.md, tasks.md, spec.json}` — `spec.json` is the source of truth for phase state; the `.md` files are the human surface.
- New CLI commands (use the existing command-menu system in `packages/cli/src/components/command-menu/`): `/spec new`, `/spec status`, `/spec approve`, `/spec lint`, `/spec run`, `/spec propagate`.

## Success criteria

- A working **Requirements-First** flow: `/spec new <name>` generates `requirements.md` via the active model, blocks for approval, then design, then tasks. Approvals recorded in `spec.json` with timestamp + model.
- **EARS linter** that recognizes the six templates (ubiquitous, event-driven, state-driven, optional, unwanted, complex). Run via `/spec lint` and inline during requirements generation.
- **`tasks.md` parser** that reads checkbox lines + `<!-- id: T1, deps: [T2], req: [R3] -->` metadata and builds a dependency DAG.
- **Wave executor** (`/spec run --all`) that runs independent tasks in parallel within a wave, waiting for each wave to finish before starting the next. Each task spawns a normal chat turn with the task description as the prompt; status (`pending → in_progress → done | blocked | failed`) is persisted in `spec.json` after each turn.
- **Approval gates** are mandatory by default. Add `--quick` to skip them for Quick Plan flow.

## Constraints

- The spec engine runs CLI-side. The server is not aware of specs.
- Don't bypass the permission engine — task execution still routes through `checkPermission`.
- Don't add a new dependency for diagram rendering or sequence diagrams; the .md files are plain markdown.
- Keep state in `spec.json` (machine-readable). Re-parse `.md` files lazily to detect manual edits; `/spec propagate` reconciles them.
- Wave parallelism is a real constraint: tasks at the same wave level can run truly in parallel via separate chat turns. Don't fake it with sequential execution.

## Out of scope

- Design-First, Bugfix Spec, and the full propagation pass — ship Requirements-First + Quick Plan first; the variants come later.
- LSP integration (P4), MCP (P6), remote attach (P7), hardening (P8).
- Multi-user collaboration on a spec.

When done, smoke test by running `/spec new test-feature --quick` against this repo and confirm the three .md files plus `spec.json` are produced and parseable.
