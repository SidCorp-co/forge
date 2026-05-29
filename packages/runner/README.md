# Forge Runner

Lightweight pure-Rust CLI daemon that brokers between Forge **core** and the local
machine: pairs as a device, receives jobs over WebSocket, runs them with the Claude
Code CLI (future: codex / antigravity), and streams events back.

Replaces the Tauri desktop app (`packages/dev`). Design: [`docs/proposals/forge-runner-cli.md`](../../docs/proposals/forge-runner-cli.md).

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
