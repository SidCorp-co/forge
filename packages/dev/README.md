# dev

Tauri desktop app — the **device runner**. Pairs with a Forge cloud server, receives jobs over WebSocket, and spawns the local Claude CLI to do the work. Your Claude Pro/Max credentials never leave the machine.

→ See [ADR 0001](../../docs/decisions/0001-device-runner-architecture.md) (device-runner architecture) and [ADR 0003](../../docs/decisions/0003-claude-code-cli-as-primary-runner.md) (Claude CLI as runner). Credential boundary: [ADR 0004](../../docs/decisions/0004-no-claude-credentials-on-server.md).

## Prerequisites

- **Node** `>=20` and **pnpm** — install from the repo root
- **Rust** stable toolchain — `rustup` recommended ([install guide](https://www.rust-lang.org/tools/install))
- **Platform deps for Tauri 2** — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) per OS (Linux: `libwebkit2gtk-4.1-dev` + friends; macOS: Xcode CLI; Windows: WebView2 + MSVC)
- **Claude CLI** installed and signed in — `claude --version` should work in your shell

## Install

```bash
# From the repo root
pnpm install
```

## Run locally

```bash
cd packages/dev
pnpm tauri dev    # spawns vite + tauri, opens the desktop window
```

First-run pairing:

1. Open the cloud UI ([`@forge/web`](../web)) and sign in.
2. In the desktop app, paste the pairing code from the cloud UI's *Devices* page.
3. The desktop registers itself as a runner and starts polling for jobs.

## Build distributables

```bash
cd packages/dev
pnpm tauri build   # → src-tauri/target/release/bundle/<platform>/
```

Bundles land per platform: `.dmg` (macOS), `.msi` (Windows), `.AppImage` / `.deb` (Linux).

## Architecture

```
src/                      React/Vite frontend (UI)
  pages/                  dashboard, project (issues, board, chat), settings
  components/             issue detail, chat sidebar, settings panels
  stores/app-store.ts     Zustand (auth, config, projects)
  lib/api.ts              Forge core API client
  lib/types.ts            shared types

src-tauri/src/            Rust backend (process + WS + filesystem)
  claude_cli/             spawn the CLI, parse the stream, generate MCP config
  websocket/              connect to core /ws, multiplex job channels
  jobs/                   job queue + execution loop
  devices/                pairing + heartbeat
  keychain/               OS-native secret storage for the device token
  config/                 on-disk config in `~/.forge/`
```

## Key patterns

- **Tauri IPC** via `@tauri-apps/api` `invoke("command_name", { args })` for local operations; commands live in `src-tauri/src/<module>/commands.rs`.
- **Streaming**: agent sessions stream via `agent:chunk` / `agent:complete` Tauri events emitted from Rust into React.
- **Per-project MCP config**: each project gets its own `.forge/mcp.json` generated under the project root.
- **Knowledge indexing**: `claude_cli/agent.rs` indexes the repo into `.forge/knowledge.json`.
- **Auto-update**: `tauri-plugin-updater` with signed releases — see `src/hooks/use-auto-updater.ts`.

## Tests

```bash
pnpm --filter forge-beta test     # vitest (UI + lib)
```

Rust tests:

```bash
cd packages/dev/src-tauri
cargo test
```

## Sentry (opt-in)

The desktop ships with two Sentry init points — TS renderer (`src/lib/sentry.ts`) and Rust panic hook (`src-tauri/src/main.rs`). Both are no-ops unless a DSN is supplied. Source builds without env vars or config compile cleanly with the SDK detached, so contributors never silently report to the maintainer's instance.

**Rust DSN resolution at startup** (first non-empty wins):

1. `FORGE_SENTRY_DSN_RUST` env var — runtime override for dev / debugging.
2. `~/.config/forge-beta/config.json` → `sentryDsn` field — operator rotation. Edit the file and restart the app; no rebuild required.
3. `option_env!("FORGE_SENTRY_DSN_RUST")` — compile-time fallback baked by CI for official `v0.1.x` artifacts.

All three absent → SDK never initializes. To disable on an installed beta, blank out `sentryDsn` in `config.json` (empty string is treated as unset). The TS renderer accepts a DSN from its caller (`main.tsx`); piping it from the same `sentryDsn` field is a follow-up.

## Other scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | Vite dev server only (no Tauri shell — useful for UI-only iteration) |
| `pnpm build` | Type-check + Vite build (frontend only) |
| `pnpm tauri dev` | Full desktop app dev mode |
| `pnpm tauri build` | Build platform distributable |
