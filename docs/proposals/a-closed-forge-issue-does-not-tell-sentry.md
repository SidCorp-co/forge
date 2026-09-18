# A closed Forge issue does not tell Sentry

**Status:** open residual. The capability exists and is tested; nothing in the Forge lifecycle calls
it. No fix proposed here, because which Forge event may write to somebody else's tracker is a policy
decision rather than a missing function call.

**Found by:** ISS-1085 slice 4, while deciding whether the issue could close. It cannot: three rows
of its own contract table describe an outbound direction that no slice of the four was written to
build, and closing over them would stamp done across a spec half nobody has read.

## What is true today

ISS-1085's contract runs both ways. The inbound half is shipped — slice 3's scheduled pull and slice
4's webhook both turn a qualifying Sentry error into a Forge issue, and a regression reopens the
Forge issue rather than filing a second one. The outbound half is three rows:

| Forge event | Sentry should become | Built? |
|---|---|---|
| issue `closed` carrying `mergedCommitSha` | `resolvedInNextRelease` | no caller |
| release batch green, `verify.probes` confirm the SHA is live | `resolved` | no caller |
| issue `dropped` | `ignored` | no caller |

The *method* for all three landed in slice 2. `integrations/sentry/issues.ts` exports
`SENTRY_ISSUE_SET_STATUS` and `dispatchSentryOutbound` handles it, `types.ts:SENTRY_ISSUE_STATUSES`
carries all four values Sentry accepts, and the generic dispatch door
(`integrations/registry.ts:dispatchThrough`, reached from `integrations/queue.ts` and
`integrations/routes.ts`) can enqueue it today. An operator can make the call by hand right now.

What is missing is the trigger. Measured at `50fd563ab`: `grep -rn 'sentry.issue.set-status'` over
`packages/core/src` finds the constant, its two tests and nothing in `issues/`, `pipeline/` or
`release-batch/`. No Forge status transition, no release step and no close path enqueues it.

So the loop is open at one end. Forge learns that an error is happening; Sentry never learns that
somebody fixed it. From Sentry's side every issue Forge has ever closed is still unresolved, which
is exactly the "two systems side by side rather than a loop" the issue was filed against.

## Why no slice owns it

The issue body decomposes into four slices and names what each writes. Slice 2 is "dispatch methods:
read issue detail, set status" — the methods, and it delivered them. Slices 3 and 4 are the inbound
half. The wiring from a Forge lifecycle event to one of those methods appears in the contract table
and in no slice's "To write" column. That is a gap in the decomposition rather than a slice that was
skipped, which is why it is recorded here instead of being built under slice 4's plan: a change none
of slice 4's fifty-two criteria describes is a change no reader of this issue agreed to.

## The decision this needs, which is not an implementation detail

Writing to another team's tracker from a status transition is not the same kind of act as reading
from it. Three questions have to be answered before the code is obvious, and each changes what gets
built:

1. **Which close counts.** `closed` carrying `mergedCommitSha` is the contract's answer, and the
   issue's own spine argument rests on that column being the join key. But 75 of 84 recently merged
   issues carry `NULL` there (ISS-1085, comment `86330a86`), so a trigger keyed on it fires for
   roughly one close in nine. Either the trigger is keyed on something else, or the column gets
   fixed first, or the loop closes for a tenth of the work and nobody is told which tenth.

2. **`resolvedInNextRelease` versus `resolved`, and who says the SHA is live.** The contract is
   explicit that merged is not serving and that `verify.probes` is the only thing that knows. That
   makes the second row a release-batch concern, and ISS-1085 puts "changing the release batch"
   out of scope in as many words. So either this residual waits for a release-side owner, or the
   second row is dropped and Forge only ever says `resolvedInNextRelease`.

3. **What happens when Sentry refuses.** A status transition that enqueues an outbound dispatch has
   to decide whether a failed dispatch is the transition's problem. It must not be: a Forge issue
   that cannot close because Sentry is down is a Forge outage caused by somebody else's. The
   delivery log and the circuit breaker already exist for this, and the answer is probably "enqueue
   and forget, and let the breaker trip" — but that is a decision, and it should be written down
   before it is discovered during an incident.

## Honest costs

What adopting this takes from whoever adopts it:

- **A new writer into the transition path.** `issues/apply-transition.ts` is the kernel's single
  status writer and it is already the busiest guarded file in the repo. Hanging an outbound
  integration dispatch off it adds a side effect to every close on every project, most of which have
  no Sentry binding at all — so the cheap-path lookup ("does this project bind Sentry?") runs on
  every terminal transition Forge makes, or the hook lives somewhere later and less obvious.

- **A second system's state becomes a thing Forge can be wrong about.** Today a Forge close is a
  local fact. After this, a Forge close makes a claim inside somebody else's product, and every
  failure mode of that claim — a stale issue id, a rotated token, a target renamed in Sentry — turns
  into an operator question that begins "why does Sentry say…". The delivery log answers it, but
  only for somebody who knows to open it.

- **`mergedCommitSha` stops being decorative.** Question 1 above is only answerable by fixing that
  column or by accepting a trigger that fires one time in nine. Fixing it is its own piece of work
  in `issues/merged-at.ts` and the mark path, and it is a prerequisite rather than a nice-to-have:
  the join key is what the issue's whole "spine" argument rests on.

- **Reversibility is not symmetric.** Reverting the inbound half stops Forge learning things.
  Reverting the outbound half after it has run leaves Sentry issues resolved that Forge no longer
  believes are resolved, and nothing walks back to correct them. Whoever builds this should decide
  up front whether a revert owes a reconciliation pass, because deciding afterwards means deciding
  it against live data.

## What this residual does NOT block

Nothing in slices 0–4. The inbound loop is whole and independently useful: errors become issues,
re-sightings update them, regressions reopen them, and every refusal is named in the schedule run's
output or on the delivery row. This residual is why ISS-1085 does not close with slice 4, not a
defect in slice 4.
