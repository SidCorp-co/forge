# ADR 0012 — Web API client shape

- **Status:** Accepted
- **Date:** 2026-04-24
- **Context:** [RFC 0002](../rfcs/0002-replace-strapi-with-hono-drizzle.md), [ADR 0010](0010-clean-break-from-strapi.md), Phase 2.6 `packages/web` rewire onto `packages/core`.
- **Supersedes:** none.

## Context

Phase 2.6 rewires `packages/web` off Strapi onto `packages/core`. The previous client hit Strapi's `/api/*` with a bearer token in `Authorization` and unwrapped Strapi's `{ data, meta }` envelope.

For the clean-break cutover (ADR 0010) we need a client shape that:

1. Reflects core's actual API shape — bare rows, `X-Total-Count` header for list totals, UUIDs everywhere, no `documentId`, no `populate=*`, no `filters[x][$eq]=`.
2. Uses cookie-based JWT auth (`forge_auth`, httpOnly) so a script on the page cannot exfiltrate the access token.
3. Keeps the web bundle decoupled from `packages/core/src` — `core` is a server app, not a library.
4. Derives TypeScript types from the canonical Drizzle schema so a schema change surfaces as a typecheck break, not a runtime 500.

Options considered:

| Option | Verdict |
|---|---|
| **OpenAPI generator** (`@hono/zod-openapi` → `openapi-typescript`) | Rejected. `packages/core` uses plain Hono + `zValidator`. Adopting OpenAPI requires rewriting every route to the OpenAPI variant — scope creep. Revisit post-v0.x if we publish an external API. |
| **tRPC / Hono RPC client** | Rejected. Couples `web` to a TS-only contract; the REST surface must stay usable by `packages/dev`, MCP consumers, and third parties. RFC 0002 targets REST. |
| **Zod-derived types only (`z.infer`)** | Good for request bodies, wrong for response rows. Responses are Drizzle row shapes; duplicating them as Zod is churn. |
| **Manual TS types maintained in `packages/web`** | Rejected. Drifts from the DB; the exact failure mode we are avoiding. |
| **Hand-written `apiClient` + shared types from Drizzle `$inferSelect` + exported Zod request schemas** | ✅ Chosen. Single source of truth (DB schema); reuses Zod validators core already writes; zero build-time codegen; ~50 LOC of glue. |

## Decision

`packages/web` talks to `packages/core` through a hand-written `apiClient` in `packages/web/src/lib/api/client.ts`.

1. **Auth.** Cookie-based. `POST /api/auth/local` sets `forge_auth` (httpOnly, `SameSite=Lax`). `fetch(..., { credentials: 'include' })` on every call. The login response still includes the JWT for CLI/test tooling, but the browser never reads it — the cookie is the active credential. The refresh token (long-lived, single-use, rotating) lives in `localStorage` because it is explicitly returned in the login response body.
2. **Envelope.** None. Core returns `T` for single resources and `T[]` plus `X-Total-Count` for lists. `apiClientList<T>` wraps list calls into `{ items: T[]; totalCount: number }`; `apiClient<T>` returns the bare body for everything else.
3. **Types.** `@forge/contracts` — a workspace package under `packages/contracts/` — re-exports:
   - **Row types** via `InferSelectModel<typeof schema.table>` from `@forge/core/public`.
   - **Request types** via `z.infer<typeof requestSchema>` re-exports from `@forge/core/public`.
   - **Response wrappers** (`ListResponse<T>`, `LoginResponse`, …) hand-typed.
   The package depends on `@forge/core` as `workspace:*` but imports **types only** (`import type`). No runtime coupling.
4. **Error model.** `ApiError extends Error` exposes `status`, `code`, `details` (from core's `HTTPException` shape). Feature modules render `code` (`FORBIDDEN`, `NOT_FOUND`, `ILLEGAL_TRANSITION`, `BAD_REQUEST`) via a shared `formatApiError`.
5. **No codegen. No build step for `@forge/contracts`.** TypeScript resolves the package by its `"types"` entry in `package.json`.

## Consequences

- **Schema drift becomes a typecheck error.** Adding a column to `issues` propagates to `Issue` in contracts, breaks any consumer that still expects the old shape at compile time.
- **`packages/core` must keep its public surface stable.** Renaming a table column is now a cross-package change. Acceptable for an internal monorepo; we accept the coordination cost for single-source-of-truth.
- **`packages/contracts` exports a minimal surface.** Only what clients need (rows + request inputs + response wrappers). Internal helpers stay in `packages/core`.
- **No OpenAPI doc.** If we later publish the API externally, wrap core in `@hono/zod-openapi` and add a generator. Not needed for the internal alpha.
- **Client is hand-written.** ~80 LOC for `apiClient` + `apiClientList`. Small enough to read in one sitting; large enough to cover pagination, error handling, and credentials.

## Alternatives revisited

If the API surface stabilises and we publish an external client (or a public REST doc), revisit OpenAPI. The switch is additive: add `@hono/zod-openapi` route wrappers and point `openapi-typescript` at the generated spec. `@forge/contracts` can either stay (private convenience) or be deprecated in favour of the generated client.

## Out of scope

- **Automatic 401 → refresh → retry interceptor.** F2 adds it on the first view that needs it; F1 only wires `login`, `logout`, `me`, `refresh` as discrete calls.
- **File upload client.** No `/upload` endpoint in Phase 2.6. Dropped `apiUpload` entirely.
- **MCP typings.** MCP uses device tokens; its types belong in `packages/dev`, not `@forge/contracts`.
