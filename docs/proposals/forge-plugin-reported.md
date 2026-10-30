# forge-plugin defects seen from core

**Removed when:** ISS-779's close-out has filed each entry below on forge-plugin, or the entry no
longer holds there.

forge-plugin (github.com/SidCorp-co/forge-plugin) is reached by issue, never by diff, and `forge
feedback` is off on this lane. Each defect below was met by a run in this repository's projects. It
waits here for whoever files it there. Core's own half of each, where it has one, is named and
already shipped. Paths are the plugin's `src/`, as cached at version 3.36.542.

When an entry is filed on forge-plugin, delete it here. Delete it too when the plugin no longer
does what it says.

## `forge record verdict` and `finding` send the criterion's whole line

`flow/record/record.mjs:quoteCriteria` rewrites `--criterion N` to `criterion: N — <the line as it
stood>`, the whole line with nothing cut, into the field where only the number is read. Core refused
it at both verdict doors under `verdict-criterion`: adminhub-fe FB-364 and FB-365, and the
adminhub-api judges and builders of ISS-49, ISS-83, ISS-84 and ISS-85 (2026-10-29/30, FB-380). A
long line was then refused `field-budget` at the comment door instead: adminhub-api ISS-49's
criterion 1 lists 59 GET paths in 2,572 characters against the 400 every record field holds
(adminhub-api master, 2026-10-30).

- **Core's half (shipped):** a number leading a label (`1 — <text>`, `1. <text>`) names that
  number, and the label is not read. A criterion's exact line with no number still resolves to its
  number (`messaging/criterion-named.ts:criterionNamed`). Any other text is refused, listing the
  criteria. The label after a leading number is not held to the field budget, nor to the 2,000
  characters `POST /api/issues/:id/verdicts` caps a line at (`criterionLeadingNumber`).
- **Plugin's half:** send the number alone in `criterion`, and keep the quote for the heading a
  person reads.

## A record writes the lease and its evidence before core has screened it

`forge record verdict` on adminhub-api ISS-85 (2026-10-30T03:24:23Z) took the issue's lease
(`sessionContext.lease`, `how: write`) for `judge-iss-85-62555939b`, an id the run did not ask
for. It then uploaded `evidence-commit.txt` as an attachment of the issue. Only then did it post
the record, which core refused (the clipped criterion above). The refused record left the
attachment and the lease behind. Posting a comment takes no lease at core: the lease row's history
names the plugin's write, half a second before the upload.

- **Plugin's half:** check what it can locally before writing anything, and take the lease under
  the run id the brief holds.
- **Core:** has no door that screens a record without storing it, so nothing on core's side
  orders these writes.

## `forge resume` reads no record when prose follows the tag line

`flow/machine/block.mjs:TAG` is anchored to the end of the whole body (`$` without the `m` flag).
A comment that puts a sentence after `` `forge-record: verdict · contract 1` `` therefore yields no
record to `parseAll`. adminhub-api ISS-49 (FB-380) shows it:

- Comments `339158aa`, `8eee7fb5`, `8837cbc3` and `9ac66e53` (2026-10-30T03:12Z) each end with a
  sentence after the tag. The plugin read none of them, and `forge resume` showed every criterion
  as none.
- Comment `26778a2d` (a finding) ends on its tag and was read.
- Core read all four. Criteria 1 and 3 hold them as latest (`record.verdict` events under run
  session `a5600520`, the declared qa run). For criteria 2 and 4 the resends were answered as
  repeats of that run's earlier verdicts, and no new row was written.
- Core's requirement coverage names why none counts yet: the production build declares no source
  probe, so whether it holds commit `6369aae6d` cannot be read.

- **Plugin's half:** match the tag per line (`m`), as `FIRST_TAG` already does.

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

- **Three spellings at the verdict doors:** core now accepts a number leading a label and a
  criterion's exact line as well as the number. A reader that compares a verdict's raw `criterion`
  field must expect text, until the plugin sends numbers and this shim can be weighed for removal.
- **A label is trusted to its number:** `3 — <the line of criterion 2>` records on criterion 3. The
  label is the plugin's quote of the line it numbered, so they agree when the plugin writes it. A
  hand-written mismatch is not caught.
- **Waiting on whoever files it:** each entry here waits for someone to file it on forge-plugin.
  Until then the plugin's halves stay unfixed, and runs keep paying for them:
  - the judges on ISS-49, ISS-83, ISS-84 and ISS-112 re-sent verdicts core already held;
  - a refused `forge record` leaves an attachment and a lease that no record cites;
  - a judge given an invented id is refused once before it finds the declared one.
