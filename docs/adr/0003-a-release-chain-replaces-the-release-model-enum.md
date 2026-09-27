# 0003 — A release chain replaces the release model enum

**Status:** accepted · **Date:** 2026-09-27 · **Supersedes:** none

## Context

A project declares how its code reaches production through three columns on `projects`:
`release_model` (`none` | `promote` | `publish`), `live_branch` and `release_strategy`
(`merge-branch` | `cherry-pick` | `tag-mr`). A fourth, `base_branch`, stands beside them and is
read when a release is built, but is not part of the declaration — what it is, and why it is the
one of the four that stays, is under *`base_branch` is the fourth column and it stays* below.

Three readings say the three are one fact spelled three ways.

**The ledger already models a release as a sequence.**
`packages/core/src/db/schema-release-ledger.ts:RELEASE_ATTEMPT_STAGES` is
`['promote', 'deploy', 'verify', 'repair']`. A project with no second environment simply writes no
`promote` row. The ledger does not run a different algorithm; the config layer above it claims two
exist.

**Two CHECK constraints exist only to stop the columns contradicting each other.**
`packages/core/src/db/release-axes.ts` carries `release_model <> 'promote' OR live_branch IS NOT NULL`
and `(release_model = 'promote') = (release_strategy IS NOT NULL)`, and the project write door
answers `LIVE_BRANCH_REQUIRED` for the same reason. A rule whose whole job is to keep two fields agreeing is a rule about a fact stored
twice.

**`release_strategy` is not what it appears to be.** One site in core branches on its value —
`packages/core/src/projects/live-reading.ts:takeLiveReading` — and it branches only to *refuse*: a
`cherry-pick` project cannot be asked whether its commits reached the live branch, because the shas
are new. Nothing anywhere executes a release according to the strategy. `merge-branch` and `tag-mr`
are never distinguished. `tag-mr` appears in the enum, in the CHECK, and in
`packages/web-v2/src/features/project-settings/types.ts`, and nowhere else: no behaviour, no
document, no project.

The community answer is uniform. GitLab Flow's environment branches say deployment *is* merging
downstream, with commits flowing one way, however many environments there are. GitOps promotion
moves one built artifact along a chain. Neither models "has staging" and "has no staging" as
different release algorithms; both model a chain whose length may be one.

## Decision

**`releaseChain` replaces `releaseModel`, `liveBranch` and `releaseStrategy`.** It is an ordered
list. The first entry is where work merges; the last is live. Each entry after the first carries the
strategy for the edge into it.

```
releaseChain: []                                           # this project ships nothing
releaseChain: [{ branch: 'main' }]                         # one environment
releaseChain: [{ branch: 'dev' },
               { branch: 'main', from: 'merge-branch' }]   # base and live
```

**The release rule, for every chain length:** cross each adjacent pair **by the strategy that pair
declares**; then deploy the last branch. A chain of one has no pair, so its release is a deploy
alone — which is what `publish` names today.

`merge-branch` crosses by merging the earlier branch into the later one, which is the default and
what every project declaring a strategy uses today. `cherry-pick` crosses by copying chosen commits,
and is the one way to leave a commit behind — at the price named under *A partial release is a
prefix*. The rule is the crossing; the merge is one way to do it, not the rule itself.

The strategy moves onto the edge because it is a fact about crossing between two branches, not about
a project. A three-branch chain may cross one way here and another way there.

**`tag-mr` is removed.** A value with no behaviour, no document and no adopter reads as a considered
option and is not one. If it turns out to have had an intended meaning, it returns as a new ADR with
that meaning written down.

**`base_branch` is the fourth column and it stays.** Three of the four go; this one does not, and
the difference is what each is a fact about. `base_branch` is the project's **default work branch**:
where an `ISS-*` branch is cut from, and where it lands unless that issue overrides the target.
`packages/core/src/branches/resolve.ts:resolveIssueBranches` falls `targetBranch` back to it when an
issue's `metadata.branchConfig` names none — the override moves one issue, never the project's
default. So it is a fact about where WORK goes, while the chain is a fact about where a RELEASE
goes. A project that ships nothing still cuts branches. Folding the column in would map
every such project to `[]`, which names no branch, and leave `resolveIssueBranches` with nowhere to
cut from, *silently*. Measured while landing this change, 2026-09-27: of 37 fleet projects, **28
declare no release while carrying a base branch**.

Where a project does declare a release, the chain's first entry and `base_branch` name the same
branch, and that is **the one place the two must agree**. It is held at the write door by
`RELEASE_CHAIN_BASE_MISMATCH`, which refuses the pair by name and says which shape is valid — not by
a CHECK. The CHECKs this ADR removes existed to stop two spellings of ONE fact contradicting each
other; these are two different facts that meet at one branch name, and a refusal a caller can read
is the right instrument for that where a constraint is not.

**An empty chain is declared, never inferred.**
`packages/core/src/release-batch/gate.ts` refuses `RELEASE_TARGET_UNDECLARED` for a project that
declares a release and has no live deploy binding, telling the reader to add a binding *or* declare
that the project ships nothing. That distinction is deliberate and survives: a missing binding is a
gap, an empty chain is an answer, and neither is read off the other.

### The migration is total, and does not read `live_branch`

| stored today | becomes |
|---|---|
| `none` | `[]` |
| `publish`, base `B` | `[{branch: B}]` |
| `promote`, base `B`, live `L`, strategy `merge-branch` or `cherry-pick` | `[{branch: B}, {branch: L, from: S}]` |
| `promote`, base `B`, live `L`, strategy `tag-mr` | **refused by name** |

