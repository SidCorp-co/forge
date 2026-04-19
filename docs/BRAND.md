# Brand & style — Jarvis Agents

Consistent style across code, docs, UI, and public communication.

## Name

- **Canonical:** `Jarvis Agents` — two words, title case, both capitalized
- **Short form:** `Jarvis` — acceptable only in casual contexts (tweets, social); never in docs or commits
- **Code identifier:** `jarvis-agents` — kebab-case, lowercase, used for repo, npm package, Docker image
- **Never use:** `jarvisagents`, `JarvisAgents`, `JARVIS`, `forge` (internal codename, retired for OSS)

## Tagline

**Primary:**
> Remote-control your local Claude Code.

**Secondary (developer-facing, community posts):**
> GitHub self-hosted runners, for Claude Code.

**Rhythmic (tables, feature lists, footer):**
> Webhook in. Pipeline out. Every job on record.

Lead with the action ("remote-control") — it's the concrete value. Avoid "open-source project management + AI agent platform" which under-sells what we actually do.

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
| Repo / npm / Docker image | `kebab-case` | `jarvis-agents` |
| TypeScript files | `camelCase` | `userStore.ts` |
| TypeScript exports (classes, React components) | `PascalCase` | `UserStore`, `IssueList` |
| TypeScript functions, variables | `camelCase` | `fetchIssues`, `currentUser` |
| REST API paths | `kebab-case`, plural | `/api/projects`, `/api/agent-sessions` |
| Database tables | `snake_case`, plural | `projects`, `agent_sessions` |
| Environment variables | `SCREAMING_SNAKE_CASE` | `DATABASE_URL`, `FORGE_API_KEY` |
| Feature flags | `FEATURE_` prefix | `FEATURE_AI_CHAT`, `FEATURE_WIDGET_V2` |
| Git branches | `type/short-description` | `feat/oauth-login`, `fix/ws-reconnect` |
| Issue IDs | `ISS-<number>` | `ISS-42` |

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) — required.

Format: `type(scope): description`

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `style`, `revert`.

Scopes (required unless root-level change): the package touched — `strapi`, `web`, `dev`, `forged`, `agent-core`, `app` (paused), `docs`, `ci`.

Examples:
```
feat(strapi): add OAuth2 device flow endpoint
fix(web): resolve WebSocket reconnect race
docs(readme): update quickstart for v0.2
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
feat(strapi): introduce agent session streaming

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
| TypeScript style | ESLint + Prettier per package |
| Commit messages | commitlint hook (Phase 1) + PR title check in CI |
| File/folder naming | Linted via custom ESLint rule (later) |
| Error message format | PR review |
| Brand voice | PR review, BRAND.md referenced in CONTRIBUTING |
