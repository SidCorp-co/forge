# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

## [0.1.0-rc.5] - 2026-04-25

### Added
- Branded 404 page (`forge/web/src/app/not-found.tsx`) with "Back to projects" CTA (ISS-243 #7)
- `NOTIFICATIONS_ENABLED` feature flag in `forge/web/src/features/notification/` to gate UI until backend ships (ISS-243 #1)

### Changed
- Web `IssueStatus` union + Kanban column constants synced to canonical `forge/core/src/db/schema.ts` 16-status enum: dropped `draft`/`clarified`, added `tested`/`pass` (ISS-242)
- Sidebar "+ New Project" CTA now opens the create-project modal at `/projects?new=1` (was dead-link to `/dashboard`) (ISS-243 #5)
- `/dashboard` wrapped in `<Shell>` for layout parity with other top-level routes (ISS-243 #3)
- New-issue form: empty submit now shows inline `Title is required.` error (was silent no-op) (ISS-243 #6)
- `/projects` empty/error: 401/403 surfaces sign-in CTA; other errors render `<AlertBanner>` instead of red text line (ISS-243 #4)
- `docs/architecture/system-overview.md` rate-limit blurb reconciled with `forge/core/src/config/rate-limits.ts` (5 / 15 min) (ISS-243 #8)

### Fixed
- `forge_auth` cookie now sets `Secure` in `staging` + `production` (was missing in `staging` because predicate compared `=== 'production'`) (ISS-240)
- Removed Strapi-flavoured `/api/notifications/unread-count` polling generating 404 every 30s (ISS-243 #1)
- Removed Strapi-flavoured `/api/user-preferences?filters[userKey][$eq]=...` calls; theme persists via next-themes localStorage only (ISS-243 #2)

### Validation
- ISS-238 `/ws` 404 confirmed false positive: after enabling Cloudflare Network → WebSockets, full handshake returns `101 Switching Protocols` with auth cookie (verified 2026-04-25)

## [0.1.0-rc.4] - 2026-04-25

### Added
- `GET /api/projects/:id/issues/by-display/:displayId` — resolve issues by `ISS-N` for shareable deep-links (ISS-241)
- Issue detail page accepts both `documentId` and `displayId` URLs; comments + activity section shells (ISS-241)
- `infra/nginx/stg-jarvis-a2.thejunix.com.conf` snapshot + `infra/nginx/README.md` 4-layer WS verification recipe (ISS-238)
- `docs/architecture/websocket.md` — Edge / reverse-proxy requirements section (CF zone-level WS toggle, HTTP/1.1 negotiation note)

### Fixed
- Issue list rows are now real `<Link>` anchors with displayId in href; right-click + open-in-new-tab work (ISS-241)
- Sidebar identity pill reads `user.email` (was hardcoded fallback `'Agent User'` because contract has no `username` field) (ISS-239)
- `/register` form: removed dead `username` input that was ignored by the API (ISS-239)
- nginx `/ws` location hardened with `X-Forwarded-*` + long timeouts + `proxy_buffering off` (ISS-238)

### Validation
- ISS-238 `/ws` 404 confirmed false positive at the routing layer: curl HTTP/2 returns 404, but RFC-compliant clients (browsers, `ws` npm) negotiate HTTP/1.1 and reach origin → 401. Acceptance still requires Cloudflare Network → WebSockets toggle to be enabled at zone level.

## [0.1.0-rc.3] - 2026-04-25

### Added
- `POST /api/auth/dev/force-verify` (dev/staging only, ADMIN_EMAILS-gated) — unblocks QA on no-SMTP deploys per ISS-235 item H
- `forge/web/src/app/projects/page.tsx` — projects list page accessible from post-login nav (ISS-235 item I)
- WebSocket upgrade auth: `forge_auth` cookie (user) or `Authorization: Bearer` (device); 401 on missing/invalid; room subscribe gated by principal (ISS-235 item B)
- pnpm overrides for React types — fixes web build with next-themes (ISS-235 item A)

### Fixed
- `NODE_ENV` enum accepts `staging` (was: development|test|production)
- Logger uses pino-pretty only in NODE_ENV=development; staging/prod emit JSON for parity + runtime image compat
- docker-compose.prod.yml NODE_ENV now overridable via .env

### Validation
- E2E test report: `docs/release-tests/v0.1.0-rc.2-staging.md` (ISS-236)
- Bug #1 from rc.2 report (`/ws` 404) confirmed false positive — WS works through CF + nginx

## [0.1.0-rc.2] - 2026-04-24

### Fixed
- `docker compose up` now works out of the box: `core` service receives full env via `env_file: .env`
- pg-boss v10: explicit `boss.createQueue()` before `work()`/`schedule()` (jobs dispatcher, jobs/devices stale detectors, JobEvent retention sweeper, webhooks outbound)
- Core Dockerfile runs migrations programmatically at startup (`dist/db/migrate.js`); no `drizzle-kit` needed in runtime image
- Web Dockerfile rewritten to use pnpm + workspace context (npm ci can't resolve `workspace:*` for `@forge/contracts`)
- SMTP env vars now optional: when `SMTP_HOST` is empty, email send is skipped (logged instead). Email verification still enforced server-side
- `APP_BASE_URL` and `CORS_ORIGINS` default to `http://localhost:3000` when unset
- Broken `[ROADMAP.md](ROADMAP.md)` link in `docs/architecture/system-overview.md` (resolved to `../ROADMAP.md`)
- Added `docs/rfcs/0001-device-runner-architecture.md` stub (canonical content remains in [ADR 0001](docs/decisions/0001-device-runner-architecture.md))
- Test mocks updated for pg-boss `createQueue` API
- `pipeline-e2e.test.ts` multi-line `typeof import(...)` syntax (TS 5.7 strict)

## [0.1.0-rc.1] - 2026-04-24

### Added
- `forge/core` control plane: Hono + Drizzle + pg-boss + `ws` + MCP server at `/mcp`
- Dual-principal auth (user JWT + device token) with shared policy layer
- 14-status issue pipeline with WebSocket room-scoped broadcasts
- Device pairing: Tauri `dev` GUI + `forged` CLI daemon, shared Rust `agent-core` crate
- Session replay with 30-day JobEvent retention after terminal state
- `pgvector` memory store with HNSW index on `vector_cosine_ops`
- Email verification gate at first-project creation
- Apache-2.0 license; initial public release scaffolding
- Four clients: Next.js web, Tauri desktop, React Native (Expo) mobile (paused), and `forge/core` API

### Changed
- Control plane rebuilt on Hono + Drizzle, replacing the former Strapi backend ([ADR 0002](docs/decisions/0002-replace-strapi-with-hono-drizzle.md), [ADR 0010](docs/decisions/0010-clean-break-from-strapi.md))
- Vector storage moved from Qdrant to Postgres `pgvector` ([ADR 0011](docs/decisions/0011-pgvector-replaces-qdrant.md))
- Postgres image upgraded to `pgvector/pgvector:pg17` in both dev and prod compose, and in the CI e2e-web service
- WebSocket broadcasts changed from global fan-out to room-scoped (`user:<id>`, `project:<id>`, `device:<id>`)
- All clients (web, dev, app) repointed from `http://localhost:1337` to `http://localhost:8080`
- `forge/app`: `strapiMediaUrl` helper renamed to `mediaUrl`

### Deprecated

### Removed
- `forge/strapi/` package (archived to `legacy/strapi-v0` tag)
- `qdrant` service from `docker-compose.yml` and `docker-compose.prod.yml`
- `crossProjectAccess` MCP flag — every MCP tool call now requires `projectId` and passes the policy check
- `forge/test-flow.sh` legacy integration script
- `forge/tests/strapi/` test suite
- Strapi-specific env vars: `APP_KEYS`, `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`, `TRANSFER_TOKEN_SALT`, `ENCRYPTION_KEY`, `STRAPI_URL`, `STRAPI_TOKEN`

### Fixed

### Security
- All five findings from the 2026-04-19 architecture audit closed by construction in `forge/core` (see [ADR 0001 §Context](docs/decisions/0001-device-runner-architecture.md) and the release-specific audit closure doc at `docs/security/audit-v0.1.0-rc.1.md`): row-level access checks via shared policy layer, room-scoped WebSocket broadcasts, `crossProjectAccess` flag removed, JWT TTL reduced to 7 days with `httpOnly` refresh-token rotation, Claude credentials never held on the server (device-runner split)

---

<!--
Release workflow:
1. Every meaningful PR adds a line to [Unreleased]
2. At release time: rename [Unreleased] to [x.y.z] - YYYY-MM-DD, create a new empty [Unreleased]
3. GitHub Release notes are copied from the version section
-->
