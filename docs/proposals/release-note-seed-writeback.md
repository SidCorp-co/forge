# The release step must write its seed back before it closes

Status: open residual, out of this repo's reach
Found: 2026-08-30, in the independent review of ISS-880

## What is wrong

Since ISS-880, `transitionIssueStatus` refuses an automated close while `issues.release_notes` is
null (`RELEASE_RECORD_REQUIRED`, `packages/core/src/issues/release-record-required.ts`).

A release step that handles a null note by **deriving a line, appending it to `CHANGELOG.md`, and
closing** — without persisting the derived value back to the typed field — now gets refused, with an
error saying nothing was written. At that moment the error is false: a line *was* written, to the
file. The agent's remedy is one `forge_issues.update`, so nothing is stranded, but the message it
reasons from is wrong, and a wrong message is the thing this repo treats as worse than none.

## Where it is, and why it is not fixed here

Not in this repo. The copies this tree owns are already correct:

- `packages/core/skills/forge-release/SKILL.md` — step 7.5 persists `releaseNotes` back to the typed
  field **before** appending, and says so in those words.
- The `forge-pipeline-skills` bundles on disk (`bundles/*/skills/forge-release`,
  `profiles/pnpm-monorepo-tbd-local/overlays/forge-release`) read the field and contribute nothing
  when it is null. They never derive, so they never make the false claim — they simply hit the
  refusal, which is the intended, self-describing failure.

The copy with the derive-and-close backstop is a **server-registered** skill body, which lives
outside this repository and outside the pipeline's write permissions on this project
(`mcp__forge__forge_skills_update` is in `disallowedTools` for every state).

## The fix, for whoever holds that copy

In the step that handles `releaseNotes: null`, persist the derived value before the close:

```
forge_issues → update → { documentId, data: { releaseNotes: { section, userFacing, technical? } } }
```

That is the same order `packages/core/skills/forge-release/SKILL.md` already uses, and it is the
order `forge_issues.update` supports in a single call: field writes commit before the status
transition (`packages/core/src/mcp/tools/forge-issues.ts`, the two `cm:edge ordering` lines).

## Honest costs

| Choice | What it takes |
|---|---|
| Fix it (persist the seed before closing) | one extra `forge_issues.update` on the path where a release step had to invent the note itself — a write the field's existence always implied, now mandatory |
| Leave it | one confusing round per affected close: the step appends its line, is refused, reads an error saying nothing was written, and must work out that the field and the file are two different records before it can proceed. Recoverable every time, which is exactly why it survives unfixed |
| Drop the refusal instead | the whole of ISS-880's second outcome. Not on the table |
