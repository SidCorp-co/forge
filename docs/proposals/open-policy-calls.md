# Open policy calls — awaiting the maintainer

Four questions pipeline stages raised and could not answer themselves. Each is a
*policy* call: the code that prompted it is spec-conformant, so there is no defect
to fix until someone decides what the behaviour should be.

**Status:** pending sign-off. Answer a section → it becomes an issue that passes
the four gates ([what-is-an-issue](../guides/what-is-an-issue.md)) or a recorded
decision, and the section is deleted. When all four are answered this file is
deleted and the decisions live in the module docs they belong to.

> Filed here, not as issues: an answer is not a deliverable. A better channel for
> "an agent needs the owner" is a separate open design question; this is interim.

---

## 1. Park or defer when every runner is briefly rate-limited

*ISS-823 review, twice · ex-`draft` ISS-832*

`jobs/retry.ts` (`isFailoverAction`) parks at `waiting` with
`all_devices_exhausted` whenever every online runner has any future
`rate_limited_until` — it never checks how far. Cooldowns range from a 6h spend
cap to a seconds-long provider `Retry-After`, and on a single-runner fleet the
first limit-class failure trips it. So a 2-minute throttle now parks the issue and
closes the run where the rotation used to wait it out — new interventions-per-issue.

**Decide:** keep park-on-any-future-limit, or defer when the soonest reset is
within a threshold? If defer — threshold next to the cooldowns in
`runners/limit-detect.ts`, or with the retry constants in `jobs/retry.ts`?

## 2. Does a human's field edit answer a `needs_info` bounce?

*ISS-820 review round 3 · ex-`draft` ISS-834*

`pipeline/bounce-replay-guard.ts` releases a bounce only on a human-authored
*comment* (ISS-820 AC #2). A human who instead **edits** the issue —
`acceptanceCriteria`, the description — no longer releases it: they edit, move the
issue forward, and the dispatcher routes it straight back to `needs_info`.

**Decide (a):** should a human-authored `issue.updated` (distinguishable via
`activity_log.actor_type`) count as answering, or is "answer in a comment" the
enforced contract?

**Decide (b), independent:** should the guard post a comment when it routes back?
Today it is log-only, so from the UI the issue silently flips. One comment insert
fixes it. **This half looks like a plain defect, not a policy call** — it can ship
either way (a) goes.

## 3. Does the UX Contract inbox need an edit-text action?

*ISS-577 review · ex-`draft` ISS-842*

AC #5 asked for approve / reject / **edit text**; the plan narrowed it to
approve + reject and the shipped tab has no edit. The backend already accepts it
(`rulePatchSchema` takes `text`). But ISS-577's whole point is "choose, not
write" (AC #20: *all without writing free text*) — an edit box is that field.

**Decide:** (a) drop it and amend the ux-contract AC template; (b) constrained
edit — severity + group re-assignment only, still choosing; (c) full text editor,
accepting the exception for admins.

## 4. What counts as shipped-evidence?

*ISS-671 review round 2 · ex-`draft` ISS-817*

`issues/progress.ts` counts an issue shipped on a transition into the base branch
**or** (`merged_at` set AND ever reached `developed`). But `markMergedOnClose`
(`issues/merged-at.ts:144`) stamps `merged_at` on *every* close, so the second
disjunct reduces to "closed after reaching `developed`". Verified on Postgres 16
against the emitted SQL: an issue that only ever reached `developed`, then closed,
is reported as **shipped (released to production)** with no merge.

ISS-671's AC #3 disagrees with itself — its prose wants base-branch evidence, its
"33/85 closed" measurement used `mergedAt === null` and would also count that row.

**Decide:** (a) keep as-is and fix AC #3's prose; (b) discriminate the auto-stamp
— require `merged_at` to *predate* the close (a real merge stamp is strictly
earlier), or key off the audit comment, or require a transition out of the merge
state; (c) narrow to review round 1's predicate and accept under-reporting
hand-merged closes. Measure `shipped` / `closedUnshipped` on forge-dev before and
after — still unmeasured, round 1 asked for it.

**Already shipped, needed no call:** `closed` + `unmark` is now the required exit
for non-work, so an abandoned close no longer releases its `blocks` dependents.
