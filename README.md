# Jarvis Agents

> Open-source control plane for Claude Code. Webhook in. Pipeline out. Every session on record.

[![CI](https://github.com/junixlabs/jarvis-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/junixlabs/jarvis-agents/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha-yellow.svg)]()

**Status:** internal alpha — not production-ready. Expect breaking changes across `v0.x`.

## What it is

Jarvis Agents sits between your team and Claude Code CLI. It adds:

- **Webhook ingestion** — issues arrive from GitHub, Sentry, Stripe, or your own API
- **A 14-status pipeline** — triage, plan, code, review, release (auto-run or human-gated per stage)
- **Session capture** — every Claude Code run recorded with messages, tool calls, diffs, token usage
- **Multi-device execution** — desktop app runs Claude CLI locally with git worktree isolation; optional cloud runner for browser tasks
- **Extensible skills** — built-in pipeline skills plus your own, versioned per project
- **MCP-native data layer** — same backend exposes REST (for UIs) and MCP (for agents)

Think of it as **Jenkins for Claude Code**: the CLI does the work; Jarvis Agents makes the work visible, resumable, and coordinatable across a team.

## What it is NOT

- Not a replacement for Claude Code — we orchestrate it, we don't replace it
- Not a chat interface — this is a pipeline, not a conversation
- Not a Jira replacement for enterprises — no complex RBAC in `v0.x`
- Not a no-code tool — expect to run `docker compose`

## Quickstart

```bash
git clone https://github.com/junixlabs/jarvis-agents.git
cd jarvis-agents
cp .env.example .env
# Fill .env with Strapi secrets (see comments in .env.example)
docker compose up -d
```

- Server admin: <http://localhost:1337/admin>
- Web dashboard: <http://localhost:3000>
- Vector store: <http://localhost:6333/dashboard>

Install the desktop runner (Claude CLI spawner) from [GitHub Releases](https://github.com/junixlabs/jarvis-agents/releases) once available.

Full walkthrough: [docs/quickstart.md](docs/quickstart.md).

## Architecture

```
┌──────────────┐   ┌─────────┐   ┌────────────────┐
│ web          │   │ app     │   │ dev (Tauri)    │
│ (Next.js)    │   │ (Expo)  │   │ Claude runner  │
└──────┬───────┘   └────┬────┘   └────────┬───────┘
       │                │                 │
       └──── REST ──────┼─── WebSocket ───┘
                        ▼
              ┌─────────────────────┐
              │  strapi (Node)      │
              │  REST + WS + MCP    │
              │  + Pipeline Engine  │
              └──────────┬──────────┘
                         │
     ┌───────────────────┼──────────────────────┐
     ▼                   ▼                      ▼
┌─────────┐         ┌──────────┐         ┌──────────────┐
│Postgres │         │ Qdrant   │         │ Claude Code  │
│ state   │         │ memory   │         │ (via Tauri)  │
└─────────┘         └──────────┘         └──────────────┘
                                                │
                                         (optional: Antigravity
                                          for browser tasks)
```

See [docs/architecture.md](docs/architecture.md) for detail.

## Packages

| Package | Role | Dev command |
|---------|------|-------------|
| [`forge/strapi/`](forge/strapi/) | Backend: REST + WebSocket + MCP + Pipeline Engine | `npm run develop` |
| [`forge/web/`](forge/web/) | Next.js dashboard: Kanban, session replay, pipeline health | `npm run dev` |
| [`forge/dev/`](forge/dev/) | Tauri desktop runner: spawns Claude CLI locally | `npm run tauri dev` |
| [`forge/app/`](forge/app/) | React Native (Expo) mobile: on-the-go review | `npm run start` |

## How it works

1. **An issue arrives.** Via webhook (GitHub, Sentry, custom) or created in the dashboard.
2. **A pipeline routes it.** Each status maps to a skill. `open → forge-triage`, `approved → forge-code`, etc. Per-project config decides what auto-runs vs what's human-gated.
3. **Claude Code executes.** The desktop app spawns a local Claude CLI session in a git worktree. Session state streams to the dashboard in real time.
4. **You review and merge.** Diff, token usage, tool calls — all captured. Approve or reject. Status advances.
5. **Next agent picks up.** Pipeline continues.

## Extending

- **Custom skills** — write your own skill in `.claude/skills/` and register it with a pipeline stage. See [how-to: author a skill](docs/how-to/author-a-skill.md) (coming soon).
- **Custom pipeline stages** — modify the state machine for domain-specific flows.
- **Custom runners** — Claude Code CLI is the default; other runners are pluggable.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md).

Current focus: **v0.1** — control plane for Claude Code with session replay, webhook ingestion, and pipeline observability.

## Documentation

- [Quickstart](docs/quickstart.md) — running in 5 minutes
- [Architecture](docs/architecture.md) — system design
- [Brand & style](docs/BRAND.md) — naming, voice, conventions
- [Roadmap](docs/ROADMAP.md) — what we're building and why

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

First-time? Look for [`good-first-issue`](https://github.com/junixlabs/jarvis-agents/labels/good-first-issue).

Security vulnerabilities: **do not open public issues** — see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) © SidCorp and contributors.

---

Originally developed internally at SidCorp. Open-sourced and maintained by SidCorp and contributors. Contact: chuongld@sidcorp.co.
