# Multi-stage Dockerfile for packages/web-v2 (the redesigned UI, served at /v2).
# BUILD CONTEXT: repo root so pnpm workspace can resolve workspace:* deps.
# Build with: docker build -f packages/web-v2/Dockerfile .
#
# Runs side-by-side with v1 (packages/web). next.config.ts defaults
# basePath/assetPrefix to "/v2" (no env needed), so the standalone server
# serves the app under /v2 — point the reverse proxy (Coolify domain
# "<host>/v2") at this container WITHOUT stripping the /v2 prefix.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages

# Install only web-v2's transitive deps (package name is "web-v2").
RUN pnpm install --frozen-lockfile --filter web-v2...

WORKDIR /repo/packages/web-v2
# web-v2 talks to core via the SAME absolute API origin as v1 (e.g. the
# forge-beta-api subdomain) — NOT a relative /api, because under the /v2
# basePath a relative call would hit this container, not core. Cookie sharing
# relies on core's AUTH_COOKIE_DOMAIN. NEXT_PUBLIC_* are inlined at build time.
ARG NEXT_PUBLIC_API_URL=http://localhost:8080/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL=
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_SENTRY_DSN=
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
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
