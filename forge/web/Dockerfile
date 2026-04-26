# Multi-stage Dockerfile for forge/web
# BUILD CONTEXT: repo root (jarvis-agents/) so pnpm workspace can resolve workspace:* deps.
# Build with: docker build -f forge/web/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /repo

# Copy whole repo so pnpm workspace resolves (small footprint vs build correctness tradeoff)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY forge ./forge

# Install only web's transitive deps (web package name is "web", not "@forge/web")
RUN pnpm install --frozen-lockfile --filter web...

# Build
WORKDIR /repo/forge/web
ARG NEXT_PUBLIC_API_URL=http://localhost:8080/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_ENV_LABEL=
ENV NEXT_PUBLIC_ENV_LABEL=$NEXT_PUBLIC_ENV_LABEL
RUN pnpm build

# Production runtime — Next.js monorepo standalone places server.js at forge/web/
FROM node:22-alpine AS production
WORKDIR /app

COPY --from=base /repo/forge/web/.next/standalone ./
COPY --from=base /repo/forge/web/.next/static ./forge/web/.next/static
COPY --from=base /repo/forge/web/public ./forge/web/public

WORKDIR /app/forge/web
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
