# E2E — Phase 2.6-F4

Playwright harness for `forge/web`. Runs a single Chromium happy-path spec
against a live `forge/core` instance.

## Run locally

```sh
# one-time
pnpm --filter web e2e:install

# start core in another shell (defaults to http://localhost:8080)
pnpm --filter @forge/core dev

# run the spec; webServer:true boots `next start` on the prebuilt app
pnpm --filter web build
pnpm --filter web e2e
```

## Environment

| Var | Default | Purpose |
|---|---|---|
| `E2E_WEB_URL` | `http://localhost:3000` | Playwright `baseURL` |
| `E2E_CORE_API_URL` | `http://localhost:8080/api` | REST fixture target (bypasses Next.js rewrite) |
| `E2E_CORE_PROXY_URL` | _unset_ in local dev | When set, `next.config.ts` rewrites `/api/*` and `/ws` to this host so browser requests stay same-origin |
| `E2E_SKIP_WEB_SERVER` | _unset_ | Set to `1` to suppress `webServer` bootstrap (useful when an external process manages `next start`) |

## CI

The `e2e-web` job in `.github/workflows/ci.yml` runs a Postgres service,
builds + starts core on `:8080`, builds web, and runs Playwright. The
Playwright browser binaries are cached between runs.

## Scope

Phase 2.6-F4 ships one happy-path spec: signup via API → sign in via UI →
navigate to issues. Full pipeline coverage (transition, job dispatch, event
stream, close) requires email-verification bypass + device-token seeding on
core, neither of which ship in this phase. The spec stops at the auth
boundary to avoid false positives.
