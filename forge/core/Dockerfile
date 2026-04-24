FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
COPY skills/ skills/
COPY drizzle/ drizzle/
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/skills/ skills/
COPY --from=builder /app/drizzle/ drizzle/

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

# Run migrations via runtime migrator (uses drizzle-orm, no drizzle-kit needed)
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
