# Open policy calls — awaiting the maintainer

Four questions that pipeline stages raised, could not answer themselves, and had
been parked as `draft` issues where nobody would find them. Each one is a
*policy* call: the code that prompted it is spec-conformant, so there is no
defect to fix until someone decides what the behaviour should be.

**Status:** pending sign-off. Answer a section and it becomes an issue that
passes the four gates ([what-is-an-issue](../guides/what-is-an-issue.md)), or a
recorded decision and this section is deleted.

> Filed here rather than as issues because an answer is not a deliverable — see
> the routing rule in the guide. A better channel for "an agent needs the owner"
> is a separate, open design question; this file is the interim home.

---

## 1. Park or defer when every runner is briefly rate-limited

*Raised twice in ISS-823 review · was `draft` ISS-832*

**Today:** `jobs/retry.ts` (the `isFailoverAction` branch) parks the issue at
`waiting` with `all_devices_exhausted` whenever every online, capable runner has
any `rate_limited_until` in the future. It does not look at how far in the
future. This is what ISS-823's AC #3 asked for.

**Why it needs a call:** the trigger spans very different durations — a spend cap
is 6h and a parsed usage-limit reset up to ~24h (parking is reasonable), but a
provider `Retry-After` is often seconds to minutes. On a single-runner fleet the
condition is met by the *first* limit-class failure, so a 2-minute throttle parks
the issue and closes the run where the rotation used to just wait it out. That is
a new source of interventions-per-issue — the metric the kernel lane exists to
drive down.

**Options:** (a) keep park-on-any-future-limit, simple and matches the AC as
written; (b) defer instead of park when the soonest reset across the online fleet
is within a threshold — schedule the retry at that reset and let the round budget
bound it.

If (b): does the threshold live with `SPEND_LIMIT_COOLDOWN_MS` /
`DEFAULT_LIMIT_COOLDOWN_MS` in `runners/limit-detect.ts`, or with the retry
constants in `jobs/retry.ts`?

## 2. Does a human's field edit answer a `needs_info` bounce?

*Raised by ISS-820 review round 3 · was `draft` ISS-834*

**Today:** `pipeline/bounce-replay-guard.ts` releases a `needs_info` bounce only
on a human-authored *comment* (`is_ai = false AND author_device_id IS NULL`),
per ISS-820 AC #2. The activity-log fallback was dropped for that branch.

**The narrowing:** a human who answers by *editing* the issue — rewriting
`acceptanceCriteria` or the description — no longer releases the bounce. They
edit, move the issue forward, the dispatcher finds no human comment since the
bounce, and routes it straight back to `needs_info`. Repeating the move repeats
the bounce.

**Two questions, independent:**

1. Should a human-authored `issue.updated` activity row (distinguishable from an
   agent edit via `activity_log.actor_type`) count as answering? Or is "answer in
   a comment" the intended, enforced contract?
2. Should the guard post a short comment when it routes an issue back? Today the
   bounce-back is log-only, so from the UI it is a silent revert — one comment
   insert turns an undiagnosable flip into a legible one. This looks worth doing
   whichever way (1) goes.

**Pointers:** `bounce-replay-guard.ts` (`hasHumanAnswerSince` vs
`hasAnyInputSince`) · `pipeline/orchestrator.ts` (the call site that routes back
without commenting) · `issues/routes.ts` (where `issue.updated` is recorded).

## 3. Does the UX Contract inbox need an edit-text action?

*Raised by ISS-577 review · was `draft` ISS-842*

**Today:** ISS-577 AC #5 asked for three inbox actions — approve, reject, and
edit text. The approved plan narrowed it to approve + reject, and the shipped tab
has no edit affordance. The backend already accepts it (`rulePatchSchema` takes
`text`).

**Why it needs a call, rather than being a missing feature:** the point of ISS-577
is a "choose, not write" surface (AC #20: *all without writing free text*). An
edit-text box is exactly the free-text field the issue set out to avoid.

**Options:** (a) drop it — amend the ux-contract AC template so `edit` is not
expected here; a wrong proposal is rejected, not reworded; (b) a constrained
edit — severity and group re-assignment only, still choosing; (c) the full text
editor, accepting the free-text exception for admins reviewing wording.

## 4. What counts as shipped-evidence in the progress kernel?

*Raised in ISS-671 review round 2 · was `draft` ISS-817*

**Today** — `issues/progress.ts`, `computeProjectProgress`:

```
hasShippedEvidence = (activity_log has a transition INTO baseBranch|productionBranch)
                  OR (issues.merged_at IS NOT NULL AND activity_log has a transition
                      INTO developed|testing|tested|released)
```

**Why the second disjunct says less than it looks like.** `markMergedOnClose`
(`issues/merged-at.ts:144`, shipped 2026-07-13 in `a1acc1b7`, called from
`apply-transition.ts:210`) stamps `merged_at = now()` on *every* transition to
`closed` where the column is NULL, from any surface. So for a `closed` row
`merged_at IS NOT NULL` is nearly always true, and the disjunct reduces to
**`closed AND ever reached developed ⇒ shipped`**.

**Verified on Postgres 16 against the emitted SQL**, four seeded rows — not
assumed:

| issue | history | `merged_at` | bucket |
|---|---|---|---|
| i1 | only ever `developed`, then closed | set (close auto-stamp) | **shipped** |
| i2 | closed, no history | null | closed_unshipped |
| i3 | reached `released` | set | shipped |
| i4 | `in_progress` | null | in_flight |

i1 is an issue whose code never merged, reported to stakeholders as "shipped
(released to production)".

**The tension.** ISS-671's AC #3 says two things that no longer agree: its prose
wants "closed *with evidence the code reached the base branch*" (the close
auto-stamp is not that evidence), while its measurement — "33/85 closed on
forge-dev" — was counted as `mergedAt === null`, which treats `merged_at` as the
shipped proxy and would also count i1. The implementation matches the
measurement, not the prose.

**Options** (ideally decided with the live number in hand):

1. **Keep as-is** — accept that a post-code close counts as shipped, and fix
   AC #3's prose to match.
2. **Discriminate the auto-stamp** — require `merged_at` to *predate* the
   `closed` transition (a genuine base-merge stamp is strictly earlier; the
   auto-stamp is simultaneous); or key off the audit comment
   `apply-transition.ts:262` writes when it auto-stamps; or drop `merged_at`
   from the predicate and require a transition OUT of the merge state.
3. **Narrow to review round 1's predicate** (transition into the merge state
   only) and accept the under-report on hand-merged / owner-lane closes.

Whichever is chosen, measure `shipped` / `closedUnshipped` on forge-dev before
and after, and report both. Review round 1 (`62d3fd40`) already asked for that
number; the fix step could not reach a live DB from its sandbox, so it is still
unmeasured.

**Related, already shipped this session:** closing an abandoned issue stamps
`merged_at` and releases its `blocks` dependents — which is why the issue guide
and the job preamble now pair `closed` with `unmark` for anything that turns out
not to be work. That was the half needing no policy call.
