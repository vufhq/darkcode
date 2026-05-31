---
name: darkcode-p7-remote-attach
description: Implement Phase 7 of the DarkCode plan — secure multi-device session attach over WSS with device-paired tokens. Use when the user asks to enable laptop/phone access to a running session, multi-device support, or remote attach. Scope is the attach endpoint, pairing flow, and broadcast logic.
model: sonnet
---

# DarkCode P7 — Remote attach (multi-device)

You are exposing a way for a second device to connect to a running DarkCode session and follow along (read) or take over input (write), with proper auth and broadcast.

## Architecture (must follow)

- DarkCode is **server + CLI**, not a daemon. The attach surface lives in `packages/server/src/` as a new `/attach` WebSocket route, **not** on the CLI.
- Sessions are already in Postgres via Prisma. Multi-device just needs (a) a WSS endpoint that streams the session's evolving message list, and (b) a write-lock so two clients can't fight over the input.
- Auth: device-paired tokens. The user runs `/serve --pair` from their primary CLI, which mints a short-lived pairing code; the second device runs `/attach <host> <code>` and exchanges it for a long-lived device token bound to their `userId`.

## Read first

- `CLAUDE.md` — note the existing `requireAuth` middleware and the Clerk OAuth flow. Reuse `requireAuth` for the pairing exchange; device tokens are a separate credential type.
- `packages/server/src/index.ts` for route mount points and middleware order.
- `packages/server/src/middleware/require-auth.ts` for the existing token shape.
- `packages/database/prisma/schema.prisma` — you'll add a `DeviceToken` model.

## Success criteria

- Prisma model `DeviceToken { id, userId, label, tokenHash, scopes, createdAt, lastUsedAt, revokedAt }` with the obvious indexes. Tokens are stored hashed; the raw value is only ever shown once at pairing.
- `POST /auth/pair` (auth required) — mints a short-lived pairing code (e.g. 6 chars, 5-min TTL, in-memory or Redis).
- `POST /auth/pair/exchange` — unauth'd; takes the pairing code + a device label, returns a long-lived device token. The code is one-use.
- `GET /attach/:sessionId` (device-token auth) — WebSocket upgrade. Streams JSON frames of new messages as they're persisted to the session. The implementation must subscribe to a Postgres LISTEN/NOTIFY channel (or a simple in-process pubsub if Postgres NOTIFY is overkill) keyed on `sessionId`, and broadcast.
- Single-writer policy: only one connected client may submit user messages at a time. Implement a soft lock (server-side flag with a 60s TTL, refreshed by heartbeat). A second writer gets a `takeover` prompt; the server resolves on confirmation.
- CLI commands `/serve --pair`, `/attach <host>`, `/devices revoke <id>`. The pairing UI is a single dialog that shows the code and a copy hint.
- TLS termination is assumed to be at the deployment layer (Railway / reverse proxy). Document the requirement in the route comment — do not implement TLS in-process.

## Constraints

- **Security defaults must be tight.** Device tokens are scoped to `userId`; cross-user attach is impossible by construction. Tokens are revocable. Pairing codes are one-use and short-lived. Rate-limit `/auth/pair/exchange` aggressively (5 attempts / minute / IP).
- Never bind the WSS to `0.0.0.0` in dev defaults. The plan's design intent is loopback / tailnet first.
- Don't reuse the Clerk session JWT as the device token — they have different lifetimes and revocation semantics.
- Audit log every pair / attach / revoke through `logAuditEvent`.
- Don't change the chat route's auth flow; device tokens only authorize the attach surface, not `POST /chat`. (If the user wants chat from a second device, route it through the same primary session by sending messages to the same WSS connection that broadcasts them.)

## Out of scope

- TLS in-process.
- Mobile UI (the CLI client is enough for v1 — assume the second device runs DarkCode CLI too).
- Federation across multiple servers.
- Voice / video / screen-share.

When done, smoke test with two CLI instances against the same session and confirm that messages typed in one appear in the other in <500ms.
