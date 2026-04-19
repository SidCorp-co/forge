# Jarvis Agents

> Open-source project management + AI agent platform. Linear-style issue tracker with agent orchestration driven by Claude CLI and cloud AI providers.

[![CI](https://github.com/junixlabs/jarvis-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/junixlabs/jarvis-agents/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha-yellow.svg)]()

**Status:** internal alpha — not production-ready. Expect breaking changes across `v0.x`.

## What it is

Jarvis Agents combines three things small teams usually buy separately:

- **An issue tracker** with a 14-status pipeline for real engineering work
- **An agent orchestration layer** that can triage, plan, code, review, and release autonomously
- **Multi-surface clients** — web (Next.js), desktop (Tauri), mobile (Expo) — sharing the same API

The agents are not a chat wrapper. They run through a documented pipeline (`forge-triage` → `forge-plan` → `forge-code` → `forge-review` → `forge-release`), operate on your real codebase via MCP, and produce auditable session history.

## What it is not

- Not a Jira/Linear replacement for enterprises — no complex RBAC, no Jira-grade reporting
- Not a ChatGPT wrapper — agents are workflow-aware, not conversational
- Not a no-code tool — expect to run `docker compose`

## Quickstart

```bash
git clone https://github.com/junixlabs/jarvis-agents.git
cd jarvis-agents
cp .env.example .env
# Fill .env with Strapi secrets (see comments in .env.example)
docker compose up -d
```

- Backend: <http://localhost:1337/admin>
- Web UI: <http://localhost:3000>
- Qdrant: <http://localhost:6333/dashboard>

Full walkthrough: [docs/quickstart.md](docs/quickstart.md).

## Architecture

Four independent packages (no shared workspace):

```
┌──────────────┐   ┌─────────┐   ┌────────────────┐
│ web (Next.js)│   │ app     │   │ dev (Tauri)    │
│              │   │ (Expo)  │   │ desktop + Rust │
└──────┬───────┘   └────┬────┘   └────────┬───────┘
       │                │                 │
       └──── REST ──────┼─── WebSocket ───┘
                        ▼
              ┌─────────────────────┐
              │  strapi (Node)      │
              │  REST + WS + MCP    │
              │  + Agent Runner     │
              └──────────┬──────────┘
                         │
         ┌───────────────┼──────────────┐
         ▼               ▼              ▼
   ┌─────────┐    ┌──────────┐    ┌─────────────┐
   │Postgres │    │ Qdrant   │    │ Claude CLI  │
   │         │    │(embeddin)│    │ / LLM APIs  │
   └─────────┘    └──────────┘    └─────────────┘
```

See [docs/architecture.md](docs/architecture.md) for deeper detail.

## Packages

| Package | Role | Dev command |
|---------|------|-------------|
| [`forge/strapi/`](forge/strapi/) | Backend: REST + WebSocket + MCP + Agent Runner | `npm run develop` |
| [`forge/web/`](forge/web/) | Next.js cloud UI | `npm run dev` |
| [`forge/dev/`](forge/dev/) | Tauri desktop app with local codebase access | `npm run tauri dev` |
| [`forge/app/`](forge/app/) | React Native (Expo) mobile app | `npm run start` |

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for strategic themes and version direction.

Current focus: **v0.1** — minimum viable public release.

## Documentation

- [Quickstart](docs/quickstart.md) — get running in 5 minutes
- [Architecture](docs/architecture.md) — system design
- [Brand & style](docs/BRAND.md) — naming conventions and voice
- [Roadmap](docs/ROADMAP.md) — what we're building and why

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

First-time? Look for [`good-first-issue`](https://github.com/junixlabs/jarvis-agents/labels/good-first-issue).

Security vulnerabilities: **do not open public issues** — see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) © SidCorp and contributors.

---

Originally developed internally at SidCorp. Open-sourced and maintained by SidCorp and contributors. Contact: chuongld@sidcorp.co.