The table is total over the rows that exist: every project declaring `promote` today carries
`merge-branch`, so no stored row falls in the last line. It is not total over what the CHECK
constraint permits, because removing `tag-mr` and preserving `from: S` cannot both hold for a row
carrying it.

That gap is closed by refusing, never by substituting. **A migration that meets a `tag-mr` row
aborts and names the project it cannot represent**, as this repository already requires of a
migration whose new schema cannot hold a row. Rewriting it to `merge-branch` would change how that
project releases, in silence, on the strength of a value nobody ever gave it a meaning for.

**The chain is never derived from `live_branch`.** 25 of 32 projects carry a `live_branch` that
nothing promotes to — measured, and recorded in
`packages/core/src/schedules/messages/skill-improve-prompt.ts`. Deriving the chain from the branch
pair would move those 25 projects to a two-step release nobody asked for, silently. The migration
reads `release_model` and writes the chain from the table above; a later change that "simplifies" it
into a branch-name inference reintroduces this defect.

### One source of truth in core; a named amnesty at the API boundary

Inside core there is exactly one code path and one stored fact. The enum is gone, not kept beside
the chain.

<!-- doc-citation: unchecked `src/tracker/project-config.mjs` `src/tracker/routes.mjs` — paths inside github.com/SidCorp-co/forge-plugin, a second repository this tree cannot see or gate -->
The wire between core and `forge-plugin` cannot flip at once: the plugin reads these axes in
`src/tracker/project-config.mjs` and `src/tracker/routes.mjs`, the two repositories ship on
different clocks, and the `forge` CLI answers with core, so removing the field from the API before
the plugin stops reading it takes the tracker down with it.

So the boundary takes a **priced amnesty**, in the shape the community calls expand/contract:

1. **Expand** — core stores and uses `releaseChain`. The read API continues to answer
   `releaseModel`, `liveBranch` and `releaseStrategy`, *derived from the chain* on the way out.
2. The plugin moves to the chain and lands on its own clock.
3. **Contract** — core stops answering the derived fields.

What this trades: three field names outlive the concept, and a reader of the API sees a vocabulary
core no longer thinks in. What it buys: the tracker does not go down.
<!-- doc-citation: unchecked `src/tracker/project-config.mjs` `src/tracker/routes.mjs` — paths inside github.com/SidCorp-co/forge-plugin, a second repository this tree cannot see or gate -->
**The condition that ends it**
is the closing of the forge-plugin issue that moves the plugin's readers of these axes —
`src/tracker/project-config.mjs` and `src/tracker/routes.mjs` — onto the chain. Step 3 is owed at
that moment and is not deferred past it.

**That issue's identifier is not yet allocated**, because it is filed once the core half lands and
its changelog can be handed over, and this ADR is amended with the identifier at that moment. Until
then the end condition names a described issue rather than a numbered one: a reader can tell which
issue would satisfy it, and cannot yet check whether it has. An amnesty whose ending nobody can
check is the failure this paragraph exists to avoid, so the gap is stated here rather than left for
a reader to discover.

This is not two live paths. The chain is the only stored fact, the derivation runs one way, and the
old names are a projection with an expiry — not a fallback anything can land on.

### Schema everywhere, values only here

Changing the shape of the column is done for every project at once. **Setting forge-dev's own chain
to a two-branch shape is a separate act, for forge-dev alone**, and this ADR does not authorise it
for any other project. A project migrated from `publish` to `[{branch: 'main'}]` behaves exactly as
it did the day before.

### A partial release is a prefix, not a subset

Ten issues at `awaiting_release` and a release of five is not a selection. **Under `merge-branch` a
release carries a prefix**: a merge takes a branch's history up to a point and cannot omit something
inside it, so the only choice is where to cut.

- The five oldest → a clean cut, nothing else to record.
- Five interleaved with five → the ones in between are **carried along**. That is declared with a
  `blocks` edge, read as *"this cannot go out unless that goes out"* — not as *"this is stuck"*.
- Refusing to carry one → `cherry-pick`, and its price is stated: new shas, so the question *"is
  the commit I judged the one running"* can no longer be answered from the branches. That is the
  refusal `takeLiveReading` already gives.

An issue left behind stays at `awaiting_release`, which is where merged and verified work waits. No
status is added.

**Code serves the reading; the agent makes the judgement.** Which commits sit below a cut point is
mechanical, and code answers it — a dispatcher reading ancestry by eye got it wrong twice in one
session, both times producing a confident wrong answer that only a deliberate
must-report-`NOT` control caught. Where to cut, whether to carry the riders, whether a cherry-pick
is worth its price: those are the agent's, for the same reason cutting the tag is (ADR 0002).

## Consequences

- Both CHECK constraints disappear rather than being maintained: a chain cannot contradict itself.
- `LIVE_BRANCH_REQUIRED` disappears with them.
- `releaseModelGap` silently defaulting a missing strategy to `merge-branch` disappears. That
  default is an unreported normalisation — a project may carry a strategy nobody chose.
- A chain longer than two becomes expressible. The enum could not express it at all.
- Every document describing the enum is deleted in the change that lands the chain, not annotated.
- Work that this repository cannot carry: the plugin's half. It leaves as an issue in
  `github.com/SidCorp-co/forge-plugin` and is not edited from here.
- Not decided here: what `/version` should answer. ADR 0002 left it open and it stays open.
