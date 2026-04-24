# Multi-stage Dockerfile for forge/web
# Uses pnpm because the package depends on @forge/contracts via workspace:*
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /repo

# Copy workspace manifests so pnpm can resolve workspace deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY contracts/package.json ./contracts/
COPY web/package.json ./web/

RUN pnpm install --frozen-lockfile --filter @forge/web... --prod=false

# Copy source + build
COPY contracts ./contracts
COPY web ./web
WORKDIR /repo/web
ARG NEXT_PUBLIC_API_URL=http://localhost:8080/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm build

# Production runtime
FROM node:22-alpine AS production
WORKDIR /app

COPY --from=base /repo/web/.next/standalone ./
COPY --from=base /repo/web/.next/static ./.next/static
COPY --from=base /repo/web/public ./public

EXPOSE 3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
