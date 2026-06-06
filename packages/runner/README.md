# Forge Runner

Lightweight pure-Rust CLI daemon that brokers between Forge **core** and the local
machine: pairs as a device, receives jobs over WebSocket, runs them with the Claude
Code CLI (future: codex / antigravity), and streams events back.

Replaces the Tauri desktop app (`packages/dev`). Design: [`docs/architecture/runner-daemon.md`](../../docs/architecture/runner-daemon.md).

## Layout

- `crates/forge-runner-core` — the lib: transport, auth, runner abstraction, workspace,
  mcp, daemon orchestration. No CLI/GUI knowledge → a thin GUI/tray can reuse it later.
- `crates/forge-runner` — the `clap` binary that drives the lib.

## Status (M1–M4 implemented, Linux-first)

Working: pairing (`login --code`), credential store (keychain + `0600` file
fallback), WebSocket connect/subscribe/reconnect, 30s heartbeat, job dispatch
→ Claude CLI run (worktree + MCP config) → streamed events + complete/fail,
cancel/abort, `doctor`, `bind`, `status`, `runners`, `service install`
(systemd). Release binary ≈ 3.7 MB.

Deferred: browser-approve login (C1, core-side) + `install.sh`/binary release
(C2); Windows/WSL spawn; `status --watch` TUI; auto-clone; reporting
`claudeSessionId` to `agent_sessions` for resume.

```bash
cargo build --release
./target/release/forge-runner doctor
./target/release/forge-runner login --core-url <url> --code <CODE>
./target/release/forge-runner bind <slug> --path <dir> --project-id <uuid>
./target/release/forge-runner start
```

## Auto-update (ISS-392)

The daemon checks `{core}/api/install/latest.json` ~30s after start and every 6h.
When a newer release is published it downloads the matching binary, verifies its
sha256, swaps the executable, and restarts the systemd service.

Auto-update is **ON by default**. The restart **drains to idle first** — it waits
for in-flight pipeline jobs and chat sessions to finish (up to 30 min) before
restarting, so an update never kills running work. Control it without editing
TOML:

```bash
forge-runner config set update.auto false   # opt this device out
forge-runner config set update.auto true    # opt back in
forge-runner config set update.manifest-url https://<core>/api/install/latest.json
```

The installer enables it by default; pass `--no-auto-update` to opt out at install
time: `curl -fsSL https://<core>/api/install.sh | sh -s -- --no-auto-update`.
