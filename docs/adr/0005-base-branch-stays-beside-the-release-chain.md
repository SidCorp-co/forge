# 0005 — `base_branch` stays beside the release chain

**Status:** accepted · **Date:** 2026-09-28 · **Supersedes:** none · **Amends:**
[ADR 0003](0003-a-release-chain-replaces-the-release-model-enum.md)

## Context

[ADR 0003](0003-a-release-chain-replaces-the-release-model-enum.md) named four columns on `projects`
as one fact spelled four ways: `release_model`, `base_branch`, `live_branch` and `release_strategy`.
Its decision then replaced three of them with `releaseChain` and never said whether the fourth,
`base_branch`, survives. A reader finishing that ADR could not tell, and the issue that built the
chain (ISS-1311) said four columns were replaced, pointing the wrong way.

Which columns a decision retires is the owner's call, so the build run reported the gap rather than
resolving it. The owner decided on 2026-09-28. That decision was first written into ADR 0003
itself; it is recorded here instead because an accepted ADR's decision is not rewritten
([`README.md`](README.md)).

## Decision

**`base_branch` stays.** It is the project's **default work branch**: where an `ISS-*` branch is cut
from, and where it lands unless that issue overrides the target.
`packages/core/src/branches/resolve.ts:resolveIssueBranches` falls `targetBranch` back to it when an
issue's `metadata.branchConfig` names none — the override moves one issue, never the project's
default. So it is a fact about where WORK goes, while the chain is a fact about where a RELEASE
goes. A project that ships nothing still cuts branches. Folding the column in would map every such
project to `[]`, which names no branch, and leave `resolveIssueBranches` with nowhere to cut from,
*silently*. Measured when this was decided, 2026-09-27: of 37 fleet projects, **28 declare no
release while carrying a base branch**.

**Where a project does declare a release, the chain's first entry and `base_branch` name the same
branch**, and that is the one place the two must agree. It is held at the write door by
`packages/core/src/projects/release-chain.ts:RELEASE_CHAIN_BASE_MISMATCH`, which refuses the pair by
name and says which shape is valid — not by a CHECK. The CHECKs ADR 0003 removes existed to stop
two spellings of ONE fact contradicting each other; these are two different facts that meet at one
branch name, and a refusal a caller can read is the right instrument for that where a constraint is
not.

## Consequences

- ADR 0003's premise that the four columns were one fact holds for three of them. `base_branch` is a
  second fact, and this ADR is where that is decided.
- A project carries two release-shaped columns, `base_branch` and `release_chain`, and one refusal
  keeps them consistent where they meet.
- A later change that folds `base_branch` into the chain reverses this ADR and owes one of its own.
