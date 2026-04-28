# Jarvis Agents

> Remote-control your local Claude Code. Webhook in. Pipeline out. Every job on record.

[![CI](https://github.com/junixlabs/jarvis-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/junixlabs/jarvis-agents/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha-yellow.svg)]()

**Status:** internal alpha — not production-ready. Expect breaking changes across `v0.x`.

## What it is

Jarvis Agents is an open-source **control plane** for Claude Code. You keep using `claude` on your own machine with your own Claude Pro/Max subscription. Jarvis adds the layer around it: a web dashboard to trigger work, a pipeline that routes issues through agent stages, and a full audit trail of every job.

- **Devices pair into your account.** Your laptop, desktop, or CI box runs the Jarvis agent, which spawns `claude` locally. The server never holds Claude credentials.
- **Issues flow in from anywhere.** GitHub webhooks, Sentry alerts, Stripe events, your own API — create a webhook, point it at Jarvis, it becomes an issue.
- **A 14-status pipeline routes work.** Triage → clarify → plan → code → review → test → release. Per stage: auto-run or human gate.
- **Every job is captured.** stdout, stderr, tool calls, diffs, token usage — streamed to the dashboard in real time, resumable on disconnect, replayable later.
- **Extensible by design.** Write your own skills, define your own pipeline stages, bring your own runner.
- **Multi-project, multi-device.** One Jarvis instance coordinates many projects. Each project binds to devices from a pool; one active at a time.

Think of it as **GitHub Actions self-hosted runners, for Claude Code.** The devices are yours. The compute is yours. The orchestration is open-source.

## What it is NOT

- Not a replacement for Claude Code — we orchestrate the CLI, we don't reimplement it.
- Not a chat UI — the primary interface is a pipeline dashboard.
- Not a tool that uses the Anthropic API — we never hold your Claude credentials.
- Not a replacement for enterprise PM — no complex RBAC in `v0.x`.

## Quickstart

```bash
git clone https://github.com/junixlabs/jarvis-agents.git
cd jarvis-agents
cp .env.example .env
docker compose up -d
```

- Core API: <http://localhost:8080>
- Web dashboard: <http://localhost:3000>

Then install the desktop agent (spawns `claude` on your machine) from [Releases](https://github.com/junixlabs/jarvis-agents/releases), or run `forged pair <code>` if you prefer the CLI daemon.

Full walkthrough: [docs/quickstart.md](docs/quickstart.md).

## Architecture

```
  Your browser / phone                 Your machine(s)
  ┌──────────────┐                     ┌──────────────────────┐
  │ web (Next.js)│                     │ Device agent         │
  │ dashboard    │                     │ - Tauri GUI (dev), or│
  │ + mobile     │                     │ - CLI daemon (forged)│
  └──────┬───────┘                     │                      │
         │ REST + WebSocket            │ runs `claude` locally│
         ▼                             │ in a git worktree    │
  ┌────────────────────────────────────┐└────────┬─────────────┘
  │  Control plane (packages/core)        │         │
  │  Hono + Drizzle + pg-boss + ws     │ WebSocket (events, jobs)
  │  + MCP                             │◄────────┘
  │  Pipeline engine, job dispatcher   │
  │  NEVER holds Claude credentials    │
  └──────────┬─────────────────────────┘
             │
             ▼
       ┌──────────────────────┐
       │ Postgres             │
       │ state + jobs + vectors│
       └──────────────────────┘
```

Two key boundaries:

1. **Control plane vs. runtime.** The server queues jobs and streams events. Devices run Claude Code. A server compromise never leaks Claude credentials — they live on your machines.
2. **Dual-principal auth.** A user (JWT) and a device (long-lived revocable token) are two separate principals with separate permissions. Shared policy layer enforces every access.

See [docs/architecture/system-overview.md](docs/architecture/system-overview.md) and [docs/rfcs/0001-device-runner-architecture.md](docs/rfcs/0001-device-runner-architecture.md) for detail.

## Packages

| Package | Role | Dev command |
|---------|------|-------------|
| [`packages/core/`](packages/core/) | Control plane: Hono + Drizzle + pg-boss + WebSocket + MCP | `pnpm dev` |
| [`packages/web/`](packages/web/) | Next.js dashboard: Kanban, job replay, pipeline health, device mgmt | `npm run dev` |
| [`packages/dev/`](packages/dev/) | Tauri desktop device agent (GUI form factor) | `npm run tauri dev` |
| `packages/forged/` | CLI daemon device agent (headless form factor) — coming soon | — |
| `packages/agent-core/` | Shared Rust crate used by both device agents | — |

> Mobile app (`packages/app/`) is paused for `v0.x`. Revisiting for `v0.2+` after the device-runner model stabilizes.

## How it works

1. **Pair a device.** Account → Devices → "Add device" generates a pairing code. Run `forged pair F9-3K7T-92XA` on your machine (or paste into the Tauri app). Token stored in the OS keychain. Device appears online in the dashboard.

2. **Bind a project to a device.** Project → Settings → Runtime → pick a device from your pool. First bind prompts for the repo's local path and runs `git clone` if needed. One device is active at a time per project.

3. **An issue arrives.** Via webhook or created in the dashboard. Pipeline enqueues the first stage (`forge-triage`) as a job.

4. **The dispatcher picks a device.** Job is pushed over WebSocket to the project's active device. Device spawns `claude` locally, streams stdout / tool calls / diffs back to the server.

5. **You watch and gate.** The dashboard streams events in real time. Approve the plan. Reject the diff. Move it along. Jobs that finish advance the pipeline.

6. **The server keeps receipts.** Every job has a full event log, retained for 30 days after it terminates. Issues themselves are persistent.

## Extending

- **Custom skills** — author your own skill in `.claude/skills/` and register it with a pipeline stage.
- **Custom pipeline stages** — modify the 14-status state machine for domain-specific flows (requires RFC for public releases).
- **Custom runners** — the device agent is pluggable. Default runs `claude` CLI; future runners can be anything that emits the Jarvis event protocol.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md).

Current focus: **v0.1** — device-runner architecture, job pipeline, session replay, webhook ingestion.

## Documentation

- [Quickstart](docs/quickstart.md) — 5-minute setup
- [Architecture](docs/architecture/system-overview.md) — system design
- [RFC 0001: Device-runner architecture](docs/rfcs/0001-device-runner-architecture.md) — the architectural foundation
- [Brand & style](docs/BRAND.md)
- [Roadmap](docs/ROADMAP.md)
- [Security audits](docs/security/) — per-release closure trail

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The repo follows **Trunk-Based Development** — single `main`, no `develop`, branches live <1 day, feature flags absorb in-flight work. Rationale + full rules: [ADR 0014](docs/decisions/0014-trunk-based-development.md).

First-time? Look for [`good-first-issue`](https://github.com/junixlabs/jarvis-agents/labels/good-first-issue).

Significant changes require an RFC — see [docs/rfcs/](docs/rfcs/) for the format.

Security vulnerabilities: **do not open public issues** — see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) © SidCorp and contributors.

---

Originally developed internally at SidCorp. Open-sourced and maintained by SidCorp and contributors. Contact: chuongld@sidcorp.co.
