# ADR 0013 — Widget API keys stored in plaintext, mitigated by rotation

- **Status:** Accepted
- **Date:** 2026-04-27
- **Context:** v1 EPIC 1 PR-C (ISS-295)

## Context

The chat widget authenticates against `forge/core` with a single per-project secret in the `X-Forge-API-Key` header. Three storage options were considered:

1. **Plaintext** in `projects.api_key` with a partial unique index, equality lookup on every widget request.
2. **Hash + prefix** like `refresh_tokens.token_hash` / `token_prefix` and `devices.token_hash` / `token_prefix`: the prefix is indexed, the hash is bcrypt/argon2 verified per request.
3. **JWT signed by core** with project id in the payload — no storage, just signature verification.

## Decision

Use **option 1 (plaintext)** for v1.

The widget key is the *only* credential a website embedder pastes into their page; it is, by design, a long-lived shared secret that is already exposed in the rendered HTML. Hashing the server-side copy does not change the threat model — anyone with view-source on the embedding page already has the secret. JWTs would force key rotation to be coordinated with every embedder, defeating the "rotate from the dashboard" UX in the same PR.

The mitigations we keep:

- **`fk_<48 hex>` format** — 192 bits of entropy, generated server-side via `crypto.randomBytes`. Brute force is not a realistic vector.
- **Partial unique index** (`WHERE api_key IS NOT NULL`) — a duplicate insert raises `23505`; the rotate endpoint should retry on collision (covered by future `isUniqueViolation` handling).
- **Single rotate endpoint** (`POST /api/projects/:id/api-key/rotate`, owner/admin only) — turns over the secret in one round trip; no historical key is preserved.
- **Redaction in list/get** — every read except the rotate response shows `fk_…<last4>`; the secret leaves Postgres only when the owner asks for a fresh one.

## Consequences

- A direct database read leak (e.g. operator dump, replica compromise, ORM SQL-injection) exposes every project's live widget key. The mitigation is rotation, not prevention.
- We accept this in exchange for: simpler middleware (single equality lookup, no hash verify per request), a UI that can show owners the full key once at rotation time, and parity with how the keys appear in browser HTML anyway.
- A future ADR may move to hashed storage if we add multi-tenant SaaS hosting where operator-trust assumptions weaken (e.g. shared-instance plans). At that point we keep the same `fk_` prefix as the lookup key + an argon2 hash column; the migration is additive.

## Alternatives Rejected

- **Hashed storage (option 2)** — defended against a threat model the embed widget already loses (the secret sits in the HTML). Doubles per-request CPU for no realistic win at v1 scale.
- **JWT (option 3)** — rotation requires re-distributing the token to every embedder; loses the dashboard-driven rotation UX.

## References

- Implementation: `forge/core/src/middleware/api-key.ts`, `forge/core/src/projects/routes.ts` (rotate endpoint), migration `0034_projects_api_key.sql`.
- Issue: ISS-295.
- Comparable hashed-credential designs in this codebase: `refresh_tokens` (auth/jwt), `devices` (device pairing) — both protect credentials whose plaintext is *not* embedded in HTML and therefore have a different threat model.
