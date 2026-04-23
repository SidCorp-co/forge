# @forge/core

Forge core API — Hono + Drizzle backend (RFC 0002).

## Scripts

- `pnpm dev` — start dev server (tsx watch) at `http://localhost:8080`
- `pnpm build` — compile to `dist/`
- `pnpm start` — run compiled build
- `pnpm test` — run Vitest unit tests
- `pnpm test:integration` — run integration tests against a real Postgres (see [tests/README.md](./tests/README.md))
- `pnpm lint` — Biome check
- `pnpm typecheck` — tsc --noEmit

## Testing

Unit tests live next to the source (`src/**/*.test.ts`) and stub Postgres /
pg-boss via `vi.mock`. Integration tests live under `tests/integration/` and
run against a real Postgres — either a Testcontainers-managed instance (CI)
or a disposable schema inside a local Postgres (dev). See
[tests/README.md](./tests/README.md) for the decision + full setup.

## Health check

```bash
curl http://localhost:8080/health
# → {"ok":true}
```
