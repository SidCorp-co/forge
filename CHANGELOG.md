# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Removed

### Fixed

### Security

## [0.1.17] - 2026-04-28

Rebrand to `Forge` under the `SidCorp-co` org **and** the first release to actually attach desktop installers to the GitHub Release. Every prior tag from `v0.1.9` onward built only the raw `forge-beta` binary because `bundle.active` was missing from `tauri.conf.json`; this release restores the bundler pipeline end-to-end. See [ADR 0015](docs/decisions/0015-rebrand-to-forge.md) for the rebrand rationale.

### Changed

- **Repo URL:** `https://github.com/SidCorp-co/forge` (old URL auto-redirects).
- **Workspace layout:** `forge/<pkg>/` → `packages/<pkg>/` for `core`, `web`, `dev`, `app`, `contracts`, `tests`, `widget`. npm scope `@forge/*` is unchanged.
- **Tauri identifier:** `co.sidcorp.forge-beta`. The auto-updater endpoint in `tauri.conf.json` now points at the new repo.
- **Tauri config:** `bundle.targets` set explicitly to `["deb", "appimage", "dmg", "nsis"]`; RPM intentionally dropped because the GitHub-hosted Linux runner has no `rpmbuild`. `$schema` switched to the canonical `https://schema.tauri.app/config/2`. `bundle.publisher`, `category`, `shortDescription`, `copyright` populated for installer metadata.
- **Icons:** regenerated the icon set with `pnpm tauri icon`. macOS DMG now has the required `.icns`; Linux desktop entries get the proper 32/128/128@2x PNGs.
- **CI:** workflow declares `permissions: contents:read, pull-requests:read` so Dependabot PRs no longer fail at the changes job. New `dev-bundle-smoke` job runs `pnpm tauri build --bundles deb` (with a throwaway updater key) on PRs that touch `packages/dev/src-tauri/**` or `release.yml`, so a future `bundle.active=false` regression fails in CI rather than at tag time.
- **Docs:** trimmed `architecture/websocket.md` (678 → 167 lines), `modules/issues-pipeline/status-pipeline.md` (367 → 177 lines); maintainer-only artifacts (release tests, migration audits, ops runbooks) moved to gitignored `.internal-docs/`.
- **Dependabot:** `npm` ecosystem now scans only the active workspace members (`packages/app/` excluded per [ADR 0009](docs/decisions/0009-mobile-app-paused-for-v0x.md)); `cargo` ecosystem added for `packages/dev/src-tauri/`.
- Internal hostnames + emails scrubbed from tracked sources (test fixtures, code comments, deployment defaults).

### Fixed

- **Bundler pipeline.** `tauri.conf.json` was missing `bundle.active`. Tauri 2 defaults that field to `false`, so `tauri build` produced only the raw `forge-beta` executable and skipped every installer. tauri-action then aborted with `No artifacts were found.` This was a silent regression: every release `v0.1.9..v0.1.16` shipped with empty installer attachments and the source-code zip only.
- **macOS codesign on unsigned builds.** The release workflow forwarded `APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}` even when the secret was unset; GitHub Actions interpolates that as the empty string, and Tauri's macOS bundler treats present-but-empty as "import this cert" and aborts with `failed to run command security import`. Same shape on Windows. The `APPLE_*` and `WINDOWS_*` env entries are now omitted entirely until real certificates exist; until then bundles ship unsigned.
- **release.yml runner detection.** Pinned `tauriScript: pnpm tauri` so tauri-action stops falling back to `npm run tauri` when `projectPath` (`packages/dev/`) has no `pnpm-lock.yaml` of its own.
- **pre-push guard.** Hook now fails the push if `bundle.active` ever drifts back to `false`, so the bundler regression cannot recur.
- **pre-push path.** Earlier hook used `$repo_root/forge/$pkg` as the package path — the variable substitution slipped past the workspace rename and the gate was effectively a no-op for any push touching the renamed packages until corrected.

### Security

- 6 cargo bumps merged through Dependabot (rustls-webpki, openssl chain via the minor-and-patch group, sha2, nix, tar, plus the Tauri 2.10.3 group). Open Dependabot security alert count: 44 → 33.

> ⚠️ **Breaking for installed alpha users:** the Tauri bundle identifier changed (`com.thejunix.forge-beta` → `co.sidcorp.forge-beta`), so the OS treats v0.1.17 as a different application from any earlier install. Reinstall is required; OS keychain entries are not inherited. In practice no installer was actually published for any tag prior to v0.1.17, so the population this affects is "people who built locally and ran it."

