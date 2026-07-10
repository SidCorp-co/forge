# Forge

> The open-source AI-powered software lifecycle platform. Manage software from
> build through maintain — powered by Claude Code on devices you control.

[![CI](https://github.com/SidCorp-co/forge/actions/workflows/ci.yml/badge.svg)](https://github.com/SidCorp-co/forge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha-yellow.svg)]()

**Status:** alpha — not production-ready. Expect breaking changes across `v0.x`.

## What it is

Forge is an open-source **AI-powered software lifecycle platform**. You keep
using `claude` on your own machine with your own Claude Pro/Max subscription.
Forge adds the layer around it: a web dashboard to manage projects from build
through maintenance, a configurable pipeline that routes issues through stages,
and a full audit trail of every job. The server never holds your Claude
credentials.

- **Devices pair into your account.** Your laptop, desktop, or CI box runs the
  Forge agent, which spawns `claude` locally. The server never holds Claude
  credentials.
- **Issues flow in from anywhere.** GitHub webhooks, Sentry alerts, Stripe
  events, your own API — point a webhook at Forge, it becomes an issue.
- **A configurable pipeline routes work.** Default flow: triage → clarify →
  plan → code → review → test → release. Per stage: auto-run or human gate.
  Shorten, extend, or replace it per project.
- **Every job is captured.** stdout, stderr, tool calls, diffs, token usage —
  streamed to the dashboard in real time, resumable on disconnect, replayable
  later.
- **Extensible.** Author your own skills, define your own pipeline stages,
  bring your own runner.
- **Multi-project, multi-device.** One Forge instance coordinates many
  projects. Each project binds to devices from a pool; one active at a time.
- **Organizations.** Two-tier org+project roles (owner/admin/member plus
  project viewer), org-shared integration connections, and email invitations.

Think **GitHub Actions self-hosted runners, for Claude Code.** Devices yours.
Compute yours. Orchestration open-source.

## What it is NOT

- Not a Claude Code replacement — we orchestrate the CLI, we don't reimplement.
- Not a chat UI — the primary surface is a pipeline dashboard.
- Not a tool that uses the Anthropic API — we never hold Claude credentials.
- Not heavyweight enterprise PM — Forge now ships a two-tier org+project role model, but it isn't aimed at full enterprise PM/governance suites.

## Quickstart

```bash
git clone https://github.com/SidCorp-co/forge.git
cd forge
cp .env.example .env
docker compose up -d
```

- Core API: <http://localhost:8080>
- Web dashboard: <http://localhost:3000>

Install the desktop agent (spawns `claude` on your machine) from
[Releases](https://github.com/SidCorp-co/forge/releases), or run
`forge-runner login --code <code>`.

Full walkthrough: [docs/quickstart.md](docs/quickstart.md).

## Architecture

```
  Your browser / phone                 Your machine(s)
  ┌──────────────┐                     ┌──────────────────────┐
  │ web (Next.js)│                     │ Device agent         │
  │ dashboard    │                     │ - Tauri GUI (dev), or│
  │              │                     │ - CLI daemon         │
  │              │                     │   (forge-runner)     │
  └──────┬───────┘                     │                      │
         │ REST + WebSocket            │ runs `claude` locally│
         ▼                             │ in a git worktree    │
  ┌────────────────────────────────────┐└────────┬─────────────┘
  │  Control plane (packages/core)     │         │
  │  Hono + Drizzle + pg-boss + ws     │ WebSocket (events, jobs)
  │  + MCP                             │◄────────┘
  │  Pipeline engine, job dispatcher   │
  │  NEVER holds Claude credentials    │
  └──────────┬─────────────────────────┘
             ▼
       ┌──────────────────────┐
       │ Postgres             │
       │ state + jobs + vectors│
       └──────────────────────┘
```

Two key boundaries:

1. **Control plane vs. runtime.** The server queues jobs and streams events.
   Devices run Claude Code. A server compromise never leaks Claude credentials —
   they live on your machines.
2. **Dual-principal auth.** A user (JWT) and a device (long-lived revocable
   token) are two separate principals. Shared policy layer enforces every
   access.

See [docs/architecture/system-overview.md](docs/architecture/system-overview.md).

## Packages

| Package | Role | Dev |
|---------|------|-----|
| [`packages/core/`](packages/core/) | Control plane: Hono + Drizzle + pg-boss + WebSocket + MCP | `pnpm dev` |
| [`packages/web-v2/`](packages/web-v2/) | Next.js dashboard: kanban, replay, pipeline health, devices | `pnpm dev` |
| [`packages/dev/`](packages/dev/) | Tauri desktop device agent (GUI form factor) | `pnpm tauri dev` |
| [`packages/runner/`](packages/runner/) | Rust CLI daemon device agent (headless) — forge-runner binary | `cargo run` |
| [`packages/contracts/`](packages/contracts/) | Shared TypeScript contracts | — |

## How it works

1. **Pair a device.** Account → Devices → "Add device" generates a pairing
   code. Run `forge-runner login --code F9-3K7T-92XA` on your machine (or paste into the
   Tauri app). Token stored in the OS keychain. Device appears online in the
   dashboard.
2. **Bind a project to a device.** Project → Settings → Runtime → pick a
   device from your pool. First bind prompts for the repo's local path and
   runs `git clone` if needed. One device active at a time per project.
3. **An issue arrives.** Via webhook or created in the dashboard. Pipeline
   enqueues the first stage (`forge-triage`) as a job.
4. **The dispatcher picks a device.** Job pushed over WebSocket to the
   project's active device. Device spawns `claude` locally, streams stdout /
   tool calls / diffs back to the server.
5. **You watch and gate.** Dashboard streams events real-time. Approve the
   plan, reject the diff, move it along. Finished jobs advance the pipeline.
6. **The server keeps receipts.** Every job has a full event log retained
   30 days after termination. Issues persist.

## Extending

- **Skills** — author your own in `.claude/skills/` and register with a
  pipeline stage.
- **Pipeline stages** — modify the
  [issue status state machine](docs/modules/issues-pipeline/status-pipeline.md)
  for domain flows (RFC required for public releases).
- **Runners** — the device-agent runner is pluggable. Default runs `claude`
  CLI; future runners can be anything that emits the Forge event protocol.

## Roadmap

See [docs/VISION.md §8](docs/VISION.md#8-roadmap-horizons).

Device-runner pairing, the job pipeline, session replay, and webhook ingestion
shipped across `v0.1.x`. `v0.3.0` added Organizations and the multi-runner
framework, alongside custom skill authoring and the web dashboard. Current
focus: hardening these — org/RBAC polish, runner reliability (the Rust runner is
at `0.6.7`), and pipeline observability. See
[CHANGELOG.md](CHANGELOG.md) for what's shipped.

## Documentation

- [Vision](docs/VISION.md) — concept, audience, non-goals, horizons
- [Quickstart](docs/quickstart.md)
- [Architecture](docs/architecture/system-overview.md)
- [Guides](docs/guides/) — release, trunk-based development
- [Modules](docs/modules/)
- [RFCs](docs/rfcs/) — proposals through Final Comment Period
- [Proposals](docs/proposals/) — in-flight design sketches

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The repo follows **Trunk-Based
Development** — single `main`, no `develop`, branches live <1 day, feature
flags absorb in-flight work. Full rules:
[docs/guides/trunk-based-development.md](docs/guides/trunk-based-development.md).

First-time? Look for
[`good-first-issue`](https://github.com/SidCorp-co/forge/labels/good-first-issue).

Significant changes require an RFC — see [docs/rfcs/](docs/rfcs/) for format.

Security vulnerabilities: **do not open public issues** — see
[SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) © Forge contributors.
