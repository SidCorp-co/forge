# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Style.** Every entry is read first by an end user, not a developer. Lead each bullet with a plain-language sentence describing what the user will see change; keep file paths, function names, and root-cause explanations on a separate italic `*Technical:*` sub-line. Full style guide: [`docs/guides/release.md` → Writing changelog entries](docs/guides/release.md#writing-changelog-entries--style-guide).

## [Unreleased]

### Added

### Changed

### Removed

### Fixed

### Security

## [0.1.34] - 2026-05-21

The pipeline now uses ~30–60% fewer tokens per issue thanks to smarter server-side prompt caching, and the cost dashboard finally shows real numbers (it used to display $0 on every step). MCP integrators: the `forge_pm.flag_blocker`, `forge_pm.escalate`, and `forge_tasks` tools were removed — see the migration table below.

### Added

- **AI agent gets full issue context upfront — no more "fetching" round-trip at the start of each step.** Title, status, priority, plan, and acceptance criteria are now included directly in the prompt sent to Claude. Each pipeline step starts ~200–500 ms faster and uses fewer tokens.
  *Technical: `buildJobPromptString` accepts an optional `issueSnapshot` with per-state field policy at `packages/core/src/jobs/prompt-string.ts`. Orchestrator loads it in parallel with `buildPreventiveContext` at both manual and auto enqueue sites.*

- **Resumed work (forge-fix, forge-review, repeat-coding) inherits decisions from the previous attempt.** The agent now sees a summary of what was decided, which files were touched, and what review feedback was raised — rather than re-discovering it via tool calls.
  *Technical: `## Previous Session Context` block renders when `issues.sessionContext.sessionCount >= 1`, gated by per-state field policy (review reads filesModified + decisions only; fix gets the full trail).*

- **Shared pipeline rules now ship as a single cacheable preamble.** Every step (triage, plan, code, review, …) used to repeat the same status / branch / output rules in its own skill file. Those rules now ship once at the top of each agent invocation, which lets Claude's prompt cache reuse them across consecutive steps in the same project — that's where the ~90% input-token saving on the system block comes from.
  *Technical: `buildPipelinePreamble(projectId)` in `packages/core/src/lib/chat-preamble.ts`; dispatcher forwards on `job.assigned` (both device + runner-adapter paths); desktop relays via `--append-system-prompt` in `claude_cli/agent.rs`.*

- **Storage groundwork for the upcoming Prompt Inspector + cost analytics surfaces.** New columns on `jobs` and a content-addressable `prompt_blobs` table can hold a snapshot of every prompt the server ever sent, deduplicated. The write path is wired in a follow-up release; this one just lands the schema so the migration runs once and stays stable.
  *Technical: migration `0068_job_prompt_snapshot.sql` adds `prompt_blobs (hash, content, ref_count)` + 6 columns on `jobs` (`system_prompt_hash` FK, `user_prompt_snapshot`, `prompt_input_token_est`, `model_used`, `prompt_blocks`, `archive_path`) + partial index `jobs_finished_archive_idx`.*

- **Internal helper for estimating prompt token counts.** Used by the upcoming budget-preview + block-contribution analytics views; no user-visible change yet.
  *Technical: `packages/core/src/lib/token-estimator.ts` — heuristic ~3.6 chars/token, FIFO LRU cache, zero deps.*

### Changed

- **PM escalation lives on `forge_pm.write_decision` now, not a separate tool.** If you call `write_decision` with an `escalate` block, the same call creates the `pm_escalation` notification — one API trip instead of two. Existing callers that don't pass `escalate` keep working unchanged.
  *Technical: `forge_pm.write_decision` accepts optional `escalate: { severity, summary, question, options, expiresAt }`. Response gains `escalation: { notificationId, expiresAt }` when the block was provided. Replaces `forge_pm.escalate`. ISS-146.*

- **Skill markdown files are leaner.** Status / branch / output / learning-capture rules are no longer repeated inside each `SKILL.md`; the shared preamble owns them. No behaviour change — the same rules still reach the agent every step.
  *Technical: 8 of 9 SKILL.md files trimmed (forge-triage left untouched as the canonical examplar). Total ~62 LOC removed (1446 → 1384). State-specific procedures preserved.*

### Fixed

- **The Insights → Cost dashboard now reports real spend per pipeline step.** Every triage / plan / code / review / test / release / fix row used to read $0 USD regardless of the worker's actual cost. The next pipeline run on a desktop carrying this build will populate real numbers within seconds.
  *Technical: `usage_records.session_id` was storing the local Tauri job id instead of the forge `agent_sessions.id`, so the `pipeline_run_step_durations` view JOIN never matched. The usage accumulator moved into `packages/dev/src/hooks/use-web-socket.ts` where the pipeline `agent:complete` handler already has the canonical `agentSessionId` from `job.assigned`; per-job usage is now deduped by `message.id` and POSTed once on completion with the forge UUID as `sessionId`.*

