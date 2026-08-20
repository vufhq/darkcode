# DarkCode Desktop

A native Windows front-end for the DarkCode agent, in C++20 with Dear ImGui over
Win32 + Direct3D 11. Same API, same on-disk credentials, same client-side tool
model as the CLI — a window instead of a terminal.

Self-contained: one 1.2 MB `.exe`, static CRT, no runtime to install. HTTP is
WinHTTP, JSON is a vendored nlohmann/json header, the UI is vendored ImGui.

## Build

Needs MSVC (VS 2022 or newer with the C++ workload) and the Windows SDK. CMake
ships with Visual Studio; the path below is the bundled copy.

```bash
git clone --depth 1 -b docking https://github.com/vufhq/imgui.git desktop/vendor/imgui
```

```bash
curl -sSL -o desktop/vendor/json/json.hpp https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp
```

```bash
cmake -S desktop -B desktop/build -G "Visual Studio 18 2026" -A x64
```

```bash
cmake --build desktop/build --config Release
```

The binary lands at `desktop/build/bin/darkcode-desktop.exe`. Tests:

```bash
./desktop/build/Release/darkcode-desktop-tests.exe
```

## Signing in

The desktop app does **not** implement the Clerk OAuth browser flow. It reads
`~/.darkcode/auth.json`, which the CLI writes — so sign in once with the CLI and
both clients are authenticated:

```bash
darkcode
```

Then `/login`, then reopen the desktop app (or press **I have signed in**). Token
refresh, 401 replay and sign-out all work from the desktop app; only the initial
login lives in the CLI.

BYOK keys are shared the same way, through `~/.darkcode/api-keys.json`, and are
editable in **Settings**. Desktop-only preferences live in
`~/.darkcode/desktop.json` and never collide with the CLI's files.

## Using it

- **Project directory** (Settings) is what every tool resolves paths against.
  Nothing outside it can be read or written — symlinks included, since paths are
  canonicalised before the containment check. It defaults to the working
  directory, or your home folder when the app is launched from Explorer.
- **PLAN / BUILD** and the model picker sit in the top bar, since both belong to
  the session rather than to one message. PLAN exposes only the read-only tools;
  BUILD adds `writeFile`, `editFile` and `bash`.
- **Enter** sends, **Ctrl+Enter** inserts a newline.
- **Stop** aborts a turn: it cancels the stream, releases any tool waiting on a
  permission prompt, and reports the remaining calls back to the model as errors.

### Permissions

Reads are auto-approved by default; writes and shell commands prompt. Three
things are not negotiable through the UI:

