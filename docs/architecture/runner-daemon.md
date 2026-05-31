# Runner daemon (`forge-runner`)

Pure-Rust CLI daemon — the headless runtime-plane form factor (same protocol as the `dev` Tauri GUI, no webview): pairs as a device, takes job dispatches over WS, runs each with the Claude Code CLI in a git checkout, streams results back.

- Source: [`packages/runner/`](../../packages/runner/).
- Shipped from the former `forge-runner-cli` proposal (now retired).

## Role

```
core (Hono)  ──WS /ws (Bearer device token)──▶  forge-runner (this daemon)
             ◀─REST /api/jobs/:id/{events,complete,fail}─┤
                                                          ├─ spawns `claude` CLI
                                                          │  in a git worktree
                                                          └─ Claude credentials
                                                             stay in the local
                                                             keychain, never on core
```

- `core` never holds Claude credentials, never runs agents — it assigns jobs to a device's WS room; the daemon executes locally and reports events/lifecycle over REST.
- One daemon = one machine, serving every project assigned to it.

## Crate layout

Two-crate Cargo workspace ([`packages/runner/Cargo.toml`](../../packages/runner/Cargo.toml)), version-locked to the monorepo (one version across web/core/dev/runner, bumped by `forge-cut-release`). Release profile tuned small (`opt-level="z"`, `lto`, `strip`, `panic="abort"`) → ≈ 3.7 MB binary.

- **`forge-runner-core`** ([`crates/forge-runner-core/`](../../packages/runner/crates/forge-runner-core/)) — entire library, zero CLI/GUI coupling (a thin GUI/tray could later drive it over a local socket). Modules ([`src/lib.rs`](../../packages/runner/crates/forge-runner-core/src/lib.rs)):
  - `auth/` — credential store + pairing ([`cred_store.rs`](../../packages/runner/crates/forge-runner-core/src/auth/cred_store.rs), [`pairing.rs`](../../packages/runner/crates/forge-runner-core/src/auth/pairing.rs), [`git_cred.rs`](../../packages/runner/crates/forge-runner-core/src/auth/git_cred.rs))
  - `transport/` — `CoreClient` + WebSocket + REST surface ([`ws.rs`](../../packages/runner/crates/forge-runner-core/src/transport/ws.rs), [`frames.rs`](../../packages/runner/crates/forge-runner-core/src/transport/frames.rs), [`events.rs`](../../packages/runner/crates/forge-runner-core/src/transport/events.rs), [`lifecycle.rs`](../../packages/runner/crates/forge-runner-core/src/transport/lifecycle.rs), [`heartbeat.rs`](../../packages/runner/crates/forge-runner-core/src/transport/heartbeat.rs), [`runners.rs`](../../packages/runner/crates/forge-runner-core/src/transport/runners.rs))
  - `runner/` — `Runner` trait + Claude Code impl ([`mod.rs`](../../packages/runner/crates/forge-runner-core/src/runner/mod.rs), [`claude_code.rs`](../../packages/runner/crates/forge-runner-core/src/runner/claude_code.rs), [`process.rs`](../../packages/runner/crates/forge-runner-core/src/runner/process.rs))
  - `daemon/` — orchestration + per-job dispatch ([`mod.rs`](../../packages/runner/crates/forge-runner-core/src/daemon/mod.rs), [`dispatch.rs`](../../packages/runner/crates/forge-runner-core/src/daemon/dispatch.rs))
  - `workspace/` — git worktree + skill seeding ([`worktree.rs`](../../packages/runner/crates/forge-runner-core/src/workspace/worktree.rs), [`skill_sync.rs`](../../packages/runner/crates/forge-runner-core/src/workspace/skill_sync.rs))
  - `mcp/config.rs` — per-job MCP config file
  - `update/` — self-update ([`mod.rs`](../../packages/runner/crates/forge-runner-core/src/update/mod.rs))
  - `config.rs` — `~/.config/forge-runner/config.toml`
- **`forge-runner`** ([`crates/forge-runner/`](../../packages/runner/crates/forge-runner/)) — thin `clap` binary; [`main.rs`](../../packages/runner/crates/forge-runner/src/main.rs) parses args and hands off to a subcommand under [`src/cmd/`](../../packages/runner/crates/forge-runner/src/cmd/).

## Auth — device token

Authenticates as a **device** (long-lived, revocable token), same principal class as the Tauri app. Two pairing flows ([`auth/pairing.rs`](../../packages/runner/crates/forge-runner-core/src/auth/pairing.rs)):

