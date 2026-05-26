# dev

Tauri desktop app — the **device runner**. Pairs with a Forge cloud server, receives jobs over WebSocket, and spawns the local Claude CLI to do the work. Your Claude Pro/Max credentials never leave the machine.

→ See [docs/architecture/system-overview.md](../../docs/architecture/system-overview.md) for the control plane ↔ runtime split and the credential boundary.

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

## Other scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | Vite dev server only (no Tauri shell — useful for UI-only iteration) |
| `pnpm build` | Type-check + Vite build (frontend only) |
| `pnpm tauri dev` | Full desktop app dev mode |
| `pnpm tauri build` | Build platform distributable |
