# Forge — OSS launch pack

Copy-paste material to grow reach. All links point at `github.com/SidCorp-co/forge`.
One-liner (reuse everywhere): **Open-source, self-hosted control plane for Claude Code — your
devices run `claude`, the server never holds your Claude credentials.**

---

## 1. Awesome-list submissions (biggest referral source)

Open a PR adding one line to each list's relevant section. Entry text:

- `[Forge](https://github.com/SidCorp-co/forge) - Self-hosted control plane for Claude Code: routes and gates agent jobs across your own devices; the server never holds Claude credentials. (Apache-2.0)`

Targets:
| List | Repo | Section |
|---|---|---|
| Awesome Claude Code | `hesreallyhim/awesome-claude-code` (and `sindresorhus`-style forks) | Tooling / Orchestration |
| Awesome MCP Servers | `punkpeye/awesome-mcp-servers` | Frameworks / Dev tools |
| Awesome AI Agents | `e2b-dev/awesome-ai-agents` | Frameworks / Orchestration |
| Awesome Selfhosted | `awesome-selfhosted/awesome-selfhosted` | Automation / Software Development |

## 2. MCP registries (Forge exposes an MCP server at `/mcp`)

Submit the server listing to: **mcp.so**, **Glama** (glama.ai/mcp), **Smithery** (smithery.ai),
and the community list in `modelcontextprotocol/servers`. Blurb:
`Forge — control-plane MCP server: issues, pipeline, durable project memory, and job dispatch for Claude Code agents. Self-hosted.`

## 3. Show HN

**Title:** `Show HN: Forge – open-source control plane for Claude Code (self-hosted)`

**Body:**
> Forge is a self-hosted control plane for Claude Code. Your own machines run `claude`; Forge
> queues the work, gates it through required checks, streams events to a dashboard, and keeps the
> receipts. The design boundary is the point: the server queues and routes, but Claude credentials
> never leave your box — a server compromise leaks no Claude keys.
>
> It's an MCP server too, so agents talk to it over MCP for issues, pipeline state, and a durable
> per-project memory. Stack: Hono + Postgres (pgvector) backend, Next.js dashboard, a Rust runner
> daemon that pairs each device.
>
> It's alpha and moving fast (breaking changes across v0.x). Quickstart is `docker compose up` +
> pair a device. Would love feedback on the control-plane/runtime split and the pipeline gating.
>
> Repo: https://github.com/SidCorp-co/forge

Post Tue–Thu ~08:00–10:00 PT. Reply to every early comment; that window drives the ranking.

## 4. Reddit

**r/selfhosted** — Title: `Forge: self-hosted control plane for Claude Code (Apache-2.0)`
> I've been building Forge — a self-hosted way to run Claude Code agents across your own machines.
> The server routes and gates jobs and shows a dashboard (kanban, replay, pipeline health), but it
> never holds your Claude credentials — your boxes run `claude`, the server just orchestrates.
> Docker-compose to stand up, pair a device with the runner. Alpha, Apache-2.0. Repo + quickstart:
> https://github.com/SidCorp-co/forge — feedback welcome.

**r/ClaudeAI** — Title: `Open-source control plane for Claude Code — route/gate agent work across your own devices`
> (same body, lead with the Claude Code angle + the credentials-stay-local guarantee)

## 5. X / Bluesky thread

1. Forge is open source: a self-hosted control plane for Claude Code. Your devices run `claude`;
   Forge routes the work, gates it, keeps the receipts — and never holds your Claude credentials. 🧵
2. Control plane vs runtime: the server queues jobs + streams events; your machines run Claude. A
   server compromise leaks no Claude keys. That boundary is the whole design.
3. It's an MCP server: agents get issues, pipeline state, and durable project memory over MCP.
   Stack: Hono/Postgres, Next.js dashboard, a Rust runner that pairs each device.
4. Alpha, Apache-2.0. `docker compose up` + pair a device. Repo: https://github.com/SidCorp-co/forge

## 6. Repo hygiene before launching (drives conversion once traffic lands)
- Set **Social preview** image (Settings → General → Social preview): `docs/assets/og-image.png`.
- Add a **demo GIF** to the README top (the dashboard doing a real pipeline run).
- Seed **Discussions**: an Announcements post + a couple of Q&A/Show-and-tell threads.
- Label 3–5 issues `good first issue`.
