# forge-plugin defects seen from core

**Removed when:** ISS-779's close-out has filed each entry below on forge-plugin, or the entry no
longer holds there.

forge-plugin (github.com/SidCorp-co/forge-plugin) is reached by issue, never by diff, and `forge
feedback` is off on this lane. Each defect below was met by a run in this repository's projects. It
waits here for whoever files it there. Core's own half of each, where it has one, is named and
already shipped. Paths are the plugin's `src/`, as cached at version 3.36.542.

When an entry is filed on forge-plugin, delete it here. Delete it too when the plugin no longer
does what it says.

## `forge record verdict` sends the criterion's whole line

Where a criterion's line opens with a trace tag, `forge record verdict` writes
`criterion: (REQ-8 BC-1) A reload shows every saved card` instead of its number. Both of core's
verdict doors refused it: adminhub-fe FB-364 and FB-365, and the adminhub-api builders of ISS-83 and
ISS-84 (2026-10-29/30).

- **Core's half (shipped):** the exact line, with or without `n. ` and its tag, now resolves to its
  number (`messaging/criterion-named.ts:criterionNamed`). Any other text is refused, listing the
  criteria.
- **Plugin's half:** send the number.

## The legacy status ladder

`flow/earned.mjs:ORDER` walks `open, confirmed, approved, in_progress, developed, testing,
awaiting_release, closed`. Core holds ten statuses
(`@forge/contracts/issue-machine:ISSUE_STATUSES`) and refuses `confirmed`, `developed` and `testing`
as `ISSUE_STATUS_LEGACY`. So the plugin's next rung after `open` is a move core refuses.

- **Plugin's half:** walk core's edges (`open → in_progress`, then `awaiting_release`). Do not walk
  a ladder of its own.

## A judge is told to set its own `FORGE_SESSION_ID`

`flow/qa/verdicts.mjs:judgeAsk` prints `FORGE_SESSION_ID=<an-id-of-its-own> forge record verdict …`
to a judge whose session was inherited. The adminhub-fe ISS-112 judge therefore ran as
`iss-112-judge-r3-56952`, an id no box declared. The brief had handed it `iss-112-15f8ba01` for
declared run `719fa76d-a9b1-4867-aa29-23223497df0f`. Core refused it `VERDICT_RUN_UNKNOWN`. The
runner sets no `FORGE_SESSION_ID`: the value came from that printed command.

- **Core's half (shipped):** the refusal now lists the runs the caller's box declared live over the
  issue (`issues/pattern-runs.ts:runOfCall`).
- **Plugin's half:** print the declared run id the brief holds. Do not ask for an invented one.

## `forge advance --owed` reads none of the tag-on-fence verdicts

`flow/record/page.mjs:assemble` gathers verdicts through `parseAll`. That reads only a fence
followed by its tag line (`` `forge-record: verdict · contract 1` `` after the closing fence). Core
also reads the tag on the opening fence (```` ```forge-record: verdict · contract 1 ````,
`messaging/forge-record.ts`, the form a markdown writer types), and records those verdicts.

adminhub-fe ISS-112 (issue `ceb84109-297d-4de8-b90e-a2962936e611` on dev) shows the result:

- Comment `bccbf859-fc6d-465b-b685-706e52ce248c` (2026-10-30T02:01:03Z) carries passes on criteria 8
  and 13 at runtime `7fbc79c2…`, both in that form.
- Core's latest verdict on both is `pass`.
- The plugin's own `assemble` over the same comments still holds the 23:20 `skipped` as latest. So
  `--owed` says "criterion 8 was skipped (…), and nothing on the record says it has been judged
  since" and the same for 13.

adminhub-api shows the same reading on two judges' comments, both written in that form:

- ISS-84, comment `120c6062-0e34-4da0-bfdc-50f3de6692cc` (16 fences, 2026-10-30T01:48:55Z).
- ISS-83, comment `3fda38cd-18bb-4e36-a4c3-52322a31d4a1` (5 fences, 02:08:28Z).

Core recorded every fence: 16 and 5 `pass` verdict events carry those comment ids. The plugin's
`parseAll` reads 0 records from either body, so `forge resume` read no verdict and the judges
re-sent each one through `POST /verdicts`.

- **Plugin's half:** read both fence forms. Better, read verdicts from core
  (`GET /api/issues/:id/criteria`, each criterion's `latest`), not from comment text.

## Honest costs

- **Two spellings at the verdict doors:** core now accepts a criterion's exact line as well as its
  number. A reader that compares a verdict's raw `criterion` field must expect text, until the plugin
  sends numbers and this shim can be weighed for removal.
- **Waiting on whoever files it:** each entry here waits for someone to file it on forge-plugin.
  Until then the plugin's halves stay unfixed, and runs keep paying for them:
  - the judges on ISS-83, ISS-84 and ISS-112 re-sent verdicts core already held;
  - a judge given an invented id is refused once before it finds the declared one.
