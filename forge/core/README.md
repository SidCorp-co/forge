# @forge/core

Forge core API — Hono + Drizzle backend (RFC 0002).

## Scripts

- `pnpm dev` — start dev server (tsx watch) at `http://localhost:8080`
- `pnpm build` — compile to `dist/`
- `pnpm start` — run compiled build
- `pnpm test` — run Vitest
- `pnpm lint` — Biome check
- `pnpm typecheck` — tsc --noEmit

## Health check

```bash
curl http://localhost:8080/health
# → {"ok":true}
```
