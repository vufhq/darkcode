# syntax=docker/dockerfile:1.7

# Multi-stage build for the @darkcode/server package. The CLI ships via
# `bun link` for now and isn't included in this image.

ARG BUN_VERSION=1.3.14

# ---------- deps stage ----------
# Install workspace dependencies. Kept separate so node_modules can be cached
# across rebuilds when only source code changes.
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app

# Workspace + package manifests first so the layer caches independent of
# source changes. Schema is copied here too because the server's postinstall
# runs `prisma generate` against it.
COPY package.json bun.lock ./
COPY packages/server/package.json ./packages/server/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/database/prisma ./packages/database/prisma
COPY packages/database/prisma.config.ts ./packages/database/prisma.config.ts

# `bun install` runs @darkcode/server's postinstall → `prisma generate`, which
# loads packages/database/prisma.config.ts. That config eagerly resolves
# DATABASE_URL via prisma's strict env() helper — but `generate` only reads the
# schema and never opens a connection. Supply a throwaway URL so the build
# stage succeeds. This ENV lives only in the `deps` stage; the runtime stage is
# a separate FROM and receives the real DATABASE_URL from the platform.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"

RUN bun install --frozen-lockfile

# ---------- runtime stage ----------
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

# Copy installed deps + the generated prisma client from the deps stage.
# packages/database comes from deps because that's where `prisma generate` wrote
# the client (generated/) — but the deps stage only had the manifest + schema,
# never the package's TS source. src/client.ts (exported as
# @darkcode/database/client) and src/index.ts therefore aren't in the deps copy,
# so bring them in from the build context.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/database ./packages/database
COPY packages/database/src ./packages/database/src

# Application source. The CLI package isn't needed at runtime but its
# package.json is referenced by the workspace resolver — keep it minimal
# rather than copying its sources.
COPY package.json bun.lock ./
COPY tsconfig.base.json ./
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# Run as a non-root user. The oven/bun image ships with the `bun` user.
USER bun

EXPOSE 3000

# Liveness via the /healthz endpoint Phase 4 added. Readyz is intentionally
# not used here — failing readyz should drain traffic, not restart the
# container.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3000) +'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply pending migrations then start. `prisma migrate deploy` is idempotent
# and uses an advisory lock so concurrent boots are safe.
CMD ["sh", "-c", "bun --bun run --cwd packages/database prisma migrate deploy && exec bun packages/server/src/index.ts"]
