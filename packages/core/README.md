# @forge/core

Forge core API — Hono + Drizzle backend. A single Node process serves REST, WebSocket, and MCP; a single Postgres holds data, jobs (pg-boss), and vectors (pgvector).

## Prerequisites

- **Node** `>=20` (enforced via `engines.node`)
- **pnpm** — the repo's `packages/*` workspace (`contracts`, `core`, `dev`, `observability`, `web-v2`, plus the Rust `runner` Cargo workspace and a `tests` dir)
- **Postgres 17** — the compose stack at the repo root gives you one preconfigured (`forge` DB, user `forge`, password `forge_secret`)
- **Docker** — only needed if you run integration tests in `container` mode

## Install

```bash
# From the repo root
pnpm install
```

Install from the repo root, not from inside `packages/core/`. The pnpm workspace links the active packages (`contracts`, `core`, `dev`, `observability`, `web-v2`) together.

## Environment

The env schema lives in [`src/config/env.ts`](./src/config/env.ts) and is validated by Zod at startup. If anything is missing or malformed, the process throws with a bulleted list pointing at the offending keys — copy-paste from that error to find what's wrong.

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://forge:forge_secret@localhost:5432/forge` | matches the compose defaults |
| `JWT_SECRET` | 32+ char random string | user session tokens |
| `DEVICE_TOKEN_PEPPER` | 32+ char random string | hashes device tokens |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | any SMTP credentials | transactional email |
| `CORS_ORIGINS` | `http://localhost:3000` | comma-separated allow-list |
| `PORT` | `8080` (default) | |
| `NODE_ENV` | `development` (default) | `development` / `test` / `staging` / `production` |

For local work outside compose, drop a minimal `.env` into `packages/core/`:

```env
DATABASE_URL=postgres://forge:forge_secret@localhost:5432/forge
JWT_SECRET=replace-with-a-32-char-random-string-xxxxx
DEVICE_TOKEN_PEPPER=replace-with-a-32-char-random-string-xxx
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_USER=dev
SMTP_PASS=dev
SMTP_FROM=dev@example.com
CORS_ORIGINS=http://localhost:3000
```

## Run locally

```bash
cd packages/core
pnpm dev         # tsx watch, http://localhost:8080
```

Health check:

```bash
curl http://localhost:8080/health
# → { "ok": true, "db": { "ok": true }, "queue": { "ok": true }, "ws": { "ok": true } }
```

Returns **200** only when DB + pg-boss queue + WS are all up; otherwise **503** with the
same shape and the failing subsystem's `ok:false`. A bare local `pnpm dev` (no queue/WS)
commonly returns `ok:false` / 503.

Production-style run:

```bash
cd packages/core
pnpm build && pnpm start
```

## Tests

### Unit (no DB, safe anywhere)

```bash
pnpm --filter @forge/core test
```

### Integration — local schema mode (fast)

```bash
# From the repo root
docker compose up -d postgres

export TEST_DATABASE_URL="postgres://forge:forge_secret@localhost:5432/forge"
pnpm --filter @forge/core test:integration
```

Each run creates its own disposable schema inside the target DB and drops it after.

### Integration — CI-style (self-contained, Testcontainers)

```bash
pnpm --filter @forge/core test:integration:ci
```

Needs a local Docker daemon. No shared Postgres required.

→ See [tests/README.md](./tests/README.md) for the hybrid test DB decision, writing new integration tests, factories, and timing targets.

## Database workflow

```bash
cd packages/core
pnpm db:generate   # reads src/db/schema.ts → drizzle/migrations/NNNN_*.sql
pnpm db:migrate    # applies pending migrations to $DATABASE_URL
pnpm db:studio     # drizzle-kit studio — browse the DB in a UI
```

→ See [src/db/README.md](./src/db/README.md) for schema conventions (uuid PKs, timestamp style, FK behavior, pgvector).

## Other scripts

| Script | Purpose |
|---|---|
| `pnpm lint` | Biome check over `src` and `tests` |
| `pnpm lint:fix` | Biome check with `--write` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm clean` | `rm -rf dist` |