## [0.1.16] - 2026-04-28

OSS launch prep. Tags `v0.1.6` through `v0.1.15` were created during pipeline debugging and never produced a non-draft release. (At the time this entry was written we believed `v0.1.16` was the first version producing installable artifacts; that turned out to be wrong — the bundler was silently disabled until `v0.1.17`. See the v0.1.17 "Fixed" notes.) Desktop binary version realigned from the legacy `0.2.x` `forge-beta` train back to the repo's `0.1.x` line so tag, package, and Cargo versions match.

### Added

- Release pipeline now produces signed (where secrets are configured) macOS, Windows, and Linux artifacts on every `v*.*.*` tag.
- Per-package READMEs for `packages/dev`, `packages/contracts`, and `packages/app` (with paused-per-ADR-0009 banner).
- Conditional Apple Developer ID + Windows code-signing env in `.github/workflows/release.yml`. Builds remain unsigned (and installable with one-time OS warnings) until the optional `APPLE_*` / `WINDOWS_*` secrets are set; see [`docs/guides/release.md`](docs/guides/release.md) for the playbook.
- `NEXT_PUBLIC_APP_URL` in `packages/web` drives canonical / OpenGraph URLs on `/download` instead of a hardcoded staging origin.
- `packages/core` `dev` and `start` scripts auto-load `.env` via `--env-file-if-exists`.
- OAuth/OIDC keys (`GITHUB_OAUTH_*`, `GOOGLE_OAUTH_*`, `OIDC_*`) documented in `packages/core/.env.example`.
- `Apache-2.0` license declared explicitly on every workspace package.

### Changed

- Desktop binary version realigned: `packages/dev/package.json`, `tauri.conf.json`, and `Cargo.toml` all on `0.1.16` (was `0.2.27` / `0.2.27` / `0.2.4` — three-way drift).
- `packages/web` README rewritten from the default `create-next-app` boilerplate to a Jarvis-specific guide.
- `packages/dev/CLAUDE.md` updated to past-tense Strapi removal and "Forge core API client" naming.
- `/download` Quickstart Step 2 now walks through self-hosting (`docker compose up`) instead of pointing at an internal staging instance.

### Fixed

- `release.yml` failed every build at `pnpm/action-setup` because pnpm version was specified twice (`version: 9` + `packageManager` in `package.json`). Removed the explicit version.
- `release.yml` `cache-dependency-path` pointed at non-existent `packages/dev/pnpm-lock.yaml` — fixed to root `pnpm-lock.yaml`.
- `release.yml` ran `pnpm install` in `packages/dev` (workspace member, no own lockfile) — moved to repo root.

### Security

- Real-looking GitHub OAuth credentials removed from on-disk `packages/core/.env` (file deleted; gitignored, never in git history). Rotate the OAuth App secret at github.com/settings/developers as a precaution.

## [0.1.5-beta] - 2026-04-27

First end-to-end autonomous pipeline run on packages/core staging. Beta build
ships side-by-side with the legacy `forge-dev` binary so PMs can dogfood
without losing the production fallback.

### Added

- `forge_issues` + `forge_comments` MCP tools (ISS-293 chunk A) — port the
  legacy Strapi MCP shape; existing `/forge-*` skills work unchanged.
- `forge_config` + `forge_tasks` MCP tools (ISS-293 chunk B) — completes the
  toolset that `forge-plan`/`forge-code`/`forge-review`/`forge-fix` need.
- packages/dev `job.assigned` WebSocket handler (ISS-279) — receives dispatcher
  events, resolves project, spawns Claude CLI with `/forge-<type>` prompts,
  and posts events back to `/api/jobs/:id/events`.
- Stuck-dispatched watchdog (ISS-281) — cron every minute marks jobs that
  never reported `started_at` within 5 min as failed and schedules retry up
  to `maxAttempts`.
- JWT auto-refresh on 401 (ISS-280) — packages/dev API client clears the
  in-memory token and bounces to `/login` on `INVALID_TOKEN`/`UNAUTHENTICATED`.
- Pair flow auto-creates a `claude-code` runner row bound to the new device
  (post-ISS-271 dispatcher needs this to select the device for jobs).
- Inline "Pair Device" card in forge/beta Settings — temporary UX while the
  web pair-code page (ISS-211) remains backlog.
- Issue extension columns `plan` / `acceptance_criteria` / `suggested_solution`
  / `session_context` (migration 0032) — fields the autonomous pipeline
  persists across plan → code → review.

