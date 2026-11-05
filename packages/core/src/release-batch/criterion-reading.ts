// A carried criterion as its release weighs it: the one weighing every count of a release's proof
// reads (ISS-1001). The release record's header and list bar sum these (`release-read-views.ts`),
// and its page lists these (`release-page/claims.ts:claimsOf`), so no count is weighed twice.

import { countedForClass, unjudgedOnReleaseWhy } from '@forge/contracts/release-page';
import { versionsCountedOn } from '@forge/contracts/released-line';
import type { ReleaseCriterionView } from '@forge/contracts/releases';
import { commitIdentityPhrase } from '@forge/contracts/verdict-identity';
import { countedUnderCutover, verifiedOf } from '@forge/contracts/verified-rule';
import { voidedStillRead } from './judged-before-reopen.js';
import type { CarriedVerdict, IssueFact, ReleaseProof } from './release-facts.js';

/**
 * An issue's criteria as the release whose build is `build` counts them, by the one rule every count
 * of proof reads (contracts `verified-rule.ts:verifiedOf`, REQ-35 decision 7b261fca): of the verdicts on that build,
 * the one the criterion stands on is the judge's, and only a pass the rule counts as verified proves
 * it. A short never does, nor the builder's own pass, whatever the project's `qa`; where neither
 * counts, `unverified` says why. A release with no cut build reads every verdict since the last
 * reopen, its newest shown; one with a build reads only the verdicts judged on that build
 * (`judgedOnReleaseBuild`: on a project naming a testing environment, a runtime verdict at it and
 * never a commit one, REQ-36 BC-18), so a verdict on an earlier build never counts, and none on it
 * reads not judged — "Not judged on <environment>" where the project names one (BC-19). A verdict
 * judged on a release counts on release `version` and on every release its record says carries
 * that one (`versionsCountedOn`, ISS-900). A code-property criterion, which only the review judges,
 * also counts its commit verdicts since the last reopen, at any build (`countedForClass`, ISS-914).
 */
export function criteriaAt(
  issue: IssueFact,
  build: string | null,
  proof: ReleaseProof,
  version: string | null = null,
  /** When the release shipped; absent, as its record says (ISS-900), null where it has not. */
  shippedAt?: Date | null,
): ReleaseCriterionView[] {
  return criterionReadingsAt(issue, build, proof, version, shippedAt).map((r) => r.view);
}

/**
 * One carried criterion as its release weighs it (`criterionReadingsAt`): the view its record shows,
 * and the verdicts behind it that a page reads its known issues and media from. The header, the
 * list's bar and every list on the page read these, so a release never says two numbers (ISS-1001).
 */
export interface CriterionReading {
  view: ReleaseCriterionView;
  /** The verdict it stands on at the release's build, or on a release it counts; null where none does. */
  onBuild: CarriedVerdict | null;
  /** The newest verdict it earned anywhere, so one judged elsewhere says where. */
  newest: CarriedVerdict | null;
  /** Proven by the building run's own pass, counted only under the builder-pass cutover. */
  underCutover: boolean;
}

/** The one weighing behind `criteriaAt`, each criterion with the verdicts it was read by. */
export function criterionReadingsAt(
  issue: IssueFact,
  build: string | null,
  { judge, judgedOn, released, landing }: ReleaseProof,
  version: string | null = null,
  shippedAt: Date | null = version === null ? null : (released?.shipped.get(version)?.at ?? null),
): CriterionReading[] {
  const versions = versionsCountedOn(released, version);
  const reader = { shippedAt, build, judgedOn, versions };
  const reopenedAt = issue.reopenedAt?.toISOString() ?? null;
  return issue.criteria.map((c) => {
    const cls = issue.classes.get(c.n) ?? null;
    const before = voidedStillRead(issue, c.n, reader);
    const newestFirst = [...(issue.verdicts.get(c.n) ?? []), ...before].sort((a, b) =>
      b.at.localeCompare(a.at),
    );
    const counted = newestFirst.filter((v) =>
      countedForClass(v, cls, build, judgedOn, versions, reopenedAt),
    );
    const read = verifiedOf(counted, judge);
    const stands = read.stands;
    const byRule = read.proven && stands?.identityKind !== 'commit_unresolved';
    // on a landing basis a criterion its issue earned at its landing is proven on the release too
    // (FB-515): the issue's own weighing (`criteria-basis.ts:landingCriteriaReports`) decides it
    const proven = byRule || (landing?.get(issue.id)?.earned.has(c.n) ?? false);
    const unjudgedThere = build !== null && judgedOn !== null && !stands;
    const unverified = proven
      ? null
      : unjudgedThere
        ? unjudgedOnReleaseWhy(cls, judgedOn, build)
        : read.why;
    // with no build, only a verdict judged on a release names what it stands on (ISS-900)
    const onBuild = build === null && stands?.identityKind !== 'release' ? null : stands;
    const reading = {
      newest: newestFirst[0] ?? null,
      onBuild,
      underCutover: byRule && stands !== null && countedUnderCutover(stands, judge),
    };
    if (build === null && onBuild === null)
      return { ...reading, view: { ...c, proven, unverified } };
    const at = build ?? '';
    return {
      ...reading,
      view: {
        ...c,
        standing: !onBuild
          ? 'unjudged'
          : onBuild.identityKind === 'commit_unresolved'
            ? 'unresolved'
            : onBuild.verdict,
        identity: onBuild
          ? onBuild.identityKind === 'release'
            ? `release ${onBuild.releaseVersion}`
            : onBuild.identityKind === 'commit'
              ? commitIdentityPhrase(onBuild.commitSha)
              : judgedOn === null
                ? commitIdentityPhrase(at)
                : `runtime ${at.slice(0, 12)} on ${judgedOn}`
          : null,
        reason: onBuild?.reason ?? null,
        judgedAt: onBuild?.at ?? null,
        judgedBy: onBuild?.agency ?? null,
        proven,
        unverified,
      },
    };
  });
}
