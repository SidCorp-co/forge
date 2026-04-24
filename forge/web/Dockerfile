# Multi-stage Dockerfile for forge/web
# BUILD CONTEXT: repo root (jarvis-agents/), so pnpm workspace can resolve workspace:* deps.
# Build with: docker build -f forge/web/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /repo

# Workspace manifests (cache layer)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY forge/contracts/package.json ./forge/contracts/
COPY forge/web/package.json ./forge/web/

RUN pnpm install --frozen-lockfile --filter @forge/web... --prod=false

# Source + build
COPY forge/contracts ./forge/contracts
COPY forge/web ./forge/web
WORKDIR /repo/forge/web
ARG NEXT_PUBLIC_API_URL=http://localhost:8080/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm build

# Production runtime
FROM node:22-alpine AS production
WORKDIR /app

COPY --from=base /repo/forge/web/.next/standalone ./
COPY --from=base /repo/forge/web/.next/static ./.next/static
COPY --from=base /repo/forge/web/public ./public

EXPOSE 3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
