# `dropped` as the taught discard

Status: Open residual — surfaced by ISS-787, 2026-08-27. Not implemented; needs an owner decision
before any of it lands.

## The residual

`dropped` closes an issue **without** stamping `merged_at`. That is its entire reason to exist:
`closed` stamps, and the stamp releases every `blocks` dependent as if the work had shipped, so
closing something abandoned silently unblocks work that is still genuinely blocked.

Every agent-facing surface still teaches the workaround instead of the status:

| Surface | What it says today |
|---|---|
| `packages/core/src/guides/registry.ts` — guide `what-is-an-issue` | "`closed` when it is not work at all", then "Closing non-work needs `unmark`" |
| `.forge/orientation.md` (injected into every prompt on this project) | same row |
| `packages/core/src/prompt/facts/registry.ts` | same, and it is **pinned byte-for-byte** by `rule-parity.test.ts` and `registry.test.ts` |

So the taught path is: stamp the wrong thing, then remember to unstamp it. A reader who forgets the
second half has unblocked work that should still be blocked, and nothing tells them. `dropped` makes
the whole dance unnecessary and cannot be forgotten halfway.

ISS-787 fixed the narrower half of this — the **counted** claim. Three places said a `draft` has
"three exits" and listed `closed` as the discard; those now say four and name `dropped`
(`registry.ts` guide `pipeline-and-issue-lifecycle` v7, guide `what-is-an-issue` v2). The
**advice** was left alone deliberately, for the reason below.

## Why it was not just fixed

Two of those three surfaces are injected into the system prompt of every agent on every project the
fleet serves, and one of them is pinned byte-for-byte by parity tests. Rewriting what agents are
told to do with non-work is a change to fleet-wide operating guidance authored by the owner, not a
correction of a factual error — and the two are not the same kind of edit. `dropped` also does not
behave identically to `closed` + `unmark`: dependents are freed by **edge expiry**
(`expireBlocksEdgesOnDrop`) rather than by never being stamped, so the substitution needs to be
checked against the dependency reader before it is taught, not after.

## What would settle it

1. Confirm `dropped` + edge expiry is behaviourally equivalent to `closed` + `unmark` for every
   `blocks` dependent, including one already dispatched. If it is not, the guidance stays as it is
   and this proposal is retired instead.
2. If it is, change the four surfaces in one commit — the prompt registry, its two parity tests, the
   affordances guide, `orientation.md` — so no surface teaches one exit while another teaches the
   other. A partial rollout is worse than none: two guides disagreeing about which status discards
   an issue is exactly the class of defect ISS-787 was filed about.
3. Keep `closed` + `unmark` documented as the repair for an issue **already** closed by mistake.
   That path stays correct; it just stops being the recommended one.
