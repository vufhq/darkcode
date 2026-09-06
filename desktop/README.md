# DarkCode Desktop

A native Windows front-end for the DarkCode agent, in C++20 with Dear ImGui over
Win32 + Direct3D 11. Same API, same on-disk credentials, same client-side tool
model as the CLI — a window instead of a terminal.

Self-contained: one `.exe`, static CRT, no runtime to install. HTTP is WinHTTP,
JSON is a vendored nlohmann/json header, the UI is vendored ImGui. The window is
frameless — it draws its own title bar — and Inter / JetBrains Mono ship beside
the binary in `assets/fonts/` (SIL OFL), falling back to system faces if that
folder is absent.

The design system and its rationale live in [DESIGN.md](DESIGN.md); what the app
is for lives in [PRODUCT.md](PRODUCT.md).

## Build

Needs MSVC (VS 2022 or newer with the C++ workload) and the Windows SDK. CMake
ships with Visual Studio; the path below is the bundled copy.

```bash
git clone --filter=blob:none --no-checkout https://github.com/vufhq/imgui.git desktop/vendor/imgui
git -C desktop/vendor/imgui checkout 646df390032f64eb03f8b5e2e5cbaf0c8e3bb237
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
ctest --test-dir desktop/build -C Release --output-on-failure
```

## Signing in

Choose **Sign in with browser** on the desktop sign-in page. The app runs the
Clerk Authorization Code + PKCE flow itself and accepts the result on a
temporary `127.0.0.1` callback listener. The listener is closed after sign-in,
cancellation, or a five-minute timeout.

Credentials remain compatible with the CLI through `~/.darkcode/auth.json`, so
signing in from either client signs in both. Access-token refresh is
single-flight, requests retry once after a 401, and final authentication
failures clear both the in-memory and on-disk session.

BYOK keys are shared the same way, through `~/.darkcode/api-keys.json`, and are
editable in **Settings**. Desktop-only preferences live in
`~/.darkcode/desktop.json` and never collide with the CLI's files.

### ChatGPT Model Connection

**Settings > Models > ChatGPT subscription** provides connect, reconnect,
cancel, disconnect, and status controls for **GPT-5.4 (ChatGPT)**
(`chatgpt-gpt-5.4`, provider `openai-codex`). This requires a ChatGPT account
with Codex access. It is separate from both DarkCode/Clerk sign-in and OpenAI
API keys. Existing GPT API-key entries are unchanged. A disconnected or expired
connection never falls back to a hosted model or an API key.

The browser flow uses Authorization Code + PKCE S256 at `https://auth.openai.com`,
with `openid profile email offline_access` scopes and the public Codex client
ID `app_EMoamEEZ73f0CkXaXp7hrann`. The redirect is
`http://localhost:1455/auth/callback`; the listener binds only `127.0.0.1:1455`.
One valid, state-matched callback consumes the attempt. Browser waiting times
out after five minutes; the token exchange has a separate 30-second deadline.
Cancellation and shutdown close pending OAuth network requests and the listener.
A busy port fails explicitly, without cancelling another application's login.

Tokens live only in `~/.darkcode/desktop-chatgpt.dpapi`, encrypted with Windows
DPAPI for the current Windows user. Atomic replacement preserves refresh-token
rotation. A `.lock` file grants one desktop process ownership of this store;
close other desktop windows if it is in use. Neither the CLI's OAuth store nor
`~/.codex` credentials are read. The model's file tools cannot read or write the
store or its staging file. DPAPI is not isolation from other programs running
as the same Windows user.

Before each inference request, including manual compaction, expired access
tokens are refreshed locally with a single-flight exchange. Only the access
token (`x-darkcode-openai-oauth-token`) and account ID
(`x-darkcode-openai-account-id`) are sent to the configured DarkCode server,
and only for this model. **Connect only if you trust that server.** HTTPS is
required except for loopback development APIs; credential-bearing redirects
are not followed. Refresh tokens are sent only to OpenAI's token endpoint.
Failed or ambiguous refresh rotation requires reconnecting rather than replaying
an old refresh token. Disconnect invalidates pending results and removes local
credentials; it does not revoke the OpenAI account's authorization remotely or
undo requests already sent. DarkCode sign-out does not disconnect ChatGPT.

Use **Settings > Models > Session context > Compact context** to summarize
earlier messages with the selected model. This sends `summarizerModel` to the
manual compaction route and uses the same provider authentication as chat.

Public protocol references:
- [Codex login server](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs)
- [Codex client ID and refresh endpoint](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs)

The current upstream login source also requests connector scopes; desktop
intentionally requests only the four scopes above. Native regression tests
cover callback parsing, token/claim validation, rotation parsing, model-specific
header routing and unsafe-origin refusal. Real browser/account entitlement and
end-to-end server inference require a live account and are not automated.

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
  Network reads poll cancellation once per second, including while the server is
  quiet.

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

The interface follows the design language of [vufh.dev](https://www.vufh.dev/).
Its tokens live in `theme.h`; nothing in `ui.cpp` picks a colour or a size of
its own. Four ideas carry it:

- **A pure black ground.** `#000000`, not dark grey, so everything above it
  reads as a light source rather than a lighter box.
- **Surfaces are translucent white, not opaque colour.** A panel is the ground
  plus 3.5% white and its edge is the ground plus 9%. One neutral ramp, no hue
  anywhere in the chrome.
- **No accent colour.** Primary means the inversion — white ground, black
  label — and there is exactly one such element on screen at a time. The only
  colour in the whole interface is a seven-stop spectrum, spent on the mark
  under the wordmark and on the working indicator, and nowhere else.
- **Small, quiet type.** 15px body, weight 300 for anything set large, and
  hover states that dim rather than brighten.

Semantic colours are taken from the spectrum's own stops, so even the error red
(`#ff4d4d`) belongs to the palette rather than arriving from a stock UI kit.
The working indicator is a direct port of the site's indeterminate track: a 2px
rule with a spectrum segment sweeping across it on the same 2.2s cycle.

Type asks for Inter and JetBrains Mono, then falls back through the same chain
the site declares — which on Windows is Segoe UI, with Cascadia Mono standing in
for the monospace. The glyph range is extended past Latin-1 to cover the
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
| `src/window.{h,cpp}` | Frameless chrome: hit-testing, maximise insets, reduced-motion |
| `src/anim.h` | Per-widget easing for an immediate-mode UI |
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
