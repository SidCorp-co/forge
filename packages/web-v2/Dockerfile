# Multi-stage Dockerfile for packages/web-v2 — the canonical Forge cloud UI.
# BUILD CONTEXT: repo root so pnpm workspace can resolve workspace:* deps.
# Build with: docker build -f packages/web-v2/Dockerfile .
#
# ISS-397 retired v1 (packages/web) + the `/v2` prefix. next.config.ts now
# defaults basePath/assetPrefix to "" (no env needed), so the standalone server
# serves the app at the host ROOT — point the reverse proxy (Coolify root host
# domain) at this container. To re-mount under a prefix, pass build args
# WEB_V2_BASE_PATH=/v2 + NEXT_PUBLIC_BASE_PATH=/v2.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /repo

COPY .npmrc pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages

# Install only web-v2's transitive deps (package name is "web-v2").
RUN pnpm install --frozen-lockfile --filter web-v2...

# Every workspace dep whose export map points at dist/ must be built before the
# Next.js build, or that import is unresolvable and the `next build` TypeScript
# pass fails with TS2307. Node 22 refuses .ts under node_modules, so a package
# with a compiled export has no fallback. Two qualify, in dependency order:
# @forge/observability, and @forge/contracts for its ./document-patch export.
# Adding a compiled export to a workspace dep means adding it here.
RUN pnpm --filter @forge/observability build && pnpm --filter @forge/contracts build

WORKDIR /repo/packages/web-v2
# web-v2 talks to core via an absolute API origin (e.g. the forge-beta-api
# subdomain) — NOT a relative /api, so a same-origin call can't accidentally
# hit this container instead of core. Cookie sharing relies on core's
# AUTH_COOKIE_DOMAIN. NEXT_PUBLIC_* are inlined at build time.
ARG NEXT_PUBLIC_API_URL=http://localhost:8080/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL=
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_SENTRY_DSN=
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
# Default = serve at root (matches next.config / lib/asset defaults). Pass both
# as /v2 to re-mount under a prefix. WEB_V2_BASE_PATH drives next.config's
# basePath/assetPrefix; NEXT_PUBLIC_BASE_PATH is inlined for raw-asset/deep-link
# helpers — keep them equal.
ARG WEB_V2_BASE_PATH=
ENV WEB_V2_BASE_PATH=$WEB_V2_BASE_PATH
ARG NEXT_PUBLIC_BASE_PATH=
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
ARG SOURCE_COMMIT=
ENV NEXT_PUBLIC_SOURCE_COMMIT=$SOURCE_COMMIT
RUN pnpm build

# Production runtime — Next monorepo standalone places server.js under
# packages/web-v2/ inside the standalone bundle.
FROM node:22-alpine AS production
WORKDIR /app

COPY --from=base /repo/packages/web-v2/.next/standalone ./
COPY --from=base /repo/packages/web-v2/.next/static ./packages/web-v2/.next/static
COPY --from=base /repo/packages/web-v2/public ./packages/web-v2/public

WORKDIR /app/packages/web-v2
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
