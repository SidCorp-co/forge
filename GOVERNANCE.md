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

The judgement that actually holds a change is the independent judge's verdict per acceptance
criterion, which is recorded on the issue rather than on the pull request. It holds where the
project document's `delivery.verdictsRequired` is true, the default; where it is false,
`awaiting_release` and the release cut take an issue without passing verdicts and the move records
`verdicts-waived`.

## Release authority

**A deploy is never a side effect of code, and neither is a release tag.** Both are the
dispatcher's own act. No code path fires a deployment, and none cuts a release tag — see
[`docs/adr/0002-the-agent-cuts-the-release-tag.md`](docs/adr/0002-the-agent-cuts-the-release-tag.md).

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

Cutting a release turns the `[Unreleased]` heading into a version heading carrying **the number the
allocator gave** and the date the release shipped, and opens a fresh empty `[Unreleased]` above it.
The entries do not move or get rewritten on the way — they were written for a reader when the work
landed, and the release only stamps them.

A release that reaches its tag step and cannot cut the tag gets **no heading**. It is reported
unfinished rather than released, so no version heading ever names work that is not out.

**The address to hand anyone outside this repository** — another repo's issue, a reviewer, an agent
on the other side of an API — is
<https://github.com/SidCorp-co/forge/blob/main/CHANGELOG.md>. It is the one URL for what shipped,
and quoting entries into another tracker in place of it creates the second copy this section exists
to prevent.

## What an agent decides alone

Everything the issue's plan covers: the plan itself, comments, evidence, the branch, commits, the
push, status moves and the release note.

Three things stop an agent and ask a person:

1. **A destructive migration** — say what is lost, and ask.
2. **An ambiguity where reversing the wrong branch is expensive.** Two readings producing different
   code is a question; two differing only in a value is the agent's to settle.
3. **A failure with no way back** — a deploy that will not roll back, a gate still red after the
   fix, an integration path that changed underneath.

Everything else proceeds unasked. Visibility is not a reason to stop; irreversibility is.

## Changing this file

Governance changes are decisions, so they arrive with an ADR in [`docs/adr/`](docs/adr/) recording
what changed and why. A decision that supersedes an earlier one gets a new ADR; the old one is left
standing.
