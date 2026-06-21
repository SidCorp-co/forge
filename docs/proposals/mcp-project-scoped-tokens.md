# Proposal: Project-scoped MCP tokens (two API-key levels)

Make project-scoped MCP usage ergonomic. Today every MCP token is **user-level**: it identifies a *user*, never a project, so the caller must thread `X-Forge-Project-Slug` (or an explicit `projectId` arg) through **every** request to say which project the call targets. This proposal adds a second, optional level — a **project-level token** bound to one project at issue time — so a client can connect and call tools without repeating the project on each request, while the user-level token stays the default for cross-project / admin use.

- **Status:** Draft (pre-RFC) · 2026-06-16 · spec/design capture (ISS-496). No implementation in this issue — see [Out of scope](#6-out-of-scope--follow-up).
- **Target:** a single follow-up implementation issue (migration + principal wiring + handler resolution + REST + UI + tests).

## Current state (verified on `main`, ISS-496)

| Concern | Where | Behavior today |
|---|---|---|
| Project selection per request | `packages/core/src/mcp/handler.ts` | `projectSlug = c.req.header('x-forge-project-slug') ?? null`, passed into `createMcpServer({ projectSlug, … })`. |
| Slug → projectId resolution | `packages/core/src/mcp/tools/lib.ts` (`resolveProjectIdFromSlug`) | Throws `BAD_REQUEST` when the slug is missing, `NOT_FOUND` when no project matches. Tools may also accept an explicit `projectId` arg. |
| PAT principal | `packages/core/src/middleware/require-pat-or-device.ts` | `PatPrincipal = { kind:'pat', userId, tokenId, scopes, projectIds: readonly string[] \| null }`. No project-binding field. |
| `projectIds` allowlist fence | `packages/core/src/mcp/server.ts` | `if (principal.kind === 'pat' && principal.projectIds !== null)` and the target project ∉ list → returns `NOT_FOUND` (probe-safe — never 403, never leaks existence). The project hint is extracted generically from args by `projectIdFromArgs(args)` (top-level `projectId` or `filters.projectId`). |
| Token storage | `packages/core/src/db/schema.ts` (`personal_access_tokens`) | `scopes text[]`, `projectIds uuid[]` (`NULL` = inherit the user's memberships; non-null = strict allowlist). No binding column. |
| Issuance REST | `packages/core/src/pat/routes.ts` | `POST /api/pat` (mint; body = `name`/`scopes`/`projectIds`/`expiresAt`), plus `GET`/`DELETE`/`rotate`/`audit`. JWT-only (browser), not reachable via MCP. |

**Enforcement reality (important):** PAT `scopes` (`read`/`write`/`admin`) are effectively *advisory* — the gates that are actually enforced are the caller's **project role** (viewer < member < admin) and the **`projectIds` allowlist**. Any new binding must therefore be modeled as a *real* fence (a column the server enforces), not as a scope string.

## 1. Two token levels

| Level | Binding | `X-Forge-Project-Slug` | Use case |
|---|---|---|---|
| **User-level** (today, unchanged) | none (`bound_project_id` NULL) | **Required** per request (header or explicit `projectId` arg) | Cross-project, admin, multi-project automation. `projectIds` allowlist (when set) still fences which projects are reachable. |
| **Project-level** (new) | exactly one project, fixed at mint time | **Optional** — omitted ⇒ resolves to the bound project | Single-project clients/agents that should "just connect and call tools" without repeating the slug. |

Device tokens are unaffected — they remain user-level.

## 2. Data model (decision)

Add a nullable column to `personal_access_tokens`:

```ts
boundProjectId: uuid('bound_project_id').references(() => projects.id, { onDelete: 'cascade' }),
// NULL  = user-level token (today's behavior, no migration impact)
// set   = project-level token, bound to exactly this project
```

`PatPrincipal` gains the field, populated in `require-pat-or-device.ts` alongside `projectIds`:

```ts
export type PatPrincipal = {
  kind: 'pat';
  userId: string;
  tokenId: string;
  scopes: readonly string[];
  projectIds: readonly string[] | null;
  boundProjectId: string | null; // NEW
};
```

**Why a dedicated column, not a new token kind and not overloading `projectIds`:**

- A **new token kind** would fork every `principal.kind === 'pat'` branch (middleware, the `server.ts` allowlist gate, audit, rate-limit) — large blast radius for what is really one extra attribute.
- **Overloading `projectIds = [oneProject]`** conflates two distinct ideas: a *fence* (which projects are reachable) versus a *default* (which project is implied when none is given). A user could legitimately want a multi-project allowlist with no implied default; collapsing them removes that option and makes the data ambiguous.
- A nullable `bound_project_id` is the smallest change that is unambiguous: NULL is exactly today's behavior (zero backfill), non-null is the new level.

**Relationship between `boundProjectId` and `projectIds` (resolves ISS-496 clarify open-question #2):** a project-level token's binding is **both** the slug-omitted default **and** an authorization fence. Concretely, the server treats a non-null `boundProjectId` as if `projectIds` effectively contained exactly `[boundProjectId]` for fencing purposes (in addition to filling the default). This means the *existing* `server.ts` allowlist guard already produces the correct `NOT_FOUND` on a cross-project probe; see §3. At mint time `boundProjectId` and an explicit broader `projectIds` are mutually exclusive (a bound token's reachable set is, by definition, its one project).

## 3. Resolution precedence (the core rule)

Compute the **effective project once** — in `mcpHandler` / the `McpContext` — so every tool *and* the managed-meta-prompt path (`metaProjectId()` in `server.ts`) inherit the same answer, rather than threading bound-project logic through each tool. Algorithm, highest precedence first:

1. Explicit `projectId` arg on the tool call (if the tool takes one), else
2. `X-Forge-Project-Slug` header, else
3. `boundProjectId` (project-level token only), else
4. `BAD_REQUEST: project context missing` — unchanged behavior for user-level tokens with nothing supplied.

**Conflict rule:** if an explicit slug/arg is supplied (steps 1–2) and it resolves to a project `≠ boundProjectId`, reject with **`NOT_FOUND`** — never `403`, never an error that distinguishes "exists but forbidden" from "does not exist" (probe-safe, mirroring the existing out-of-scope allowlist behavior). Because the binding is also enforced as the `projectIds` fence (§2), this rejection falls out of the *existing* `server.ts` guard once `boundProjectId` is folded into the effective allowlist — no new bespoke conflict branch is required, only the fold.

> Implementation note for the follow-up: resolve `boundProjectId` (a UUID) without a slug round-trip — the slug→id helper (`resolveProjectIdFromSlug`) is only needed when the *header* path is taken. The effective-project resolver should return a `projectId` directly when falling back to the binding.

## 4. Backward compatibility

- **Existing user-level PATs** (`bound_project_id` NULL): identical behavior — same header/`projectId` requirement, same `projectIds` allowlist semantics, same `BAD_REQUEST`/`NOT_FOUND` error codes.
- **Device tokens**: unchanged (always user-level).
- **Migration**: add one nullable column; **no backfill**, no data rewrite. Every pre-existing row is NULL and therefore user-level.
- **`tools/list`, audit, rate-limit**: untouched — the change is confined to project resolution + the mint path.

## 5. Issuance / UX

### REST (`packages/core/src/pat/routes.ts`)
- Extend `POST /api/pat` `createBodySchema` with an optional `boundProjectId: z.uuid()`.
  - Mutually exclusive with a multi-project `projectIds` (a bound token's allowlist is implicitly its one project); reject the combination with `BAD_REQUEST`.
  - The caller must be a **member of the bound project** — validate against `loadVisibleProjectIds` / the existing membership check (a user cannot mint a token for a project they cannot access).
- Reflect the binding in `publicShape` (e.g. `boundProjectId` in the token list response) so the UI can label bound tokens. Plaintext is still returned exactly once at mint, unchanged.

### Web (Settings → MCP / PAT)
- The token-creation form gains a **"Bind to a project"** option (a project picker, defaulting to "None — user-level / all my projects"). Selecting a project sends `boundProjectId` and disables the multi-project allowlist control.
- The token list shows each token's level: "User-level" or "Project: `<slug>`", so the binding is visible after creation.
- Copy guidance for a bound token: clients can drop the `X-Forge-Project-Slug` header entirely.

### Optional: discoverability
Consider surfacing the bound project to clients (e.g. via a lightweight `whoami` / capability in the MCP handshake or `forge_version`) so a connected agent can learn which project it is scoped to without a separate call. Nice-to-have; the follow-up may defer it.

## 6. Out of scope / follow-up

This issue is the **design contract only**. A single follow-up implementation issue will deliver, in order:

1. Migration: `bound_project_id` nullable column + FK (`pnpm db:generate` + `db:migrate`).
2. `PatPrincipal.boundProjectId` wiring in `require-pat-or-device.ts`.
3. Effective-project resolver in `mcpHandler` / `McpContext`; fold `boundProjectId` into the `server.ts` allowlist fence.
4. `POST /api/pat` body + validation (membership, mutual-exclusion) + `publicShape`.
5. Web Settings bind-to-project UI.
6. Tests: resolution precedence, the `NOT_FOUND` conflict path, and backward-compat (NULL binding behaves as today).

## Open questions

- Should a bound token be discoverable via `whoami`/capability (§5), or is that a separate ergonomics issue?
- Rotation: `POST /api/pat/:id/rotate` should preserve `boundProjectId` — confirm in the implementation issue (the binding is a property of the token identity, not the secret).
