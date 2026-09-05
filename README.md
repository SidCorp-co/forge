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

Install the device agent (spawns `claude` on your machine) with
`curl <core-url>/install.sh | sh`, then `forge-runner login --code <code>`.

Full walkthrough: [docs/quickstart.md](docs/quickstart.md).

## Architecture

```
  Your browser / phone                 Your machine(s)
  ┌──────────────┐                     ┌──────────────────────┐
  │ web (Next.js)│                     │ Device agent         │
  │ dashboard    │                     │ - CLI daemon         │
  │              │                     │   (forge-runner)     │
  │              │                     │                      │
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
| [`packages/runner/`](packages/runner/) | Rust CLI daemon device agent — the only device agent; forge-runner binary | `cargo run` |
| [`packages/contracts/`](packages/contracts/) | Shared TypeScript contracts | — |

## How it works

1. **Pair a device.** Account → Devices → "Add device" generates a pairing
   code. Run `forge-runner login --code F9-3K7T-92XA` on your machine. Token
   stored in the OS keychain. Device appears online in the dashboard.
2. **Bind a project to a device.** Project → Settings → Runtime → pick a
   device from your pool. First bind prompts for the repo's local path and
   runs `git clone` if needed. One device active at a time per project.
3. **An issue arrives.** Via webhook or created in the dashboard. At `open`
   the pipeline enqueues one `drive` job — the driver owns the issue's whole
   walk, from reading it to shipping it.
4. **The dispatcher picks a device.** Job pushed over WebSocket to the
   project's active device. Device spawns `claude` locally, streams stdout /
   tool calls / diffs back to the server.
5. **You watch, and answer when asked.** Dashboard streams events real-time.
   The driver moves the issue itself and parks at `needs_info` when it needs a
   human; your answer restarts it.
6. **The server keeps receipts.** Every job has a full event log retained
   30 days after termination. Issues persist.

## Extending

- **Skills** — author your own in `.claude/skills/` and register with a
  pipeline stage.
- **Pipeline stages** — modify the issue status state machine
  (`packages/core/src/pipeline/state-machine.ts`) for domain flows (RFC required
  for public releases).
- **Runners** — the device-agent runner is pluggable. Default runs `claude`
  CLI; future runners can be anything that emits the Forge event protocol.

## Roadmap

Ships when ready, no dates.

| Horizon | Content |
|---|---|
| **Now — `v0.3.x`** | Two lanes, both for **trust**: *kernel hardening* (orphan gaps, false failures, failure taxonomy, recovery behaviour, state integrity) · *onboarding* (init wizard, skill smoke verification, bootstrap template, request intake, initial pipeline routing) |
| **Next — `v0.4`** | Mobile read-only · session replay diff · webhook templates · early Spec exploration · human-routing foundations |
| **Later** | Spec + Design stages · deep GitHub/GitLab · MCP registry · skill marketplace · organizational roles and permissions · OTel · audit export · security review · advanced routing and concurrency |
| **`v1.0`** | Freeze API · skill format · device protocol · stage contracts · core lifecycle semantics. Then strict SemVer and LTS. |

Device-runner pairing, the job pipeline, session replay, and webhook ingestion
shipped across `v0.1.x`. `v0.3.0` added Organizations and the multi-runner
framework, alongside custom skill authoring and the web dashboard. Current
focus: hardening these — org/RBAC polish, runner reliability, and pipeline
observability. (Runner version lives in `packages/runner/Cargo.toml`
`[workspace.package]`; it is deliberately not pinned here — it re-drifted every
release.) See
[CHANGELOG.md](CHANGELOG.md) for what's shipped.

## Documentation

- [Vision](docs/VISION.md) — what Forge is / is not, why, who, principles
- [Quickstart](docs/quickstart.md)
- [Architecture](docs/architecture/system-overview.md)
- [Modules](docs/modules/)
- [RFCs](docs/rfcs/) — proposals through Final Comment Period
- [Proposals](docs/proposals/) — in-flight design sketches

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The repo follows **Trunk-Based
Development** — single `main`, no `develop`, branches live <1 day, feature
flags absorb in-flight work.

First-time? Look for
[`good-first-issue`](https://github.com/SidCorp-co/forge/labels/good-first-issue).

Significant changes require an RFC — see [docs/rfcs/](docs/rfcs/) for format.

Security vulnerabilities: **do not open public issues** — use GitHub's
[private vulnerability reporting form](https://github.com/SidCorp-co/forge/security/advisories/new).

## License

[Apache-2.0](LICENSE) © Forge contributors.