### Removed

- **MCP tools deprecated for some time are now gone: `forge_pm.flag_blocker`, `forge_pm.escalate`, `forge_tasks` (all CRUD).** Integrations that still call these will start getting "tool not found" errors — migrate to the replacements before updating. ISS-146.

  | Removed tool | Replacement call shape |
  |---|---|
  | `forge_pm.flag_blocker` | `forge_comments` `action='create'` (body `**PM blocker flagged** …`) + `forge_issues` `action='transition' data.status='on_hold'` |
  | `forge_pm.escalate` | `forge_pm.write_decision` with the new optional `escalate` block (`{ severity, summary, question, options, expiresAt }`) |
  | `forge_tasks` `create`/`list`/`update`/`delete` | `forge_issues` actions `createTask` / `listTasks` / `updateTask` / `deleteTask` (task data lives on `data.taskTitle` etc.; list requires `filters.issue`) |

  *Technical: MCP audit rows previously tagged `tool='forge_tasks'` now log `tool='forge_issues'` with the corresponding action — adjust downstream dashboards accordingly.*

- **Dead code cleanup in the desktop runner.** A stale internal hook (never wired into the running app since the dev/prod chat split) was removed; no user-facing behaviour change beyond a faster cold start.
  *Technical: `packages/dev/src/hooks/use-agent-stream.ts` deleted (-226 LOC). It used to be the (broken) usage-record POST source; see the Fixed section above for the replacement. Zustand state fields (`agentMessages`, `setAgentRunning`, …) stay in the store — still used by `useAgentChat` / `useAgentChatHandlers`.*

## [0.1.31] - 2026-05-06

Persistent Forge MCP config sent the wrong credential — fixed.

### Fixed

- **Forge MCP `/mcp` always 401'd from Claude CLI, then OAuth fallback 404'd** (desktop). The persistent MCP config written into `<repo>/.mcp.json` by Project Settings → Save / MCP page → Install had `X-Forge-API-Key` as the auth header. But `packages/core` migrated `/mcp` to device authentication in ISS-202 — the only accepted credential is `Authorization: Bearer <device-token>`. With the wrong header the request 401'd; Claude CLI's MCP SDK then auto-attempted OAuth dynamic-client registration (`POST /register`) which the backend doesn't implement, surfacing as `HTTP 404: Invalid OAuth error response: ZodError` with raw body `{"code":"NOT_FOUND","message":"Not Found: POST /register"}`. The ephemeral MCP config emitted by the Tauri runtime in `claude_cli/mcp.rs` already used the Bearer header — only the persistent path was stale. Fix: `useProjectSettings.ts:ensureForgeMcp`, `mcp-server-list.tsx`, and `McpPage.tsx` now load the device token from the OS keychain via `load_device_token` IPC and write `Authorization: Bearer <token>` instead of `X-Forge-API-Key`. The project apiKey path is dropped from the desktop MCP install entirely (it remains valid for the web widget, which is unrelated).

## [0.1.30] - 2026-05-06

## [0.1.30] - 2026-05-06

Desktop fixes for fresh installs on macOS Apple Silicon.

### Fixed

- **`Failed to spawn claude: No such file or directory (os error 2)` on macOS** (desktop). GUI launches inherit a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) that misses Homebrew (`/opt/homebrew/bin`), nvm, npm-global, and `~/.local/bin`, so `Command::new("claude")` returned ENOENT even with the CLI installed. Fix at process startup: probe the user's login shell once with `$SHELL -lc 'echo $PATH'`, sentinel-parse, and `setenv("PATH", …)` for the whole process. All subsequent spawns (claude, git, gh) resolve against the user's real PATH. Same approach VS Code / Atom / GitHub Desktop / JetBrains use.
- **`Sync to server Error: API error: 404` from Project Settings save** (desktop). The desktop was calling three Strapi-era endpoints — `POST /api/devices/register`, `PUT /api/devices/project-path`, `PUT /api/devices/projects-root` — that were never ported to `packages/core`. The backend has no schema for per-device project paths and the dispatcher reads project-level `projects.repoPath` instead, so the round-trip was dead weight. Removed the three frontend callers; per-device paths still persist locally in `~/.config/forge-beta/config.json` and survive restarts.

### Removed

- `registerDesktop` / `unregisterDesktop` / `registerDevice` / `setDeviceProjectPath` / `setDeviceProjectsRoot` from `packages/dev` — all five were no-ops or 404s on `packages/core`. Logout no longer takes an `unregisterDesktop` flag.

