# Governance

Who reviews, who merges, who releases, and what may be decided without a person. The rules of the
work itself are in [`CLAUDE.md`](CLAUDE.md); this file is about authority.

## Roles

| Role | Does |
|---|---|
| **Owner** | decides intent and policy; the final word on anything [`docs/VISION.md`](docs/VISION.md) covers |
| **Dispatcher** | picks up work, merges pull requests, fires deploys, cuts release tags |
| **Run** | takes one issue from its title to a pushed branch and an open pull request |
| **Judge** | exercises a change somebody else wrote and records a verdict per criterion |

A **run** and a **judge** are separate on this project by configuration (`qa: independent`): the run
that wrote the code is not the one whose verdicts move it on.

## Merge authority

**A run does not merge and does not deploy. Both are the dispatcher's.** A run briefed to merge
stops short and hands it back, saying so.

**Nobody merges past a red `ci-passed`.** `enforce_admins` is `false` on the base branch, so an
administrator *can*. Don't. The setting exists for recovery, not for convenience, and using it
makes the required check a suggestion.

**A review judges the head that lands.** Where the reviewed head and the landed head differ, the
merged mark is refused and names both.

## Review authority

**`ci-passed` is the required check and the only one.** Branch protection does **not** require a
pull-request review: `required_pull_request_reviews` is off. This means
[`.github/CODEOWNERS`](.github/CODEOWNERS) routes review requests and enforces nothing — it is a
notification, not a gate. That file says so itself rather than leaving a reader to infer it.

The judgement that matters is the live judge's verdict per acceptance criterion, recorded on the
issue rather than on the pull request and judged once per batch, on the release that carries the
work: `awaiting_release` asks only for the recorded merge (REQ-45 BC-1, BC-2), and a failing verdict
reopens the issue that owns the work, which rides the next batch. The release hold asks for passing
verdicts only where the project document sets `delivery.verdictsRequired: true`; absent, the
default, the release takes an issue without them and its verdicts follow it. Where the document
names a testing environment (`delivery.judgedOn`, REQ-36
BC-18..BC-20), a commit verdict still gates the merge, but a release is proven, and its owner's
review owed, only by passes judged on the build that environment serves (a `runtime` verdict at
the release's commit); a criterion not judged there reads "Not judged on <environment>". A
code-property criterion, which only the review judges against the diff, is proven by the review's
commit pass since the issue's last reopen (ISS-914).

Fast delivery (REQ-79) is every project's default, and `delivery.fast: false` turns it off. Under
it a merge check asks only that the change is rebased on its base, typechecks and passes its direct
tests; integration tests and `verify` are the cleanup run's, and deploy health is the release's own
gate. A red the building agent rates below high passes as cleanup debt, and a change it rates high
waits for a green cleanup report: held from landing where production deploys on land
(`MERGE_CLEANUP_PENDING`), and from promotion where a person promotes (`RELEASE_CLEANUP_PENDING`).
The cleanup run is the audit, apart from delivery: in the project's `cleanup` schedule window, on its
own slot, it reviews what landed since its last report by the served audit guide, works the debt,
and reports what it cleared and what remains.

## Release authority

**A deploy is never a side effect of a status move, and neither is a release tag.** Both are the
dispatcher's own act, with two declared exceptions: on `dev` a push deploys forge-dev (owner,
2026-10-29), and where a project binds a source host, Forge tags the commit its release names through
that binding. The tag of Forge's own release cut stays the dispatcher's — see
[`docs/adr/0002-the-agent-cuts-the-release-tag.md`](docs/adr/0002-the-agent-cuts-the-release-tag.md)
and its amendments.

**A release's version number is allocated, not chosen.** One writer, under a lock — see
[`docs/adr/0001-a-release-version-is-a-counter.md`](docs/adr/0001-a-release-version-is-a-counter.md).
A number is spent once it leaves Forge (a tag, a promotion, a served build); a batch that aborts
before that hands it back — see
[`docs/adr/0010-a-release-number-is-spent-when-it-leaves-forge.md`](docs/adr/0010-a-release-number-is-spent-when-it-leaves-forge.md).

**Where a release goes is declared by the project document**: the production environment, the
branch it deploys from, and the promotions that reach it — see
[`docs/adr/0004-the-project-document-declares-where-a-release-goes.md`](docs/adr/0004-the-project-document-declares-where-a-release-goes.md).

### Release notes

<!-- doc-citation: unchecked `docs/releases/` — named as a path that deliberately does NOT exist here; its absence is the rule, so a checker finding it would be the defect -->
[`CHANGELOG.md`](CHANGELOG.md) **is** the release note. There is no second changelog, no
`docs/releases/`, and no per-version file: the `record` axis owns that document and a second copy of
the same fact is the defect ADR 0003 was written against.

An entry not yet released is a file of its own under `changelog.d/`, written when the work landed.
Cutting a release folds every one of them into a new version heading carrying **the number the
allocator gave** and the date the release shipped, and deletes the files in the same commit. The
entries are not rewritten on the way — they were written for a reader when the work landed, and the
release only stamps them.

A release that reaches its tag step and cannot cut the tag gets **no heading**. It is reported
unfinished rather than released, so no version heading ever names work that is not out.

**The address to hand anyone outside this repository** — another repo's issue, a reviewer, an agent
on the other side of an API — is
<https://github.com/SidCorp-co/forge/blob/main/CHANGELOG.md>. It is the one URL for what shipped,
and quoting entries into another tracker in place of it creates the second copy this section exists
to prevent.

## What an agent decides alone

**Agents decide and execute, on the record; people set policy.** An agent decides the plan,
comments, evidence, the branch, commits, the push, status moves, the release note and whatever the
plan did not foresee, and records each decision on the item it shapes: what it chose, the options,
why, and the evidence, so it can be read and reversed.

A person is asked only for a decision serious enough to need one — **irreversible, real money,
credentials or product direction** — once, with a recommendation, and only on a project that keeps
that control (`strict`) or whose own rule names that person's act
(`packages/core/src/questions/owed.ts`); elsewhere the agent decides it too, on the record. A
routine approval is a defect, not a safeguard. Where a
person's act is a kernel step today (granting a credential, approving a device's pairing, approving
a release where the project asks for that approval), it is that act and nothing more.

The hard cases follow the same rule. A destructive migration is irreversible: where a person is
asked, it is asked with what it loses, and elsewhere its issue says what it loses before it lands.
An ambiguity is settled by the reading the requirement supports, with the other reading recorded
beside the choice, unless the readings differ in product direction. A failure with no way back is
reported on its issue and escalated, with what was tried. See
[`docs/adr/0013-a-person-is-asked-only-for-a-serious-decision.md`](docs/adr/0013-a-person-is-asked-only-for-a-serious-decision.md).

## Changing this file

Governance changes are decisions, so they arrive with an ADR in [`docs/adr/`](docs/adr/) recording
what changed and why. A decision that supersedes an earlier one gets a new ADR; the old one is left
standing.
