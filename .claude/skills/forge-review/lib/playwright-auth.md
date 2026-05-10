# Playwright MCP pre-auth runbook

Authenticate the Playwright MCP browser session before any AC check runs against `forge-beta.sidcorp.co`. Without this step, every navigation hits the login wall and the gate either silently passes or stalls at `on_hold` (root cause of ISS-67/79/81/85/86).

## Inputs (worker-host env)

| Var | Example | Purpose |
|---|---|---|
| `FORGE_E2E_BASE_URL` | `https://forge-beta.sidcorp.co` | Base URL the gate verifies against. |
| `FORGE_E2E_EMAIL` | `playwright-bot@forge.local` | Test user email (verified, member of Forge Dev project). |
| `FORGE_E2E_PASSWORD` | (32-char random) | Stored on worker host only — never commit. |

If any var is missing → fail the gate, post a comment naming the missing var, set `status=reopen`. Do NOT continue without auth.

## Why UI login (and not API + cookie injection)

`forge_auth` is `httpOnly`. `mcp__playwright__browser_evaluate('document.cookie = ...')` cannot set httpOnly cookies — the API-call-then-inject pattern would silently drop the session. Filling the existing login form is the minimum-change path that works with the unmodified Playwright MCP toolset.

## Procedure

1. **Navigate to login**
   ```
   mcp__playwright__browser_navigate → ${FORGE_E2E_BASE_URL}/login
   ```

2. **Fill credentials** — selectors live in `packages/web/src/app/(auth)/login`. Confirm field names against that route when wiring; if they drift, update this runbook.
   ```
   mcp__playwright__browser_fill_form → [
     { name: "email",    value: ${FORGE_E2E_EMAIL} },
     { name: "password", value: ${FORGE_E2E_PASSWORD} }
   ]
   ```
   Submit by clicking the submit button or `mcp__playwright__browser_press_key → Enter`.

3. **Wait for redirect** — login success redirects off `/login` (typically to `/projects` or the user's dashboard).
   ```
   mcp__playwright__browser_wait_for → text="Projects" (or pathname change off /login)
   ```
   Time budget: 10s. On timeout → fail gate, post the response status if visible.

4. **Health check** — navigate to the project the AC will exercise, then read pathname.
   ```
   mcp__playwright__browser_navigate → ${FORGE_E2E_BASE_URL}/projects/forge-dev
   mcp__playwright__browser_evaluate → window.location.pathname
   ```
   If the result is `/login` → cookies missing/expired → fail gate. Do NOT pass-by-default.

## 401 / re-login policy during AC checks

If any subsequent AC step shows HTTP 401 (visible in `mcp__playwright__browser_network_requests`) or an unexpected redirect to `/login`:

- Re-run the **Procedure** above once.
- Retry the failing step.
- If it 401s again → fail gate, post the request log + a one-line action `Rotate FORGE_E2E_PASSWORD or re-verify the test user`.

## Negative-case spot check stays compatible

The SKILL's negative-case probe (one unauthenticated request or malformed input per state-mutation AC) does NOT need to log out — it just hits an unauthenticated endpoint or sends bad input from the authed session. Keep the session intact across positive and negative cases.

## Test user provisioning (one-time, out-of-repo)

Document for re-runs; do NOT script in the repo (the password must never land in source).

1. Generate a 32-char random password locally.
2. Register the user against forge-beta:
   ```bash
   curl -sS -X POST https://forge-beta.sidcorp.co/api/auth/register \
     -H 'Content-Type: application/json' \
     -d '{"email":"playwright-bot@forge.local","password":"<pw>"}'
   ```
   Expect HTTP 201.
3. Verify the email by direct SQL on the forge-beta DB (the `/dev/force-verify` route is disabled in production):
   ```sql
   UPDATE users SET email_verified_at = now() WHERE email = 'playwright-bot@forge.local';
   ```
4. Add `playwright-bot@forge.local` as a member (role: `member`) of the Forge Dev project. Use the project-members admin UI; if not yet wired, insert into `project_members` directly.
5. Persist the three env vars on the worker host using whatever mechanism already holds `OPENAI_API_KEY` / `STRAPI_API_TOKEN` (e.g. `~/.zshrc.local`, `/home/kieutrung/.config/forge-dev/`). Do NOT introduce a new secret store.
6. Smoke test from the worker host:
   ```bash
   curl -sS -X POST "$FORGE_E2E_BASE_URL/api/auth/local" \
     -H 'Content-Type: application/json' \
     -d "{\"email\":\"$FORGE_E2E_EMAIL\",\"password\":\"$FORGE_E2E_PASSWORD\"}" -i | head -20
   ```
   Expect HTTP 200 + `Set-Cookie: forge_auth=...`.

## Notes

- Token TTL is 7 days. Worker runs are far shorter, but the 401 retry policy above covers any edge case.
- Rotate the password quarterly — manual reminder, not automated. Update the worker-host env then re-run the smoke test.
- The test user has member-level access only. A leaked password lets an attacker create issues / edit project content in Forge Dev. Mitigation: storage on worker host only + 7-day token TTL.
- If `forge.local` ever becomes a routable domain, rotate the email to a non-routable subdomain we control.
