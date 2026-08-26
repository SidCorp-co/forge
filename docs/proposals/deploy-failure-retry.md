# Should a failed deploy retry itself?

Status: **Open decision, no code proposed** · Raised by ISS-854 · Verified against the tree
2026-08-26

ISS-854 removed one cause of transient deploy failure by vendoring the two Google fonts the
`web-v2` build used to download. It deliberately did **not** answer the more general question
that incident raised, because that question is a policy call about the release step rather than
a defect anyone can fix in a diff:

> When a deploy fails on what looks like a transient build error, should Forge re-dispatch it
> automatically, or should it stay a manual re-dispatch?

This file exists so the question has an owner-visible home instead of living in one issue's
comment thread.

## What happens today

Nothing retries. Verified 2026-08-26:

| Mechanism | Where | What it actually does |
|---|---|---|
| Deploy dispatch | `packages/core/src/integrations/coolify/adapter.ts` | Fires once. A failure is recorded and the run advances no further. |
| Circuit breaker | `packages/core/src/integrations/coolify/circuit-breaker.ts` | 3 failed outbound deliveries in 5 minutes opens the breaker; a 10-minute cooldown then allows one half-open trial. This **suppresses** dispatch — it is the opposite of a retry. |
| Job recovery | `pipelineConfig.recoveryByFailureKind` | Re-dispatches a crashed **job** (`transient: 5`, `unknown: 2`, `permanent: 0`). A deploy that ran and reported failure is not a crashed job, so this never fires for it. |

So "manual re-dispatch" is the current behaviour by **absence**, not by decision. Nobody chose
it, which is exactly why writing it down matters more than it looks.

## The cost that was actually measured

From the 2026-08-13 incident (ISS-854's evidence table):

- Deploy `zs4ocksc8sokkcw0g0g0w4s0` failed at 03:17Z on a font fetch.
- Commit `eab3b160`, a core-only classifier fix, sat merged-but-not-live for **~90 minutes**.
- The failure was first read as a defect in the diff being deployed, costing a 38-minute `fix`
  job (`29aba157`) that correctly concluded "not the diff".
- Redeploying the identical code at 04:38Z succeeded in 7.8s.

## The two options

**A — automatic re-dispatch on a classified-transient failure.** Recovers the 90 minutes
without anyone watching. The problem is classification: at the dispatch layer a transient
build failure and a genuinely broken diff produce the same signal — a non-zero exit from a
build. Retrying the second spends builder capacity on a build that cannot succeed, and
converts a hard, legible failure into something that reads as flakiness. It would also have
to be reconciled with the circuit breaker, which is trying to do the opposite.

**B — keep it manual, and fix the notice instead.** The 90 minutes were not lost because
nothing retried; they were lost because **nothing said anything**. A failed deploy that
surfaces immediately — on the issue, in the run, wherever release duty is actually looking —
costs one human decision and keeps the failure honest. This is the smaller change and it
degrades better: a wrong notification is noise, a wrong retry is spent capacity plus a
misleading history.

## Recommendation, not a decision

B, and specifically the notice half of B rather than any retry work. Recorded here by the
agent that worked ISS-854; it is a human's call, and nothing in the tree depends on it being
made. If A is chosen, the classification rule is the whole design — a retry that cannot tell
the two failure shapes apart is worse than no retry.

## What ISS-854 did settle

Only the font-specific cause: `packages/web-v2/src/app/layout.tsx` no longer reaches a font
host at build time, so this particular transient failure cannot recur. See
[../../packages/web-v2/src/app/fonts/README.md](../../packages/web-v2/src/app/fonts/README.md).