### Changed

- packages/dev binary renamed `forge-dev` → `forge-beta`. New install path,
  config dir (`~/.config/forge-beta/`), keychain service, Vite port 1421.
  Allows coexistence with the stable build during the v0.1 dogfood window.
- Tauri MCP config now sends `Authorization: Bearer <device-token>` instead
  of the legacy `X-Forge-API-Key` header — matches packages/core's
  `requireDevice()` middleware.
- Dispatcher `job.assigned` event includes top-level `issueId` (was only
  inside `payload`, but skill prompt builders need it directly).
- Device heartbeat now also refreshes any runner rows bound to the device,
  so the post-ISS-271 dispatcher does not flip them offline while the JS
  Tauri client does not yet drive `runner:register` over the Rust WS path.

### Fixed

- Skill installer wiped existing `SKILL.md` when the server returned an empty
  body (ISS-292 follow-up). Both layers (TS skill-sync + Rust install
  command) now refuse empty input — defence in depth so a malformed
  `/skills/effective` payload cannot silently break every `/forge-*` command.
- `/api/jobs/:id/events` 500 from `FOR UPDATE` on aggregate. Use
  `pg_advisory_xact_lock(hashtext(jobId))` to serialize concurrent inserts.
- `/api/jobs/:id/events` returning 401 INVALID_TOKEN despite a valid device
  token — per-handler auth scoping (was greedy `.use('*')` on a sibling router
  intercepting POSTs aimed at `requireDevice()`).

### Security

- WebSocket auth on packages/core accepts a device principal via
  `Authorization: Bearer` (Tauri Rust path) or `?token=` URL query (browser
  fallback). The query-token surface is a short-term workaround tracked under
  ISS-286 — migration to `Sec-WebSocket-Protocol` planned for v0.1.6.

## [0.1.1] - 2026-04-26

Patch release that ships the long-deferred landing-page GSAP fix from ISS-269.

### Removed
- `gsap` dep + `packages/web/src/lib/gsap-client.ts` + `packages/tests/web/lib/gsap-client.test.ts` — replaced animation usage with framer-motion (already a dep)

### Fixed
- Landing page `_gsap` undefined TypeError eliminated (ISS-269) — 3 prior fix attempts (rc.7 / rc.8 / rc.9) couldn't unblock Next.js 16 chunk-init race; swapping the 4 landing impl files to framer-motion's `whileInView` + `viewport={{once:true}}` pattern removes the class of bug entirely. -319 lines net.

## [0.1.0] - 2026-04-26

First v0.1 stable cut covering Phase 3.1 → 3.5 of the Strapi → `packages/core`
control-plane migration: UI batch + cleanup, Tier A LIVE features, Tier B1
medium ports, Tier B2 heavy/realtime ports, and Phase 3.5 FE wireup that
connects 13 placeholder/missing surfaces to the ported endpoints. `forge/strapi`
removal landed earlier in 0.1.0-rc.x; this release brings parity for the routes
the web + dev clients call and ships a fully functional UI on top of them.

E2E walkthroughs across cycles 1–5 (`docs/release-tests/v0.1.0-stable-ui-ux.md`)
verified the 19 ported product surfaces. Landing-page GSAP animation issue
(ISS-269) deferred to v0.1.x as cosmetic-only.

