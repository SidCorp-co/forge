# API route

**Change kind:** API route
**Introduced by:** ISS-466

A REST route on core: one act or one read of one module, under `/api/...`. Every act and every
read is a route first; the `forge` CLI calls it and an MCP tool exists only where neither covers
what an agent needs (BC-21). A change takes this entry when it adds a route, changes a route's
body, query or answer, or adds a refusal a route answers with. It builds on
[Core module](core-module.md): the route lives in its module's **routes.ts**, and the rule it applies
lives in that module's **rules.ts** and **service.ts**.

## Reference

- `packages/core/src/suggestions/routes.ts` — param validators, `strictBody` with a SHAPE string, the actor, one service call, `answer` turning an outcome into `refused` or `c.json`
- `packages/contracts/src/suggestions.ts` — the request schema (`createSuggestionRequestSchema`), its SHAPE string (`CREATE_SUGGESTION_SHAPE`) and the refusal codes, declared once for core and web
- `packages/core/src/suggestions/service.ts` — the write the route calls, answering `{ ok: true, … } | { ok: false, refusals }`
- `packages/core/src/suggestions/rules.ts` — the pure guards the service applies
- `packages/core/src/middleware/zod-validator.ts` — `strictBody` and `zValidator`, the 400 every bad body or path gets
- `packages/core/src/lib/refusal.ts` — `refused`, the one refusal envelope
- `packages/core/src/route-registry.ts` — the one place a module's router is mounted
- `packages/core/src/credentials/pat-permissions.ts` — `PAT_PERMISSION_RESOURCES`, where a new prefix is made grantable to a token
- `packages/core/contracts/forge-api.openapi.json` — the published contract, regenerated with `pnpm --filter @forge/core contracts:generate`

## Test shape

- `packages/core/src/suggestions/rules.test.ts` — the guards behind a route, called with plain values: each refusal's code and JSON pointer, in the order the route names them
- `packages/core/tests/integration/contract-waits-e2e.test.ts` — the route over HTTP on a throwaway Postgres: the write, a refusal by name with its status, and the reads that see the write

A new route gets its guards tested beside **rules.ts** under vitest (`pnpm --filter @forge/core
test`), and the route itself in one `*-e2e.test.ts` under `packages/core/tests/integration/`,
collected by `packages/core/vitest.integration.config.ts`. The e2e test sends the request a client
sends and asserts the answer's status, its `code` and `refusals[].path` for each wrong input it
plants, and the row a read then shows. A request shape is proven by planting the unknown key and
the missing field and seeing the 400 name them. `check-api-contracts` holds the published contract
to the code, so a route whose contract file was not regenerated fails `pnpm verify`.

## Review checklist

1. The route file holds no database call and no rule: it validates, calls one service or read function, and answers.
2. The body is a `z.strictObject` from contracts read through `strictBody` with its SHAPE string; path and query go through `zValidator` with a message naming what is valid.
3. Every refusal is a code declared in contracts, answered in the envelope through `refused`, with a status that says what the client should do.
4. The service asks `can()` for the permission the act needs; the route reads no role, grant or token itself.
5. A new prefix is listed in `PAT_PERMISSION_RESOURCES`, and the router is mounted only in **route-registry.ts**.
6. `forge-api.openapi.json` (and `forge-mcp.tools.json` where a tool changed) is regenerated in the same change.
7. A write answers what it changed; a list answers summaries and a whole document comes only from a get.
8. A refusal's detail names what was wrong and what is valid, and names another entity by its key, never by uuid.
9. A wrong input is refused by name; no schema was widened and no compatibility branch added to accept it.
