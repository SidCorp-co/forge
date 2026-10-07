# 0011 — A release keeps its version across attempts; attempts are not versions

**Status:** accepted · **Date:** 2026-10-08 · **Supersedes:** [0010](0010-a-release-number-is-spent-when-it-leaves-forge.md)

## Context

[0010](0010-a-release-number-is-spent-when-it-leaves-forge.md) handed a cut number back only when
an ended attempt **proved** nothing left Forge, and counted it spent on anything else: a finish
record, a silent abort. On 2026-10-08 the dev database showed what that reads as. On HOP one roster
of 26 issues was cut three times on 2026-10-07. `0.3.0` aborted after its finish was refused
`RELEASE_NOT_VERIFIED`, and its abort said nothing about a push. `0.4.0` was cut again and said
`pushed:false`, but its failed finish record kept the number spent. `0.5.0` shipped. No tag, release
commit or published artifact carried `0.3.0` or `0.4.0`: the storefront publishes workflow versions,
not release numbers. The releases list still read three releases, two of them "stopped", for one
delivery. The same reading on `forge` gave `0.4.0-dev.8` to `dev.26`, nineteen versions for one
roster of seven issues, eighteen of them cut by a sweep no box ever took.

0010 also handed an unspent number to whatever roster came next. On `forge`, `0.4.0-dev.72` was
worn twice by a one-issue roster that never shipped, then by a different roster that did. One
version named two different deliveries.

How others separate the number from the attempt:

<!-- doc-citation: unchecked `index.js` `lib/get-next-version.js` — paths inside github.com/semantic-release/semantic-release, read on 2026-10-08, not in this tree -->
- **semantic-release** (`index.js`, `lib/get-next-version.js` in `semantic-release/semantic-release`)
  creates and pushes the tag **before** the publish plugins run: the `tag(nextRelease.gitTag, …)`
  call comes ahead of `plugins.publish`. It derives the next version from the last tag it finds. A
  publish that fails after the push leaves the tag, so the version is gone. Before the push, nothing
  outside the run names it, and a rerun computes the same number. The number is spent by the
  artifact, never by the attempt.
<!-- doc-citation: unchecked `packages/cli/src/commands/publish/index.ts` — a path inside github.com/changesets/changesets, read on 2026-10-08, not in this tree -->
- **changesets** (`packages/cli/src/commands/publish/index.ts` in `changesets/changesets`) writes
  the version into the package manifests first. `changeset publish` publishes only what the registry
  does not already hold, and treats `failed:already-published` as acceptable. A failed publish is
  retried at the **same** version until the registry carries it. Git tags are created afterwards,
  for what published.
- **GitHub** keeps a Release (a tag and its notes) apart from Deployments: any number of deployment
  records, each with its own statuses, against one ref (`github/rest-api-description`,
  `/repos/{owner}/{repo}/releases` beside `/repos/{owner}/{repo}/deployments`).
- **Argo CD** retries a sync of the **same** revision: `OperationState.RetryCount` counts attempts,
  and `RevisionHistory` records each deploy with `DeployStartedAt` and `InitiatedBy`
  (`argoproj/argo-cd`, `pkg/apis/application/v1alpha1/types.go`).
- **Spinnaker** restarts a failed stage inside the same pipeline execution
  (`spinnaker/orca`, `orca-queue/src/main/kotlin/com/netflix/spinnaker/orca/q/handler/RestartStageHandler.kt`).
  The artifact version the execution deploys does not change.

All five agree: an attempt is a record under a version, and the version moves only when an
artifact outside the system already carries it.

## Decision

**A version names a release, and a release is one roster carried through its attempts.**

- **Same roster.** An attempt re-cuts an earlier one when its roster is the same **set** of issues
  (order and repeats do not count) and the latest earlier attempt on that set ended without shipping.
  Adding or dropping any issue makes a **new release**, with a new version. The earlier version stays
  claimed by its own roster and is never handed to a different one, so one version never names two
  deliveries. `packages/core/src/release-batch/version-rule.ts:predecessorOf` is the rule, and
  `rosterKey` spells the set.
- **A re-cut wears its predecessor's version** unless something outside Forge already carries it.
  The carriers are a pushed tag, a release commit (its changelog entry or version bump), a published
  artifact, or a notice sent to people. Then the next attempt takes a new version, and the cut
  records why on the run (`metadata.versionCut`), naming each carrier. The release page says so. A
  prerelease line that moved off the predecessor's version also takes a new one, and the page names
  the line. So does a version another release already wears, as when 0010 handed it on, so no
  version comes to name a second delivery. `packages/core/src/release-batch/version-rule.ts:decideVersion` makes the decision, and
  `packages/core/src/release-batch/version-store.ts:cutReleaseVersion` is still its only writer, on the same per-project lock.
- **Silence is refused, not guessed.** An ended attempt that a box took, and that never said what
  left it, makes its re-cut undecidable. The re-cut is refused `RELEASE_VERSION_UNDECIDED`, naming
  the version, the attempt and the run, and the draft shows the same gate. To decide it, somebody
  states what carries the version: `"carried"` on the abort, or
  `POST /api/projects/:projectId/release-batches/:runId/carried` after the fact. `[]` means nothing
  does. A declaration only adds carriers, so a reported tag is never taken back. An abort whose
  `pushed` and `carried` disagree is refused `RELEASE_CARRIED_CONTRADICTS`. Every writer of a
  carrier takes the same per-project lock the cut decides under, so a cut never decides on a
  reading a declaration is about to change.
- **A new release starts above the highest version any attempt ever claimed**, shipped or not. An
  ended run with no release job was refused at the door. It was never attempted and claims nothing.
- **The list counts releases, not attempts.** A release is named by the version its last attempt
  wears. Each attempt shows its cut time, its outcome, the refusal word for word, the abort's reason
  and who ended it (`packages/core/src/release-batch/release-cuts.ts`). An older version whose roster went on under a
  later one reads "shipped as" or "cut again as" that release. It is folded into that release, not
  listed beside it.
- **History is not rewritten.** Rows cut before this rule keep their versions. HOP's `0.3.0` and
  `0.4.0` stay aborted and `0.5.0` stays shipped. The link between them is derived at read time from
  roster identity, which is the same rule the cut uses. No migration writes it, and no row changes.

## Consequences

- A gap in the sequence now means a release that changed its roster, or a version an artifact
  outside Forge carried. The page names which.
- A release run that aborts must say what left its box. The release prompts ask for `carried`. A run
  that forgets blocks only the re-cut of that roster, by name, until somebody looks. Every other
  roster still cuts.
- The forge-plugin release-flow skill still teaches `pushed`, which is accepted as before:
  `pushed:false` decides "nothing", and `pushed:true` without a name is shown as an unnamed push.
  Teaching it `carried` is that repository's change.
- A legacy chain whose roster changed in the middle (`0.4.0-dev.72` above) shows every run at that
  version as attempts of the one release. That is what the rows say, and they are not edited.