- **Browser-approve (default).** `POST /api/devices/login/init` returns a pairing code + verify URL; daemon opens the browser (or prints the URL with `--no-browser`); user approves in the web UI; daemon polls `GET /api/devices/login/poll` (204 pending / 200 approved / 410 gone) until it gets the device token. May also return a git push credential when the server has that feature enabled.
- **Paste-code (fallback).** `forge-runner login --code <CODE>` calls `POST /api/devices/pair` directly.

Token storage — **credential store** ([`auth/cred_store.rs`](../../packages/runner/crates/forge-runner-core/src/auth/cred_store.rs)):

- macOS/Windows: OS keychain (service `forge-runner`, one-time migration from legacy `forge-beta` service).
- Linux / wherever keychain is unavailable: `0600` file at `~/.config/forge-runner/credentials.json`.
- Force backend with `FORGE_RUNNER_CRED_STORE=keychain|file`; `doctor` reports the active one.

Token sent as `Authorization: Bearer <token>` on every WS + REST call. Non-secret state (core URL, device id, project bindings) lives in `~/.config/forge-runner/config.toml` ([`config.rs`](../../packages/runner/crates/forge-runner-core/src/config.rs)).

## Connection + dispatch

The daemon ([`daemon::run`](../../packages/runner/crates/forge-runner-core/src/daemon/mod.rs)) runs four concurrent loops:

