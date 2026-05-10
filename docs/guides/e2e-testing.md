# End-to-end UI testing — bot user setup

Forge does not ship a fixed test user. Operators provision their own bot
account in each deployment via two env vars; the core seeds (or refreshes)
the matching `users` row on startup. The bot logs into the web app like a
real human, which is what end-to-end tools (Playwright, Cypress, manual
Claude-Code-driven smoke runs) need to drive the UI.

## Provisioning

Set both env vars on the host that runs `@forge/core`:

| Var | Required | Notes |
|---|---|---|
| `E2E_USER_EMAIL` | yes | Any RFC-5321 email. The local-auth flow does not send mail to this address, so a fictitious domain is fine — it just identifies the row. |
| `E2E_USER_PASSWORD` | yes (≥ 8 chars) | Plaintext. The seed function hashes it with argon2id (`m=19456, t=2, p=1`) on boot. Pick a long random string and treat it as a secret. |

When **both** are set, on startup `seedE2eUserIfConfigured()`
(`packages/core/src/auth/seed-e2e-user.ts`) does an upsert:

- Row missing → INSERT with `email_verified_at = NOW()`.
- Row exists with NULL or stale hash → re-hash and UPDATE.
- Row exists with a hash that already verifies the env password → no-op.

When either var is missing → no-op. Fresh local dev or a contributor who
doesn't run e2e suites stays unaffected.

The bot row is a normal user — no admin, no CEO, no automatic project
membership. It is kept that way deliberately: e2e suites should test the
unprivileged path most users hit.

## Granting project access

The seeder leaves `project_members` alone (a hardcoded project UUID would
not be portable across installations). After the first boot has created
the user, grant access per project:

```sql
INSERT INTO project_members (user_id, project_id, role)
SELECT u.id, '<project-uuid>', 'member'
FROM users u
WHERE u.email = '<your E2E_USER_EMAIL>'
ON CONFLICT DO NOTHING;
```

Do this once per environment per project the bot needs to drive.

## Logging in (manual smoke)

```bash
export E2E_USER_EMAIL='bot@example.invalid'
export E2E_USER_PASSWORD='your-strong-password'

curl -sX POST "$API_BASE_URL/api/auth/local" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$E2E_USER_EMAIL\",\"password\":\"$E2E_USER_PASSWORD\"}" -i
```

Expected 200 with a `Set-Cookie: forge_auth=…; HttpOnly; SameSite=Lax`
header and a JSON body containing `token`, `user`, and
`emailVerificationRequired: false`.

If the response is `401 / EMAIL_NOT_VERIFIED`: the seed function never
ran (env vars unset on the deploy host) or the row was provisioned by an
older path that left `email_verified_at` null. Check the core logs for
`seeded e2e test user` / `verified existing e2e test user` /
`refreshed e2e test user password` messages.

## Driving the UI from a Playwright session

Forge auth is cookie-based on the `forge_auth` cookie (HS256 JWT, 7-day
TTL, `HttpOnly`, `Secure`, `SameSite=Lax`, optional `Domain` set via
`AUTH_COOKIE_DOMAIN`). Two sane ways to authenticate a Playwright (or
Playwright MCP) session:

### Option A — Cookie injection (recommended)

After the login HTTP call returns the cookie, set it on the browser
context **before** the first `page.goto`:

```ts
await context.addCookies([{
  name: 'forge_auth',
  value: token,
  domain: process.env.AUTH_COOKIE_DOMAIN ?? new URL(WEB_BASE_URL).hostname,
  path: '/',
  httpOnly: true,
  secure: WEB_BASE_URL.startsWith('https://'),
  sameSite: 'Lax',
}]);
await page.goto(`${WEB_BASE_URL}/projects/<slug>/agent`);
```

`HttpOnly` is irrelevant when injecting via the Playwright API — that flag
only blocks JavaScript reads of the cookie at runtime.

### Option B — `Authorization: Bearer` header

Add a `Route.fulfill` interceptor that appends `Authorization: Bearer
<token>` to every request. Workable but more invasive — most Forge
endpoints prefer the cookie. Use this when you cannot set cookies (cross-
origin Playwright runner, embedded iframe testing, etc.).

### Reliability check after navigate

```ts
const path = await page.evaluate(() => window.location.pathname);
if (path === '/login') throw new Error('e2e auth failed — token rejected');
```

## Token lifetime + rotation

- `forge_auth` JWT lives 7 days (signed with backend `JWT_SECRET`). A
  Playwright run is seconds-to-minutes, so re-login per run rather than
  caching the token.
- `forge_refresh` cookie rotates on use (30-day window). Not needed for
  short-lived test runs.
- Rotating the bot password = update `E2E_USER_PASSWORD` env on the
  deploy host and restart core. The seed function re-hashes and stores
  the new hash on the next boot.

## Local development

If you run `npm run dev` in `packages/core/` against a local Postgres,
export the env vars in your shell (or `.env`) before starting the
process:

```bash
export E2E_USER_EMAIL='bot@example.invalid'
export E2E_USER_PASSWORD='dev-only-password'
npm run dev
```

The seed function logs one of `seeded`, `verified existing`, or
`refreshed` on every boot when env is set, so you can confirm
provisioning succeeded.

## What this guide is NOT

- A persisted Playwright/Cypress test suite. Forge does not ship one
  today; the seed mechanism is a prerequisite for whichever harness an
  operator picks.
- A service-account / machine-token concept (long-lived API key, bearer
  rotation policy, scope claims). The bot is a regular user. A proper
  service-account model would be a separate, larger workstream.
- A way to grant the bot admin or CEO privileges. If your e2e suites need
  to exercise admin paths, set up a separate admin bot or upgrade the
  same row out-of-band.

## Source

- Seed function: `packages/core/src/auth/seed-e2e-user.ts`
- Env schema: `packages/core/src/config/env.ts` (`E2E_USER_EMAIL`,
  `E2E_USER_PASSWORD`)
- Bootstrap call: `packages/core/src/index.ts` (after
  `seedDomainTemplates`)
- Migration that supersedes the original hardcoded seed:
  `packages/core/drizzle/migrations/0054_invalidate_e2e_seed_hash.sql`
