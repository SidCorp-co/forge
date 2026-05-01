# Multi-stage Dockerfile for packages/web
# BUILD CONTEXT: repo root so pnpm workspace can resolve workspace:* deps.
# Build with: docker build -f packages/web/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /repo

# Copy whole repo so pnpm workspace resolves (small footprint vs build correctness tradeoff)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages

# Install only web's transitive deps (web package name is "web", not "@forge/web")
RUN pnpm install --frozen-lockfile --filter web...

# Build workspace deps that ship compiled output (e.g. @forge/observability
# emits dist/index.js — Node 22 refuses to load .ts under node_modules).
# Running this BEFORE the Next.js build means web's bundler sees a
# resolvable import; the env-driven NEXT_PUBLIC_SENTRY_DSN below is
# specific to web's own bundle and must remain in this stage.
RUN pnpm --filter @forge/observability build

# Build
WORKDIR /repo/packages/web
ARG NEXT_PUBLIC_API_URL=http://localhost:8080/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL=
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_ENV_LABEL=
ENV NEXT_PUBLIC_ENV_LABEL=$NEXT_PUBLIC_ENV_LABEL
# Next.js inlines NEXT_PUBLIC_* into the client bundle at build time, not
# runtime — passing this only via `environment:` would leave the browser
# DSN as the empty string. The `:-` default keeps source-only builds
# (operator chooses not to set the var) Sentry-disabled.
ARG NEXT_PUBLIC_SENTRY_DSN=
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
RUN pnpm build

# Production runtime — Next.js monorepo standalone places server.js at packages/web/
FROM node:22-alpine AS production
WORKDIR /app

COPY --from=base /repo/packages/web/.next/standalone ./
COPY --from=base /repo/packages/web/.next/static ./packages/web/.next/static
COPY --from=base /repo/packages/web/public ./packages/web/public

WORKDIR /app/packages/web
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