1. **WebSocket** ([`transport/ws.rs`](../../packages/runner/crates/forge-runner-core/src/transport/ws.rs)) — connect `/ws` with Bearer token, subscribe to `device:<id>` room, and (only when `runner.register_enabled` is set, gated behind core's `runnerFramework` flag) send one `runner:register` per assigned project. 25s ping / 15s pong liveness; jittered 1s→30s reconnect backoff; 401 stops the loop with a "re-pair" hint.
2. **Heartbeat** — `POST /api/devices/heartbeat` every 30s ([`heartbeat.rs`](../../packages/runner/crates/forge-runner-core/src/transport/heartbeat.rs)).
3. **Update check** — see [Release & self-update](#release--self-update).
4. **Frame loop** — inbound WS frames ([`frames.rs`](../../packages/runner/crates/forge-runner-core/src/transport/frames.rs)): `job.assigned` → spawn dispatch task; `job.cancel` / `job.cancelRequested` → abort the matching process.

**Project routing.** `GET /api/devices/me/runners` ([`transport/runners.rs`](../../packages/runner/crates/forge-runner-core/src/transport/runners.rs)) is the source of truth for which projects route to this device and each project's repo path; `config.toml` bindings are only a local fallback/cache. Re-fetched per dispatch, so a repo path set in the web UI is picked up without a daemon restart (ISS-271).

**Per job** ([`daemon/dispatch.rs`](../../packages/runner/crates/forge-runner-core/src/daemon/dispatch.rs)): parse `job.assigned` → resolve repo path (server path wins over local binding; if neither exists, fail the job with a `bind` hint) → build a [`JobSpec`](../../packages/runner/crates/forge-runner-core/src/runner/mod.rs) → hand to the runner. The runner streams normalized `RunnerEvent`s on a channel; the dispatcher maps them to core's API:

- stdout / tool-call / tool-result / usage → batched `POST /api/jobs/:id/events` (≤100 per request, 500ms flush cadence, exponential-backoff retry on 5xx, 409 = job already terminal) ([`events.rs`](../../packages/runner/crates/forge-runner-core/src/transport/events.rs)).
- 25s session heartbeat emits a tiny `progress` event during long silent steps so the server's session-stale timer doesn't fire (ISS-285).
- terminal → `POST /api/jobs/:id/complete` (exit code) or `/fail` (error) ([`lifecycle.rs`](../../packages/runner/crates/forge-runner-core/src/transport/lifecycle.rs)).

## Runner kinds

The [`Runner` trait](../../packages/runner/crates/forge-runner-core/src/runner/mod.rs) is the seam for multiple CLI backends on one machine. `RunnerKind` currently has the single `ClaudeCode` variant (wire type `"claude-code"`; `Codex` / `Antigravity` reserved). New backend = new variant + a `Runner` impl + a stream parser.

**`ClaudeCodeRunner`** ([`runner/claude_code.rs`](../../packages/runner/crates/forge-runner-core/src/runner/claude_code.rs)) wraps the `claude` CLI (ported from the Tauri app's `claude_cli/*`):

- Creates a git worktree under `<repo>/.worktrees/<branch>` only when core hands a `worktreeBranch` (code/fix steps); triage/plan/review run in the repo root ([`workspace/worktree.rs`](../../packages/runner/crates/forge-runner-core/src/workspace/worktree.rs)).
- Seeds the project's registered skills into `.claude/skills/<name>/` before the run, best-effort (ISS-278, [`workspace/skill_sync.rs`](../../packages/runner/crates/forge-runner-core/src/workspace/skill_sync.rs)).
- Writes a per-job MCP config to a temp file — the Forge MCP server at `<core>/mcp` (authed with device token + `X-Forge-Project-Slug`) merged with any `mcpServersOverride` from the payload ([`mcp/config.rs`](../../packages/runner/crates/forge-runner-core/src/mcp/config.rs)).
- Spawns `claude --output-format stream-json --verbose` with the job's model, allowed tools, permission mode, appended system prompt, and `--resume <id>` when core supplies a `claudeSessionId`. Runs in its own process group for clean tree-kill ([`runner/process.rs`](../../packages/runner/crates/forge-runner-core/src/runner/process.rs)).
- Parses the JSONL stream into `RunnerEvent`s, classifies the outcome (success / `[USAGE_LIMIT]` / `[RESUME_FAILED]` / transient failure), reaps the child — racing reader-EOF against child-exit with a 2s grace because MCP grandchildren can hold the pipe open. Session key = core `jobId`, so a `job.cancel` aborts the right process.

Resume is core-driven: the daemon passes through `claudeSessionId` and reports a `[RESUME_FAILED]` failure rather than respawning locally, so core can null the dead session and retry fresh.

## CLI commands

`forge-runner <command>` ([`main.rs`](../../packages/runner/crates/forge-runner/src/main.rs)):

| Command | Purpose |
|---|---|
| `login` | Pair this device (browser-approve, or `--code` paste-code). Stores token, saves core URL + device id. |
| `bind <slug> --path <dir>` | Bind a project slug (must already be assigned server-side) to a local checkout; caches locally and pushes the path to the server via `PATCH /me/runners`. |
| `start` | Run the daemon: connect, subscribe, heartbeat, accept jobs. |
| `status` | Show connection + runner status. |
| `logs` | Tail the runner log. |
| `config` | Inspect / edit local config. |
| `doctor [--offline]` | Diagnose `claude`/`git` on PATH, config, cred store, and (online) heartbeat + assignment reconciliation. Exits non-zero on failure. |
| `service install [--no-linger]` / `uninstall` | Linux/systemd-only: write + enable a `--user` unit (`Restart=always`, boot start via linger). macOS/Windows: run `start` manually. |
| `runners` | List the runners this device is registered for. |
| `update [--check] [--restart]` | Check the release manifest and self-update. |

## Release & self-update

- **Distribution.** `core` serves the installer and binaries from `RUNNER_RELEASE_DIR` ([`packages/core/src/install/routes.ts`](../../packages/core/src/install/routes.ts)): `GET /install.sh` (host-aware, `core_url` baked in), `GET /install/latest.json` (version manifest), `GET /install/bin/<target>` (per-target binary). `curl -fsSL https://<core>/install.sh | sh` detects OS/arch, downloads the matching binary to `~/.local/bin/forge-runner` ([`packages/runner/install.sh`](../../packages/runner/install.sh)).
- **Build/publish.** A `runner-vX.Y.Z` git tag triggers [`.github/workflows/runner-release.yml`](../../.github/workflows/runner-release.yml), which cross-builds `forge-runner-<target>` (linux x86_64, macOS aarch64), publishes a GitHub Release, and emits `VERSION`. Deploy copies the assets into `RUNNER_RELEASE_DIR`.
- **Self-update** ([`update/mod.rs`](../../packages/runner/crates/forge-runner-core/src/update/mod.rs)): daemon checks the manifest ~30s after start then every 6h. With `update.auto` set it downloads the asset for its target triple, verifies sha256, atomically replaces the running executable, and restarts the systemd service; otherwise just logs that an update is available. `forge-runner update` does the same on demand.

## Not yet / future

Shipped Linux-first (M1–M4). Deferred: Windows/WSL `claude` spawn; auto-clone on `bind` (today `--path` must point at an existing checkout); a `status --watch` TUI; `start --detach` (use `service install` instead); additional runner kinds (Codex / Antigravity). `packages/dev` (Tauri GUI) remains the other supported runtime form factor.
