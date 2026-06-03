<div align="center">

<br />
<br />

<h1>DarkCode</h1>

<p>A terminal-based AI coding agent.</p>

<p>Plan, chat, and build inside your local project with a Bun-powered CLI, Hono API, Prisma ORM, Clerk auth, and AI SDK streaming.</p>

</div>

<br />

## Install

DarkCode ships as a single self-contained binary — no runtime to install.

**macOS / Linux**

```sh
curl -fsSL https://darkcode.sh/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://darkcode.sh/install.ps1 | iex
```

Then run `darkcode` in any project and use `/login` to sign in. All download
options live at [darkcode.sh/download](https://darkcode.sh/download).

Want to run your own instance? See [DEPLOY.md](./DEPLOY.md).

## Features

- **Terminal AI Chat** — Run an AI coding assistant directly in your terminal with an OpenTUI and React interface
- **Plan and Build Modes** — Use read-only planning tools or enable write, edit, and shell execution tools for implementation
- **Streaming Responses** — Stream model output through the AI SDK with persisted session history
- **Local Project Tools** — Read files, list directories, glob, grep, write files, edit files, and run shell commands inside the current project
- **Multi-Model Support** — Ship with **Kimi K2.6** as the default hosted model, plus Anthropic Claude, OpenAI GPT, DeepSeek, and Google Gemini (hosted on credits or bring-your-own-key) and local Ollama models
- **Persistent Sessions** — Store authenticated user sessions and messages in Postgres via Prisma
- **Clerk OAuth** — Authenticate the CLI through a browser-based Clerk OAuth flow
- **Usage Billing** — Meter AI usage as credits through Polar before allowing session and chat actions

## Models

DarkCode supports a range of models with flexible billing:

- **Kimi K2.6 (default, hosted)** — Runs on infrastructure you operate using a single `MOONSHOT_API_KEY`. End users never see the upstream provider — the CLI labels it as "Kimi K2.6". Usage is billed through Polar credits.
- **Hosted on credits** — Anthropic Claude, OpenAI GPT, DeepSeek, and Google Gemini also run on your infrastructure (using the matching server-side key) and are metered as credits, so a user can pick them without bringing their own key.
- **Bring Your Own Key (BYOK)** — A user's own key always wins and is never metered. Add one with `/keys`; it's stored locally at `~/.darkcode/api-keys.json`, sent to the server only as a forwarding header, and never persisted.
- **Local (Ollama)** — Point at a local Ollama endpoint to run models entirely on your own machine, always unmetered.

Switch between models at any time with `/models`. If a model needs a key the CLI doesn't already have, the model picker prompts for one inline.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) installed
- PostgreSQL database (e.g. [Neon](https://neon.tech))
- [Clerk](https://clerk.com) application configured for OAuth
- A [Moonshot AI](https://platform.moonshot.ai) API key for the hosted **Kimi K2.6** model
- Optional: Anthropic or OpenAI API keys, supplied by end users via `/keys` (BYOK)
- [Polar](https://polar.sh) account and credits meter

### 1. Clone and install

```bash
git clone git@github.com:vufhq/darkcode.git
cd darkcode
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in the required values:

```bash
API_URL=http://localhost:3000
DATABASE_URL=

# Powers the hosted "Kimi K2.6" model.
MOONSHOT_API_KEY=

CLERK_FRONTEND_API=
CLERK_OAUTH_CLIENT_SECRET=
CLERK_OAUTH_CLIENT_ID=
CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
JWT_SECRET=jwt-secret

POLAR_ACCESS_TOKEN=
POLAR_PRODUCT_ID=
POLAR_SERVER=sandbox
POLAR_CREDITS_METER_ID=
```

### 3. Set up Clerk OAuth

DarkCode authenticates the CLI through a browser-based Clerk OAuth flow. The CLI opens Clerk authorization in the browser, Clerk redirects to the server at `/auth/callback`, and the server forwards the authorization code back to the local CLI callback server.

In your Clerk dashboard:

1. Go to **Configure > Developers > OAuth applications**.
2. Click **Add OAuth application**.
3. Name it anything, for example `DarkCode`.
4. Select these four scopes: `openid`, `email`, `profile`, and `offline_access`.
5. Turn on **Public**. This is required for the Authorization Code with PKCE flow used by the CLI.
6. Turn on **Consent screen** so users can approve the requested scopes.
7. Add `http://localhost:3000/auth/callback` as a redirect URI for local development.
8. Add your deployed callback URL as another redirect URI for production, for example `https://your-deployment.com/auth/callback`.

You can keep both local and production redirect URIs on the same OAuth application.

Copy the generated application credentials into `.env`:

| Environment variable | Clerk value |
|----------------------|-------------|
| `CLERK_OAUTH_CLIENT_ID` | OAuth application Client ID |
| `CLERK_OAUTH_CLIENT_SECRET` | OAuth application Client Secret |
| `CLERK_FRONTEND_API` | Clerk frontend API URL |
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `CLERK_SECRET_KEY` | Clerk secret key |

### 4. Set up Polar billing

DarkCode uses Polar credits to gate new work and bill completed AI usage. The server checks the user's active meter balance before creating sessions or sending chat requests, then ingests usage events after AI responses finish.

In your Polar dashboard, use sandbox mode for local development and create a meter with these exact settings:

| Setting | Value |
|---------|-------|
| Meter name | `darkcode_credits` |
| Filter | Name equals `darkcode_usage` |
| Aggregation | Sum |
| Aggregation property | `credits` |

The event name and metadata key must match exactly. The server sends usage events like this:

```ts
{
  name: "darkcode_usage",
  metadata: { credits }
}
```

Next, create a meter credits benefit and attach it to a one-time purchase product:

1. Create a benefit using the `darkcode_credits` meter.
2. Set the credited units, for example `1000` credits.
3. Create a one-time purchase product, for example `$20` for `1000` credits.
4. Attach the credits benefit to that product.
5. Set the customer portal visibility to private so purchases happen through API-generated checkout links.

Then copy the required Polar values into `.env`:

| Environment variable | Where to find it |
|----------------------|------------------|
| `POLAR_ACCESS_TOKEN` | Polar developer settings token |
| `POLAR_PRODUCT_ID` | Product ID from the credits product |
| `POLAR_SERVER` | Use `sandbox` locally, `production` for live billing |
| `POLAR_CREDITS_METER_ID` | Meter ID from the meter URL |

The CLI upgrade flow calls `/billing/checkout`, which opens a Polar checkout URL. The usage flow calls `/billing/portal`, which opens the customer's Polar portal.

### 5. Set up the database

Generate the Prisma client:

```bash
bun run --cwd packages/database db:generate
```

Apply your Prisma schema to the configured Postgres database using your preferred Prisma workflow.

### 6. Run the server

```bash
bun run dev:server
```

The API runs on `http://localhost:3000`.

### 7. Run the CLI

In another terminal:

```bash
bun run dev:cli
```

To build and link the local CLI binary:

```bash
bun run link:cli
darkcode
```

## Project Structure

```
packages/
├── cli/                         # OpenTUI + React terminal client
│   ├── bin/                     # darkcode executable shim
│   └── src/
│       ├── components/          # Terminal UI components, dialogs, messages
│       ├── hooks/               # Chat and UI hooks
│       ├── layouts/             # Root terminal layouts
│       ├── lib/                 # API client, auth, OAuth, local tool execution
│       ├── providers/           # Dialog, keyboard, prompt, theme, toast providers
│       └── screens/             # Home, new session, and session screens
├── database/                    # Prisma schema, generated client, database exports
├── server/                      # Hono API for auth, billing, sessions, and chat
└── shared/                      # Shared schemas, tool contracts, and model registry
```

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev:cli` | Start the CLI in watch mode |
| `bun run dev:server` | Start the Hono server with hot reload |
| `bun run build:cli` | Build the CLI package |
| `bun run link:cli` | Build and link the `darkcode` executable |
| `bun run --cwd packages/database db:generate` | Generate the Prisma client |

## Packages

| Package | Description |
|---------|-------------|
| `@darkcode/cli` | Terminal UI and client-side tool execution |
| `@darkcode/server` | Hono API, AI streaming, auth checks, and billing ingestion |
| `@darkcode/database` | Prisma client and database schema |
| `@darkcode/shared` | Shared Zod schemas, AI tool contracts, and model definitions |