- Files matching the secret patterns (`.env*`, `*.pem`, `*.key`, `**/.ssh/**`,
  `**/.aws/**`, `.npmrc`, `.git-credentials`, DarkCode's own credential files…)
  are never read or written, whatever the auto-approve toggles say. `grep` skips
  them too and reports how many it skipped — matching lines are file contents.
- Destructive or privilege-escalating shell commands (`sudo`, `rm -rf /`,
  pipe-to-shell) are refused outright rather than prompted.
- "Always allow" on a command is keyed to that **exact** command, so approving
  `git push origin main` never blanket-approves `git push`.

The prompt also ignores input for a few frames after it appears and clears the
queued key events, so a keystroke already in flight cannot answer a security
question the user has not read yet.

### webFetch

Fetches a URL and hands back Markdown for HTML, pretty-printed JSON for JSON,
and raw text otherwise. It runs here rather than on the server for one reason:
the thing a coding agent most often needs to fetch is the dev server it just
started, and `http://localhost:5173` does not exist from the API server's side.

That same property makes it a server-side-request-forgery primitive aimed at
your own network, and the model may be choosing the URL because a page it just
read told it to. Three defences, none of them optional:

- **Every host is approved separately**, default-ask. A grant is keyed to the
  host, so approving `example.com` says nothing about anywhere else.
- **Cloud instance-metadata endpoints are refused outright** (`169.254.169.254`,
  `metadata.google.internal`, …). They hand out credentials to anything on the
  box that asks. The refusal is not promptable and auto-approve does not reach
  it.
- **Redirects are walked by hand, one hop at a time, re-checking the policy at
  each new host.** Automatic redirect handling would let an approved host bounce
  the request to a denied one with no second question — which is exactly the
  attack the first two defences would otherwise miss.

Beyond that: `http`/`https` only (`file:` would bypass the path jail that guards
every other read), binary content types refused, the body capped at 5 MB as it
arrives rather than trusting `Content-Length`, and the result carries a note
telling the model the content is untrusted data rather than instructions.

`webSearch` needs nothing here — it is the one tool that executes server-side.

## Design

One palette, a 4pt spacing scale and a five-step type ramp live in
`theme.h`; nothing in `ui.cpp` picks a colour or a size of its own. Three
conventions do most of the work:

- **Surfaces separate by value and a hairline**, not by borders on everything,
  so the window reads as one object rather than a stack of boxes.
- **The accent is spent sparingly** — primary action, selection, focus. A colour
  used everywhere stops meaning anything.
- **The transcript is capped at a readable measure and centred.** Prose set to
  the full width of a maximised window is the loudest tell that a UI was never
  designed to be read.

Fonts are Segoe UI, Segoe UI Semibold and Cascadia Mono, each falling back to
the next best thing. The glyph range is extended past Latin-1 to cover the
punctuation a language model actually writes — em dashes, curly quotes,
ellipses — which would otherwise render as hollow boxes.

## How a turn works

Tool dispatch is client-side — the server only declares schemas — so the desktop
app runs the same loop the CLI does:

1. `POST /chat` with the user message, mode, model, task list and project context.
2. Decode the AI SDK UI-message stream (SSE) into the assistant message.
3. If the turn ends with unresolved tool calls, execute them locally and
   `POST /chat` again with the same pair of messages, the assistant one now
   carrying results. The server merges by message id, so the assistant message
   keeps its identity across round-trips.
4. Repeat until the model stops calling tools (capped at 32 steps).

## Layout

| Path | What it is |
|---|---|
| `src/main.cpp` | Win32 window, D3D11 device, frame loop |
| `src/app.{h,cpp}` | State and the turn loop; the threading rules are documented at the top of the header |
| `src/ui.cpp` | All rendering |
| `src/theme.{h,cpp}` | Palette, spacing scale, type ramp, ImGui style |
| `src/chat.{h,cpp}` | UIMessage model, SSE decoder, stream reducer |
| `src/tools.{h,cpp}` | Local tool execution, path jail, `.gitignore` walker, bash spawning |
| `src/web.{h,cpp}` | `webFetch`: URL validation, hop-by-hop redirects, content-type routing |
| `src/html.{h,cpp}` | HTML→Markdown and entity decoding (no DOM library) |
| `src/permissions.{h,cpp}` | Deny lists, bash classifier, the blocking prompt handshake |
| `src/api.{h,cpp}` | `/sessions`, `/chat`, `/billing`, token refresh |
| `src/http.{h,cpp}` | WinHTTP, including the streaming read loop |
| `src/models.h` | Mirror of `packages/shared/src/models.ts` |
| `tests/test_logic.cpp` | 126 checks over the UI-free logic |

## Not implemented

- **LSP tools.** `lspDefinition` / `lspReferences` / `lspHover` / `lspDiagnostics`
  / `lspSymbols` return a tool error telling the model to use `grep`/`readFile`.
  The server offers them in both modes, so the model can still call them.
- **MCP.** No `mcpTools` are advertised, so the model is never offered them.
- **The login flow.** See above.
- **`/compact`.** The server compacts automatically at 75% of the context window;
  the manual `POST /sessions/:id/compact` is not wired to a button.

Three deliberate approximations: the `.gitignore` matcher covers comments,
negation, anchoring, directory-only rules and `**`, but is not the full git
algorithm; `editFile` tries an exact match then a line-trimmed fallback, where
the CLI has a six-strategy chain (both report when a fallback was used); and the
HTML converter is a tag scanner rather than a real parser, so it reproduces the
CLI's *behaviour* — dropped chrome, block structure, fenced code, resolved links,
collapsed whitespace — without matching it byte for byte on hostile markup.

## Keeping it in sync

`src/models.h` mirrors the shared model registry and `src/permissions.cpp`
mirrors the CLI's default policy. Neither is generated — if you add a model in
`packages/shared/src/models.ts`, add it here too. The server rejects an unknown
model id with a 400, so the failure mode is a clear error rather than silence.
