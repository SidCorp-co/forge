# `no-developer-detail` admits a bare file path and a commit sha

Found while building ISS-1089's labelled lead corpus, and left here rather than fixed because
closing it moves a cell that issue puts out of scope.

## What was measured

5,884 opening sentences taken verbatim from every `forge-record` field on ISS-910 to ISS-1089.
The product-lens screen refuses 92 of them. Of the 66 in `packages/core/src/messaging/lead-corpus.json`,
every refusal is either a path carrying a line number or a raw pipeline status word.

Two shapes go through that a reader holding no technical lens should not be shown:

- **A file path with no line number.** `PATH_LINE_RE` in `packages/core/src/messaging/text-rules.ts`
  is anchored on `\.[a-z]{1,5}:\d+`, so `registry.test.ts still asserted the old combined message`
  and `conversation-thread.tsx's cm:guard says …` are admitted while `search.ts:158` is refused.
  Corpus rows 2, 14, 22 and 34 are the admitted ones.
- **A commit sha.** No rule reads one. `23 of 23 checks pass at fa6ecb212` and `merged at ca28999e`
  are admitted (corpus rows 0 and 42).

## Why it was not fixed in ISS-1089

`NO_DEVELOPER_DETAIL` is read by `public:report` as well as by the new `role:product:report`, and
`public:report`'s behaviour is frozen by `legacy-verdicts.fixture.json`. ISS-1089 names that
baseline, and the rule order inside an existing cell, among the things it does not change. Widening
the regex here would move the stakeholder chat reply screen, which nobody asked about, and red the
differential test by design.

## What closing it would take

Either a widened `PATH_LINE_RE` plus a regenerated `legacy-verdicts.fixture.json` with the
difference read row by row, or a second rule that only the lead cells carry — which is the cheaper
half, because a lead is one sentence and the false-positive cost a whole reply would pay is not
paid there. The corpus is already the instrument: the rows above are labelled with what the screen
does today, so a change to either rule shows up as an exact-equality failure naming its own row.
