# End-to-end testing — bot account & Playwright MCP setup

> Reference: ISS-89 (auth setup) and migration `0053_seed_e2e_test_user.sql`.

The Forge codebase ships a **fixed bot user** so any future automated UI test
(Playwright MCP, CI e2e suite, manual smoke from a fresh worker) can log into
`forge-beta.sidcorp.co` without per-environment provisioning.

## What lives where

| Thing | Where | Notes |
|---|---|---|
| User row (UUID + email + verified + argon2id password hash) | `packages/core/drizzle/migrations/0053_seed_e2e_test_user.sql` | Idempotent UPSERT. Re-applying refreshes the hash + verified-at. |
| Plaintext password | **Not in git.** Local file at `~/.config/forge-e2e/credentials.env` (mode 0600) on the worker host | Future sessions: read it via `source ~/.config/forge-e2e/credentials.env` |
| Project membership | **Not seeded by migration.** Add manually per project | Migration intentionally avoids hardcoding project IDs so it's safe on fresh local DBs |
| Memory pointer for AI sessions | `~/.claude/projects/-home-kieutrung-tools-forge-jarvis-agents/memory/e2e_test_user.md` | Future Claude sessions auto-load this and know where to look |

## Bot user identity

- **Email:** `playwright-bot@sidcorp.co`
- **User ID (fixed):** `48138337-8cde-4f78-ba9e-1eb27180fa71`
- **Role:** standard user (NOT CEO, NOT admin)
- **Email-verified:** yes (set in migration)
- **OAuth:** none — local password only

The user has no special privileges. To test something that requires project
membership (the agent UI at `/projects/<slug>/agent`, etc.), add the bot to
that project once via the normal `project_members` flow:

```sql
-- one-time, per project you want the bot to access
INSERT INTO project_members (user_id, project_id, role)
VALUES ('48138337-8cde-4f78-ba9e-1eb27180fa71', '<project-uuid>', 'member')
ON CONFLICT DO NOTHING;
```

For the Forge Dev project (production beta), this is project id
`da368b0a-8e21-4763-9d90-8f7b9d0c7115`.

## Login flow (manual smoke)

```bash
source ~/.config/forge-e2e/credentials.env

curl -i -X POST "$FORGE_E2E_API_URL/api/auth/local" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$FORGE_E2E_EMAIL\",\"password\":\"$FORGE_E2E_PASSWORD\"}"
```

Expected 200 with `Set-Cookie: forge_auth=…; Domain=.sidcorp.co; HttpOnly; SameSite=Lax`
plus a JSON body containing `{token, user, emailVerificationRequired: false}`.

If you see `EMAIL_NOT_VERIFIED`: the migration hasn't applied to that
environment yet, or the row was manually wiped. Re-run migrations.

## Playwright MCP usage (the original purpose)

The forge-review skill's e2e gate (`.claude/skills/forge-review/SKILL.md`)
should pre-authenticate Playwright MCP before navigating to the UI. Two
viable injection paths:

### Path A — Bearer header (simplest)

Login via `/api/auth/local`, grab `token` from the JSON body, set it as
`Authorization: Bearer <token>` on every fetch the page issues. Works for
single-page apps that send all requests through the same client.

### Path B — Cookie injection (mirrors real browser)

After login, extract the `Set-Cookie: forge_auth=…` header and inject into
the Playwright browser context BEFORE the first navigate:

```ts
// pseudo, real Playwright MCP equivalent uses browser_evaluate
await page.context().addCookies([{
  name: 'forge_auth',
  value: token,
  domain: '.sidcorp.co',
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
}]);
await page.goto('https://forge-beta.sidcorp.co/projects/forge-dev/agent');
```

Recommended path: **B**, because it mirrors the production cookie-based auth
exactly and the auth-required middleware sees the same shape it would for a
human user. The httpOnly flag is irrelevant for cookie injection — only
matters for JavaScript visibility, which Playwright bypasses.

### Health check after navigate

Always assert no-redirect-to-login before running ACs:

```ts
const path = await page.evaluate(() => window.location.pathname);
if (path === '/login') throw new Error('e2e auth failed — token rejected');
```

Per the forge-review SKILL.md auth-wall handling: if the page is unreachable
or auth wall hit, **do NOT pass-by-default**. Set the issue to `on_hold`
with a comment naming the failure.

## Token lifetime

- Access token (`forge_auth` cookie / `token` body): **7 days** (HS256 JWT,
  signed with backend `JWT_SECRET`).
- Refresh token (`forge_refresh` cookie): **30 days**, rotates on use.

Worker runs are typically minutes long. Re-login each worker run for safety
(it's a single fast HTTP call) rather than persisting tokens.

## Rotating the password

If you suspect the plaintext leaked:

1. Generate a new strong password and the matching argon2id hash:
   ```bash
   PASS=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-28)Pb1!
   echo "PASS=$PASS"
   node -e "
   const argon2 = require('argon2');
   argon2.hash('$PASS', { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
     .then(h => console.log(h));
   "
   ```
2. Add a NEW migration `00XX_rotate_e2e_test_user_password.sql` that
   `UPDATE users SET password_hash = '<new-hash>' WHERE id = '48138337-…'`.
   Do NOT mutate `0053_seed_e2e_test_user.sql` — migrations are append-only.
3. Update `~/.config/forge-e2e/credentials.env` with the new plaintext.
4. Document the rotation date in this file's CHANGELOG section below.

## Out of scope

- Service-account / long-lived API token concept (separate, larger work —
  see ISS-89 § "Out of scope").
- Persisted Playwright e2e test files (one-off live verification only,
  driven by forge-review).
- Wiring the bot into multiple projects automatically. Project membership
  is a per-environment manual step.

## Changelog

- **2026-05-11** — Initial seed via migration `0053_seed_e2e_test_user.sql`
  (ISS-89). User pre-existed on prod from a manual register call earlier in
  the same session; migration's UPSERT reconciles that row.
