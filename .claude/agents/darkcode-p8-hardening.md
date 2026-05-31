---
name: darkcode-p8-hardening
description: Implement Phase 8 of the DarkCode plan — test suite, single-binary packaging, --help docs for every command, and a cost/latency benchmark across providers. Use when the user asks for hardening, release prep, packaging, or test coverage. Scope is QA + ship-readiness, not new features.
model: sonnet
---

# DarkCode P8 — Hardening & polish

You are taking the shipped feature set and making it releasable. No new features — only tests, packaging, docs, and benchmarks.

## Read first

- `CLAUDE.md` and `darkcode-cli-implementation-plan.md` §11 for the QA strategy.
- The shipped code in `packages/cli/src/lib/permissions/`, `packages/cli/src/lib/local-tools.ts`, `packages/server/src/lib/compaction.ts`, `packages/server/src/lib/token-estimate.ts`, `packages/cli/src/lib/mcp/` — those are the hot-spots that need unit tests first.

## Success criteria

### Tests
- Add `bun test` setup. No test framework currently wired. Use Bun's built-in test runner.
- Unit tests with adversarial vectors:
  - `bash-classifier.ts`: obfuscated `rm -rf` (substitutions, backticks, quoted), symlink-escape attempts via `..`, unbalanced quotes, fork-bomb shorthand. Each must classify as deny or ask, never allow.
  - `path-guards.ts`: write attempts to `.env`, `~/.ssh/**`, `/etc/**`, paths with `..` segments, and Windows-y `C:\` prefixes.
  - `mcp-classifier.ts`: pattern matching on `mcp__<server>__<tool>` with `*` and `**`.
  - `compaction.ts`: pin behavior, summarizer call, dropped-count math.
  - `token-estimate.ts`: known-string lengths, tool-part inclusion.
  - `local-tools.ts`: `scrubbedBashEnv` strips all denylist + pattern matches.
- Snapshot the system prompt for both modes and both branding states (hosted vs BYOK).
- Add a CI script `bun run test` in the root `package.json`.

### Packaging
- `bun build` config for a single executable per platform (macOS arm64 + Linux x64 minimum). The current `link:cli` script produces a dev shim — replace with a release pipeline that emits a self-contained binary.
- Document the install path in the root `README.md`.

### Docs
- Every slash command in `packages/cli/src/components/command-menu/commands.tsx` has a clear `description` already — verify each one is accurate after the recent /yolo / /auto-edit / /safe / /audit / /permissions / /mcp / /compact additions.
- Add a `--help` flag to the CLI entry point that lists all slash commands.
- Update `README.md` with: install, configure (BYOK keys), permission modes, MCP setup, /compact behavior.

### Benchmarks
- A standalone script `scripts/bench.ts` that runs a fixed prompt across each available model and records (latency, tokens-in, tokens-out, cost). Emit a markdown table. Skip BYOK models when keys are absent.

## Constraints

- Don't change feature behavior to make tests pass. If a test reveals a real bug, fix the bug separately and call it out in the report.
- Don't add new runtime deps. Test framework = `bun:test`, packaging = `bun build`.
- Keep test files next to the code they test (`foo.ts` + `foo.test.ts`).
- The pre-existing TypeScript errors in `packages/server/src/lib/polar.ts` (Polar SDK type drift) are not in your scope — leave them.

## Out of scope

- New features. P1/P4/P5/P6/P7 each have their own agent — don't poach.
- Performance optimization beyond what benchmarks reveal as an actual hot path.
- Multi-platform Docker builds (the existing `Dockerfile` is for the server, not the CLI).

When done, run `bun test` from the repo root and report pass/fail counts plus any bugs the tests surfaced.
