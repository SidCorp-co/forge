# Multi-stage Dockerfile for @forge/core.
# BUILD CONTEXT: repo root so pnpm workspace can resolve `workspace:*`
# dependencies (e.g. `@forge/observability`). Build with:
#   docker build -f packages/core/Dockerfile .
# Compose wires this via `context: .` + `dockerfile: packages/core/Dockerfile`.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# ----- Build stage: install full workspace + compile core -----
FROM base AS build
WORKDIR /repo
# Copy the workspace skeleton first so dependency installation caches
# don't bust on every source edit.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @forge/core...
# `--filter @forge/core...` (three dots) builds @forge/core AND its
# workspace deps in topological order. Without the third dot,
# @forge/observability ships as raw .ts source under node_modules and
# Node 22 refuses to load it (no type-stripping under node_modules).
RUN pnpm --filter @forge/core... build
# `pnpm deploy` materialises a self-contained app at /prod/core with
# zero workspace symlinks — every dependency is a real install. The
# runtime stage just copies that directory and runs node. Honors the
# `files` field in packages/core/package.json so only dist + skills +
# drizzle + public ship.
RUN pnpm deploy --filter=@forge/core --prod /prod/core

# ----- Runtime stage: minimal node + the deployed app -----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /prod/core ./
# NOTE: Forge's repo `docs/` is INTERNAL engineering documentation (architecture,
# RFCs, threat models, module design) — it is deliberately NOT shipped into the
# image and NOT served to end users. End-user product docs are a separate,
# curated set (see docs/help/, once authored) and only THAT will be COPY'd here.

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

# Run migrations via the runtime migrator (drizzle-orm; no drizzle-kit in prod
# deps) — these MUST block server start. Then launch the runner-release populate
# in the BACKGROUND (best-effort; exits 0) so a slow binary download can't push
# boot past the healthcheck start_period, and `exec` the server immediately. The
# install routes serve 404/501 until the dir fills in (seconds later).
CMD ["sh", "-c", "node dist/db/migrate.js && { node dist/install/fetch-release.js & } && exec node dist/index.js"]