## [0.1.29] - 2026-05-05

Pipeline session fix: long-running jobs (plan/code/fix/review) no longer get killed by the queue_timeout sweeper, and a completed pipeline session opened in the browser shows the assistant reply + claudeSessionId instead of an empty placeholder.

### Fixed

- **Pipeline jobs killed by `queue_timeout` sweeper after ~5min** (server, ISS-36 / PR #85). Every plan/code/fix/review session was being marked `failed` with `failureReason='queue_timeout'` ~5 minutes after dispatch. Root cause: the desktop runner uses `jobId` as its local session key, so its `PATCH /api/agent-sessions/:id` and relay calls 404'd against the actual `agent_sessions` row UUID. Pre-#83 the session was inserted at `status='running'` so the queue_timeout sweeper didn't match; #83 changed insert to `'queued'` and the sweeper started killing every long-running session before completion. Fix: when a device POSTs `/api/jobs/:id/events`, the server now also CASes the linked `agent_sessions` row `queued → running` (stamps `startedAt`) and bumps `lastHeartbeatAt`. Best-effort, doesn't break event ingest. No desktop change required for this part.
- **Completed pipeline sessions show empty messages in the browser** (server + desktop, ISS-37 / PR #86). The session row's `messages`, `claudeSessionId`, and `diff` stayed empty after the job finished — only the row's status got updated via `syncAgentSessionLifecycle`. Fix: server threads the linked `agentSessionId` through the claude-code adapter into the WS `job.assigned` payload; desktop tracks the `jobId → agentSessionId` mapping and calls `patchAgentSession(agentSessionId, { status, messages, claudeSessionId })` on `agent:complete` so the canonical session row is persisted with the final state. Backward-compatible: older server builds that don't emit the field cause the desktop to silently skip the PATCH (status sync via `completeJob` still applies).

## [0.1.28] - 2026-05-01

Pipeline robustness: skill content reaches workers reliably (legacy seeds + 0-byte recovery), and Rust-created worktrees carry skills.

### Fixed

- **`/forge-*` slash commands silently broken after a stale install.** Pre-guard builds (before the empty-body guard in `install_skill_from_strapi`) wrote 0-byte `~/.config/forge-beta/skills/<name>/SKILL.md` files when the server returned an empty `skillMd`. Subsequent syncs short-circuited on hash equality and never re-fetched, leaving the local files broken until a manual reinstall. The desktop now also verifies the on-disk body is non-zero before honoring the hash match — empty files trigger a fresh install on the next sync, and the install path's existing guard rejects subsequent empty payloads. Older builds without the new `library_skill_body_ok` command fall back to the original behavior.
- **Empty `skillMd` returned by `/projects/:id/skills/effective` for legacy skills.** Skills seeded before v0.1 only have the `prompt` column populated; `skillMd` is NULL. The endpoint now falls back to `prompt` when `skillMd` is empty and recomputes `contentHash` from the effective body so cached legacy hashes don't pin the desktop on a 0-byte install.

### Added

- **Skills auto-copy into Rust-created worktrees.** `.claude/skills/` is gitignored in most forge projects, so `git worktree add` would otherwise drop a fresh worktree without any `SKILL.md`. The desktop now copies `<repo>/.claude/skills/` into the new worktree right after `git worktree add` succeeds (manual chat sessions that opt into worktree mode). Pipeline-driven sessions still run in the main checkout — the agent owns worktree creation through SKILL.md instructions.

## [0.1.22] - 2026-04-29

Patch: self-heal stale `config.coreUrl` for users who logged in before v0.1.21 on subdomain-split deploys.

### Fixed

- **"Sync to server" 404 after login.** Users who logged in on <= v0.1.20 stored the WEB URL in `config.coreUrl`. On subdomain-split deploys every subsequent `/api/*` call hit the web origin and 404'd (project save, agent run, etc. all silently failed). The desktop now resolves `config.coreUrl` via `/.well-known/forge-config.json` on every launch and persists the corrected value — single-origin deploys are unaffected, subdomain-split stale configs heal silently on first launch of v0.1.22.
- **CORS for Tauri webview** (server-side, ships with the next core deploy). The API now allows `tauri://localhost` (macOS/Linux) and `https://tauri.localhost` (Windows) unconditionally so desktop fetches with credentials succeed.

## [0.1.21] - 2026-04-29

Patch release: fixes the desktop "Server URL" field showing `http://localhost:8080` instead of the saved server URL.

### Fixed

- **Server URL field stuck on localhost.** A `useState` initializer captured the empty initial Zustand state before `useLocalConfig()` finished reading `~/.config/forge-beta/config.json`. The field now syncs once when the disk config arrives (guarded so it doesn't clobber any URL the user is already typing). Workaround on v0.1.20 was to retype the URL into the field manually.

## [0.1.20] - 2026-04-29

Patch release: server URL discovery so the desktop app's "Server URL" field accepts the same web URL the user uses in their browser, even on subdomain-split deploys (web + API on different hosts).

### Added

- **Server discovery via `/.well-known/forge-config.json`.** The Tauri client now probes this endpoint on the user-typed URL to learn where the API actually lives, following Matrix's [Client-Server discovery pattern](https://spec.matrix.org/latest/client-server-api/) (RFC 8615). Web app exposes the endpoint with `{ apiUrl, wsUrl?, version }`. Single-origin deploys keep working with zero configuration — discovery returns the same origin. Subdomain-split deploys (web at `forge-beta.sidcorp.co`, API at `forge-beta-api.sidcorp.co`) are now seamless: user types the web URL they see in their browser, app silently routes API calls to the right host.
- **"Server URL" field helper** on the desktop login form: "The same URL you use to open Forge in your browser." Removes the previous footgun where a user typing the web URL on a subdomain-split deploy would see the social-login section silently disappear because `/api/*` 404'd on the web origin.

### Fixed

- **Sign-in-with-GitHub button missing on subdomain-split deploys.** Root cause was the same as the bug fixed by the discovery endpoint above — the desktop app blindly appended `/api/*` to the user-typed URL, which only worked on single-origin deploys.

## [0.1.19] - 2026-04-29

Feature release: Sign in with GitHub / Google / OIDC on the desktop app, plus email-verification UX polish.

### Added

- **Desktop OAuth (ADR 0017).** New "Continue with GitHub" / Google / OIDC buttons on the Tauri login page. Click opens the system browser to the existing web OAuth flow; after the user authenticates, the browser deep-links back into the app via the new `forge-beta://` URL scheme and the desktop trades a one-time code for a JWT. The flow uses RFC 8252 (OAuth 2.0 for Native Apps) + RFC 7636 (PKCE) — the JWT never appears in any URL, never persists to disk, never embeds in the binary, and a malicious app intercepting the deep-link gets only a useless one-time code. Provider list is fetched dynamically from `/api/auth/oauth/providers`, so adding Google later is purely a backend config change. Gated behind `FEATURE_DESKTOP_OAUTH` on the core service.
- **`forge-beta://` URL scheme registration.** First launch of v0.1.19 (or first install on a fresh machine) registers the URL scheme with the OS — Info.plist on macOS, NSIS hook on Windows, `.desktop` file + runtime fallback on Linux. The OS may prompt for permission the first time the deep-link is invoked.
- **Single-instance plugin.** A click on `forge-beta://...` while the app is already running now wakes the existing window instead of spawning a new process — required for the OAuth handoff to land in the user's authenticated context.

### Fixed

- **Email verification link UX.** Clicking the verification link in the registration email now lands on the web `/login?verified=1` page with a green "Email verified" banner instead of raw JSON. Stale or expired links land on `/login?verify_error=…` with a friendly warning. Also fixes a bug where, on subdomain-split deploys (web + API on different subdomains), the verification link was generated against `APP_BASE_URL` (the web origin) and 404'd because `/api/auth/verify` only exists on the API origin — the link is now built against `OAUTH_REDIRECT_BASE` (the API origin) when set.

## [0.1.18] - 2026-04-28

Patch release: macOS auto-updater payload + Next.js DoS hardening.

### Fixed

- **macOS auto-updater entries.** `bundle.targets` was missing the `app` entry, so Tauri built `Forge Beta.app`, wrapped it in the `.dmg`, then deleted the `.app` directory before the updater could tarball it. Result: `latest.json` shipped with `linux-*` and `windows-*` keys but no `darwin-aarch64` / `darwin-x86_64`, which silently disabled in-place updates for macOS users. Adding `"app"` produces both `Forge Beta.app.tar.gz` and `Forge Beta.app.tar.gz.sig`, which tauri-action then attaches to the release and references from `latest.json`.

### Security

- **Next.js 16.1.7 → 16.2.4.** Closes [GHSA-q4gf-8mx6-v5v3](https://github.com/advisories/GHSA-q4gf-8mx6-v5v3) (DoS via Server Components, high). The advisory has separate fix lines per minor: 15.5.15 for `15.x` and 16.2.3 for `16.x`. The earlier 16.1.7 bump only crossed the 15.x boundary in the metadata; 16.x callers stayed below the patch. Open Dependabot alert count: 4 → 3 (remaining are transitive Rust deps `rand` and `glib` whose fix lines are above what Tauri's gtk-rs chain currently exposes).

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
