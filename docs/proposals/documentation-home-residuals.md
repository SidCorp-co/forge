# Documentation-home residuals

**Removed when:** the no-audience branch of `coreAudience` is deleted, which dev ISS-135 carries.
The change that lands it deletes this file.

**ISS-1178, 2026-09-27. A priced amnesty the audience rule leaves standing.**

ISS-1178 made every served documentation page declare its `audience`, as
`docs/modules/guides/where-a-page-lives.md` states. Where a deployment does not meet the rule yet it
is named rather than passed, here and in the code that tolerates it.

## A core that predates the field serves guides with no audience

Live core runs behind `main`: measured on 2026-09-26 against `forge-beta-api.sidcorp.co`, every
entry of `GET /api/guides` carried `slug`, `title`, `summary` and `version` and nothing else. A web
build carrying ISS-1178 that reaches production first would otherwise refuse every agent guide and
take the public documentation down with it. `coreAudience` in
`packages/web-v2/src/features/guides/corpus.ts` places a guide with no audience behind the agent door
and says so on the server log, naming the guide. A guide with any other value is refused outright.
It ends when the core the web talks to serves `audience` on every guide, and the branch is then
deleted rather than kept as a fallback.

## Honest costs

- The absent-audience branch is a second live path in `fromGuide`. While it stands, a core
  regression that dropped the field from the guide response would be absorbed with a log line
  rather than refused, and nothing but that log line would show it.
- Removing the branch is owed by whoever next touches `corpus.ts` after core is redeployed, and no
  check fires when that moment comes; the reminder is this file, the one-line comment above the
  branch that points at it, and the warning the branch logs.
