---
name: darkcode-p4-lsp
description: Implement Phase 4 of the DarkCode plan — a CLI-side LSP pool that exposes go-to-definition, references, hover, diagnostics, and a post-edit diagnostics feedback loop as agent tools. Use when the user asks to add LSP integration, IDE-like signals, or diagnostics-driven self-correction. Scope is strictly the LSP layer and its tool plumbing.
model: sonnet
---

# DarkCode P4 — LSP integration

You are building a warm LSP pool inside the CLI so the agent gets the same signal a developer gets in an IDE: definitions, references, hover types, and most importantly **diagnostics after every edit**.

## Architecture (must follow)

- LSP runs **CLI-side**, not server-side. The server stays stateless about language servers. Live in `packages/cli/src/lib/lsp/`.
- Tools are declared in `packages/shared/src/schemas.ts` so the server can include them in `getToolContracts(mode)` and the model sees them in its catalog. Dispatch happens in `packages/cli/src/lib/local-tools.ts` (or a sibling that local-tools.ts delegates to for `lsp.*` names).
- New tools: `lsp.definition`, `lsp.references`, `lsp.hover`, `lsp.diagnostics`, `lsp.symbols`. (Skip `rename` for v1.)
- Server registry: a map from file extension → command for a known set of languages (`typescript`, `tsserver` / `typescript-language-server`; `python`, `pyright`; `rust`, `rust-analyzer`; `go`, `gopls`). Auto-launch only when a file of that language is actually requested — lazy, not eager.

## Read first

- `CLAUDE.md` for the workspace conventions.
- `packages/cli/src/lib/local-tools.ts` to see the dispatch pattern and the `resolveInsideCwd` jail.
- `packages/shared/src/schemas.ts` to see how `getToolContracts(mode)` is structured and how tools are mode-gated.
- `packages/server/src/routes/chat.ts` line ~183 for how tool contracts flow into `streamText`. You do NOT need to modify chat.ts beyond adding the new tools to `getToolContracts`.

## Success criteria

- An LSP pool that keeps one client per running language server, reused across turns. Servers stay warm; processes shut down cleanly on CLI exit.
- The five tools above behave correctly against a real TypeScript project (this repo).
- After every successful `writeFile` / `editFile` (in BUILD mode), the dispatcher fetches diagnostics for the changed file and surfaces them on the tool output so the model sees them next turn — this is the "feedback loop" the plan calls out. Implement this in `local-tools.ts` after the existing `checkPermission` + write.
- Use `vscode-languageserver-protocol` for the wire types and `vscode-jsonrpc` for the transport. Add deps to `packages/cli/package.json`.
- Both PLAN and BUILD mode get the read-only `lsp.*` tools. Diagnostics feedback only fires on BUILD-mode writes.

## Constraints

- Don't break startup when no language server binary is installed — degrade gracefully and log once. Missing-server should never crash the CLI.
- Don't add a daemon. The pool lives in the CLI process.
- Respect `resolveInsideCwd` — never run LSP against files outside the project root.
- Keep diagnostics summaries short (top 10 entries) in tool output so they don't blow context.

## Out of scope

- Rename refactor (`lsp.rename`).
- Workspace symbol search (`lsp.symbols` is per-file; cross-workspace is deferred).
- Anything in P5 (specs), P6 M2 leftovers, P7 (attach), or P8 (hardening).

When done, smoke test by editing a TS file in this repo and observing diagnostics in the tool output. Report results.
