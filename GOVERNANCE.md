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
criterion, which is recorded on the issue rather than on the pull request.

## Release authority

**A deploy is never a side effect of code, and neither is a release tag.** Both are the
dispatcher's own act. No code path fires a deployment, and none cuts a release tag — see
[`docs/adr/0002-the-agent-cuts-the-release-tag.md`](docs/adr/0002-the-agent-cuts-the-release-tag.md).

**A release's version number is allocated, not chosen.** One writer, under a lock, with a failed
release burning its number — see
[`docs/adr/0001-a-release-version-is-a-counter.md`](docs/adr/0001-a-release-version-is-a-counter.md).

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
