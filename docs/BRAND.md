# Brand & style — Forge

Consistent style across code, docs, UI, and public communication.

## Name

- **Canonical:** `Forge` — single word, title case (capital F).
- **Code identifier:** `forge` — kebab-case, lowercase. Used for the GitHub repo, root npm package, Docker image, and OS bundle name.
- **Tauri desktop app:** `Forge Beta` (display name), `forge-beta` (binary). Will drop the "Beta" suffix when we exit `v0.x`.
- **Org:** `SidCorp` (formal `SidCorp.co`); GitHub handle `SidCorp-co`. Repo: [`SidCorp-co/forge`](https://github.com/SidCorp-co/forge).
- **Never use:** `Jarvis`, `Jarvis Agents`, `JARVIS`, `jarvis-agents`, `jarvisagents` — retired pre-OSS names. Old URLs auto-redirect, but new code, docs, and commits should not introduce them.

## Tagline

**Primary (repo description, social one-liners):**
> The open-source engine behind a POC studio. Webhook → AI agent pipeline → your machines, end-to-end. Self-hosted, MCP-native, Apache-2.0.

**Hero (README, landing page):**
> Remote-control your local Claude Code. Webhook in. Pipeline out. Every job on record.

**Developer-facing (community posts, blog):**
> GitHub Actions self-hosted runners, for Claude Code.

Lead with the action ("remote-control") — it's the concrete value. Avoid "open-source project management + AI agent platform" — it under-sells what we actually do and reads as generic.

## Writing voice

- **Primary language:** English for all public docs, code comments, commits, README, blog posts.
- **Secondary:** Vietnamese acceptable only in internal-alpha channels, never in public artifacts.
- **Voice:** direct, technical, welcoming. Not marketing-speak, not academic.
- **Address user:** second person ("you"), never "the user" or "one".

### Banned phrases

Avoid these — they signal marketing bloat:

- "AI-powered" — we orchestrate the user's AI, we don't power it
- "Revolutionary", "seamless", "cutting-edge"
- "Unlock", "leverage", "synergy"
- "Game-changing", "unleash"
- Fake urgency: "now", "finally", "at last"
- "Autonomous" as marketing adjective (OK as literal technical descriptor)

### Preferred phrases

- **Action verbs:** pair, route, dispatch, run, stream, replay, revoke, audit, resume
- **Domain:** device, job, pipeline stage, skill, webhook, session
- **Actors:** engineer, maintainer, team, developer (specific, not "user" or "customer")

Use "job" for individual agent runs (CI-style). "Session" is acceptable colloquially but less precise.

## Naming conventions across code

| Surface | Convention | Example |
|---------|-----------|---------|
| Repo / Docker image | `kebab-case` | `forge` |
| npm package scope | `@forge/*` | `@forge/core`, `@forge/contracts` |
| TypeScript files | `camelCase` | `userStore.ts` |
| TypeScript exports (classes, React components) | `PascalCase` | `UserStore`, `IssueList` |
| TypeScript functions, variables | `camelCase` | `fetchIssues`, `currentUser` |
| REST API paths | `kebab-case`, plural | `/api/projects`, `/api/agent-sessions` |
| Database tables | `snake_case`, plural | `projects`, `agent_sessions` |
| Environment variables | `SCREAMING_SNAKE_CASE` | `DATABASE_URL`, `FORGE_API_KEY` |
| Feature flags | camelCase in code, `FEATURE_*` env | `isEnabled('chatProvider')` ↔ `FEATURE_CHAT_PROVIDER` |
| Git branches | `ISS-<id>-<short>` | `ISS-42-oauth-login` |
| Issue IDs | `ISS-<number>` | `ISS-42` |

Tauri bundle identifier follows reverse-DNS — `co.sidcorp.forge-beta`.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) — required.

Format: `type(scope): description`

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `style`, `revert`.

Scopes (required unless root-level change): the package touched — `core`, `web`, `dev`, `contracts`, `app` (paused), `docs`, `ci`, `deps`.

Examples:
```
feat(core): add OAuth2 device flow endpoint
fix(web): resolve WebSocket reconnect race
docs(readme): update quickstart for v0.2
chore(deps): bump rustls-webpki to 0.103.13
```

### Breaking changes

Mark with `!` after type/scope:

```
feat(api)!: rename /users endpoint to /accounts

BREAKING CHANGE: /users removed. Use /accounts. See migration-2.0.md.
```

### Body format (non-trivial changes)

For non-trivial commits, body should include:

```
feat(core): introduce agent session streaming

Problem: Clients polling for session status caused DB load spikes.
Solution: WebSocket subscription broadcasts chunks as they arrive.
```

Borrowed from Neovim — makes git log itself useful documentation.

## Error messages

- **Actionable:** say what went wrong + what to do next.
- **Blame system, not user:** "Couldn't connect to database" not "You failed to connect".
- **Include next step:** `See docs/troubleshooting.md#db-connect`.
- **Error IDs for searchability:** `[E0042] Database unreachable — check DATABASE_URL`.

## Documentation voice

- Headings in **sentence case** (`## Getting started`), not title case.
- Code blocks always specify language: `` ```bash ``, `` ```typescript ``.
- Prefer inline links over reference-style for readability.
- Quickstart must be copy-pasteable from top to bottom — no "skip this step" instructions.

## Visual identity

To finalize. Placeholders until settled:

- **Primary color:** TBD
- **Secondary color:** TBD
- **Logo:** TBD (SVG, usable at 16px → 512px)
- **Font — display:** TBD (system-ui acceptable fallback)
- **Font — body:** TBD
- **Font — code:** JetBrains Mono or Fira Code (with ligatures)

## Enforcement

Automated where possible, manual review otherwise:

| Rule | Enforcement |
|------|-------------|
| TypeScript style | Biome (lint + format) per package |
| Commit messages | PR title check in CI; commitlint hook planned |
| File/folder naming | Linted via custom rule (later) |
| Error message format | PR review |
| Brand voice | PR review; BRAND.md referenced in CONTRIBUTING |