### Added
- Issue detail page: status transition dropdown + comment editor + live comments list backed by `GET/POST /api/issues/:id/comments` (ISS-247)
- Issues list: search box + status / priority filters with URL + project-scoped localStorage persistence; `<Suspense>` boundary added (ISS-248)
- Markdown rendering for issue description via shared `<Markdown>` component (ISS-249)
- `displayId` (`ISS-N`) badge on kanban cards (ISS-251)
- Static built-in domain template catalog at `@forge/contracts/domain-templates` (replaces Strapi `/domain-templates` fetch — see Removed)
- WS infrastructure: `userRoom(userId)` helper + `canSubscribe` gate for `user:` rooms, with prefix-isolation tests (ISS-258)
- `/api/notifications` full surface: list (paged, project filter, unread-only), `unread-count`, `mark-all-read`, `PATCH :id`, `DELETE :id`, server-side `createNotification()` helper, `notificationCreated` + `notificationRead` hooks bridging to `userRoom` (ISS-258)
- `packages/web` + `packages/dev` notification stubs re-enabled against the live `/api/notifications` endpoint; bell components updated to flat shape (`n.id`) (ISS-258)
- `/api/agents` CRUD: project-scoped list with `type`/`enabled` filters + `X-Total-Count`, create/get/patch, owner|admin-gated delete. Folds the legacy `agent-definition` template into the agent row (no template inheritance). Migration `0021_agents` (ISS-258)
- `/api/chat-sessions` CRUD with strict user-ownership gate + `POST /:id/message` (folds legacy top-level `POST /chat`): persists user message, broadcasts `chat.message` on `user:<id>`. **Streaming LLM reply deferred to a follow-up** (provider call + tool execution + streamed assistant reply requires the chat-prompt-builder + agent-runner services not yet in `packages/core`). Migration `0022_chat_sessions` (ISS-258)
- `/api/agent-sessions` full surface: CRUD (list takes `projectId` or `deviceId` scope), `POST /desktop/status`, `POST /:id/relay`, `GET/POST /:id/pipeline-control`, `GET/POST /:id/pipeline-telemetry`. WS broadcasts to both `device:<id>` and `project:<id>` rooms on create / status change / relay / control / telemetry. Migration `0023_agent_sessions` (ISS-258)
- `GET /api/issues/:id/cost-summary` (mounted on `issueExtrasRoutes`): joins `usage_records.session_id ↔ jobs.id` for an issue and returns rolled-up estimated cost + token totals + sample count (ISS-258 bonus)

