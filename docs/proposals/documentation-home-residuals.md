# Documentation-home residuals

**ISS-1178, 2026-09-27. Two priced amnesties the audience rule leaves standing.**

ISS-1178 made every served documentation page declare its `audience` and put each audience's voice
rule under a check, as `docs/modules/guides/where-a-page-lives.md` states. Rewriting page content
was outside that issue, so where a page or a deployment does not meet the rule yet it is named
rather than passed, here and in the code that tolerates it.

## One assistant-setup page does not meet its step rule

`connect-an-assistant/when-it-does-not-work` is written for someone connecting an assistant, and
the rule for that reader is that every numbered step ends in something they can see. Its three fix
procedures hold nine numbered steps and none ends in a `**Check:**` line. `STEP_RULE_EXEMPT` in
`packages/web-v2/src/features/docs/help-assistant-setup.test.ts` names it, so the audience-wide check
passes over it, and the same file fails the moment the page meets the rule so the exemption cannot
outlive the gap. It ends when each of those steps says what the reader should now see.

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

- Until `when-it-does-not-work` is rewritten, a reader following one of its fix procedures still
  reaches a step with nothing to check it against, which is the exact failure the step rule exists
  to prevent, on the page a reader opens precisely because something already went wrong.
- The absent-audience branch is a second live path in `fromGuide`. While it stands, a core
  regression that dropped the field from the guide response would be absorbed with a log line
  rather than refused, and nothing but that log line would show it.
- Removing the branch is owed by whoever next touches `corpus.ts` after core is redeployed, and no
  check fires when that moment comes; the reminder is this file, the one-line comment above the
  branch that points at it, and the warning the branch logs.