### Changed
- Pipeline `STEP_LABELS` reflect the post-`clarified` flow: dropped `confirmed→clarified` + `clarified→waiting`, added `testing→tested`, `tested→pass`, `pass→staging` (ISS-244 #2)
- Project settings `STEPS` array drops the dead `autoClarify` step; `autoPlan` / `autoTest` status hints updated to match (ISS-244 #3)
- Kanban `pass` chip color: `bg-emerald-500/20 text-emerald-300` → `bg-green-500/30 text-green-200 font-medium` so it is distinguishable from `tested` (ISS-244 #4)
- Closed kanban column visible by default (`DEFAULT_VISIBLE.closed = true`) so closed issues stop disappearing (ISS-246)
- Login form validates with zod messages instead of HTML5 `required` (ISS-252)
- Register submit button: `bg-on-primary text-white` → `bg-primary text-on-primary` (fixes white-on-white contrast) (ISS-250)
- `notificationApi.getAll` / `unreadCount` (packages/web) drop the dead `?projectSlug` query param: the core schema only accepts `projectId: z.uuid()`, so the param was being silently dropped server-side. Per-project scoping now requires resolving slug → projectId client-side (TODO inline) (ISS-258)

### Removed
- Wired-but-dead pages `/antigravity` and `/cloudflare` (UnimplementedBanner stubs) + matching CEO sidebar links (ISS-255 §B / audit Table B)
- `packages/web` Strapi-flavoured `/domain-templates` fetch in chat-agent settings; replaced by `@forge/contracts` static catalog
- All callers of schema-only Strapi entities verified absent in `packages/web` + `packages/dev`: `agent-definition`, `app-config`, `audit-log`, `claude`, `claude-proxy`, `eval-run`, `heartbeat` (the Strapi entity — distinct from the project-config heartbeat field), `retrieval-analytic`, `skill-eval`, `token`, `user-preference` (audit Table C, ISS-255 §B)

### Fixed
- `/notifications/*` API client (web + dev) short-circuits to empty/no-op responses while the endpoint is unported in `packages/core`; eliminates 1–4 console errors per page navigation (ISS-253)

### Deferred to v0.1.x (tracked in ISS-259)
- Chat: streaming LLM reply on `POST /chat-sessions/:id/message` (needs chat-prompt-builder + agent-runner services ported to core)
- Agent-session: pg-boss-backed pipeline-control queue worker (current jsonb storage + WS broadcast is the wire-compatible interim; queue dispatch can be added additively without changing the request shape)
- Agent-session interactive UI (start/send/abort) — Tier B2 phase 4 ported the read-only viewer + WS broadcasts; interactive endpoints await core dispatch surface
- `notifications.agent_session_id` FK constraint to `agent_sessions(id)` with `ON DELETE SET NULL` — additive migration when the next schema change lands
- `UnimplementedBanner` audit pass on `packages/web/src/` (≈25 inline banners remain post-Phase-3.5)
- Per-project notification scoping (FE slug → projectId resolution to drive `?projectId=` filter)
- mark-all-read bulk WS emit (Lapras review minor #1 — currently single update bypasses per-row WS broadcast)
- ~~Landing GSAP `_gsap` TypeError (ISS-269)~~ — **shipped in v0.1.1**, see below.

### Security

## [0.1.0-rc.5] - 2026-04-25

### Added
- Branded 404 page (`packages/web/src/app/not-found.tsx`) with "Back to projects" CTA (ISS-243 #7)
- `NOTIFICATIONS_ENABLED` feature flag in `packages/web/src/features/notification/` to gate UI until backend ships (ISS-243 #1)

### Changed
- Web `IssueStatus` union + Kanban column constants synced to canonical `packages/core/src/db/schema.ts` 16-status enum: dropped `draft`/`clarified`, added `tested`/`pass` (ISS-242)
- Sidebar "+ New Project" CTA now opens the create-project modal at `/projects?new=1` (was dead-link to `/dashboard`) (ISS-243 #5)
- `/dashboard` wrapped in `<Shell>` for layout parity with other top-level routes (ISS-243 #3)
- New-issue form: empty submit now shows inline `Title is required.` error (was silent no-op) (ISS-243 #6)
- `/projects` empty/error: 401/403 surfaces sign-in CTA; other errors render `<AlertBanner>` instead of red text line (ISS-243 #4)
- `docs/architecture/system-overview.md` rate-limit blurb reconciled with `packages/core/src/config/rate-limits.ts` (5 / 15 min) (ISS-243 #8)

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
- `packages/web/src/app/projects/page.tsx` — projects list page accessible from post-login nav (ISS-235 item I)
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
- `packages/core` control plane: Hono + Drizzle + pg-boss + `ws` + MCP server at `/mcp`
- Dual-principal auth (user JWT + device token) with shared policy layer
- 14-status issue pipeline with WebSocket room-scoped broadcasts
- Device pairing: Tauri `dev` GUI + `forged` CLI daemon, shared Rust `agent-core` crate
- Session replay with 30-day JobEvent retention after terminal state
- `pgvector` memory store with HNSW index on `vector_cosine_ops`
- Email verification gate at first-project creation
- Apache-2.0 license; initial public release scaffolding
- Four clients: Next.js web, Tauri desktop, React Native (Expo) mobile (paused), and `packages/core` API

### Changed
- Control plane rebuilt on Hono + Drizzle, replacing the former Strapi backend ([ADR 0002](docs/decisions/0002-replace-strapi-with-hono-drizzle.md), [ADR 0010](docs/decisions/0010-clean-break-from-strapi.md))
- Vector storage moved from Qdrant to Postgres `pgvector` ([ADR 0011](docs/decisions/0011-pgvector-replaces-qdrant.md))
- Postgres image upgraded to `pgvector/pgvector:pg17` in both dev and prod compose, and in the CI e2e-web service
- WebSocket broadcasts changed from global fan-out to room-scoped (`user:<id>`, `project:<id>`, `device:<id>`)
- All clients (web, dev, app) repointed from `http://localhost:1337` to `http://localhost:8080`
- `packages/app`: `strapiMediaUrl` helper renamed to `mediaUrl`

### Deprecated

### Removed
- `forge/strapi/` package (archived to `legacy/strapi-v0` tag)
- `qdrant` service from `docker-compose.yml` and `docker-compose.prod.yml`
- `crossProjectAccess` MCP flag — every MCP tool call now requires `projectId` and passes the policy check
- `forge/test-flow.sh` legacy integration script
- `packages/tests/strapi/` test suite
- Strapi-specific env vars: `APP_KEYS`, `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`, `TRANSFER_TOKEN_SALT`, `ENCRYPTION_KEY`, `STRAPI_URL`, `STRAPI_TOKEN`

### Fixed

### Security
- All five findings from the 2026-04-19 architecture audit closed by construction in `packages/core` (see [ADR 0001 §Context](docs/decisions/0001-device-runner-architecture.md) and the release-specific audit closure doc at `docs/security/audit-v0.1.0-rc.1.md`): row-level access checks via shared policy layer, room-scoped WebSocket broadcasts, `crossProjectAccess` flag removed, JWT TTL reduced to 7 days with `httpOnly` refresh-token rotation, Claude credentials never held on the server (device-runner split)

---

<!--
Release workflow:
1. Every meaningful PR adds a line to [Unreleased]
2. At release time: rename [Unreleased] to [x.y.z] - YYYY-MM-DD, create a new empty [Unreleased]
3. GitHub Release notes are copied from the version section
-->
