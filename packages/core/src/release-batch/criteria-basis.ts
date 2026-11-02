// Where the automatic release weighs an issue's acceptance criteria before it carries the issue.
//
// Where landing on the issue's branch IS deploying production (no promotion stands between), a
// criterion is earned at what production serves: the change is running there once it lands. Where a
// promotion stands between (sidcorp-mail, 2026-10-27: work lands on `dev`, production deploys
// `master`), what production serves cannot hold the change before the release that promotes it, so
// weighing there held every waiting issue for ever. There a criterion is earned at the issue's
// landing commit, or on the testing environment `delivery.judgedOn` names (REQ-36 BC-18), as a
// recorded landing weighs it (`landed-build.ts:landedStandings`), or at a later build that holds the
// landing, as a requirement's coverage counts it (`landed-build-holds.ts:laterHoldersOf`): sidcorp-mail
// ISS-5 was held on a pass at a dev head holding its landing, which its requirement already counted.
// A pass at an earlier commit the landing descends from is carried to it (ISS-845,
// `landed-build-holds.ts:earlierCarriageOf`): a fix round's landing keeps the round before it's passes.
// A requirement's coverage reads its issues on this same basis (`coverageLandingHolds`, ISS-849):
// adminhub-api REQ-11 read no criterion passing while its shipped ISS-53 had earned every one at its
// landing, because coverage weighed those passes against what production serves.

import { readReleasePath } from '../project-config/index.js';
import { landedBuildsOf, landedStandings } from './landed-build.js';
import {
  earlierCarriageOf,
  holdsOnBuilds,
  type JudgedAgainst,
  type LandingHoldsRead,
  landedBuildHolds,
  laterHoldersOf,
} from './landed-build-holds.js';

export type CriteriaBasis =
  | { kind: 'serving' }
  | { kind: 'landing'; landsOn: string; deploysFrom: string }
  | { kind: 'unread'; why: string };

export async function criteriaBasisOf(projectId: string): Promise<CriteriaBasis> {
  const read = await readReleasePath(projectId);
  if (!read.ok) return { kind: 'unread', why: read.reason };
  const crossing = read.path.crossing;
  if (!crossing) return { kind: 'serving' };
  return {
    kind: 'landing',
    landsOn: read.path.defaultBranch ?? crossing.from,
    deploysFrom: crossing.to,
  };
}

/**
 * The builds a requirement's coverage weighs its issues' verdicts on, by the basis the release weighs
 * their criteria on: on a project with no production environment, each issue's delivered build
 * (`landedBuildHolds`); where a promotion stands between the landing and production, each issue's
 * landing commit as `landingCriteriaReports` reads it (`landedBuildsOf`), with what later and earlier
 * commits its verdicts name hold of it, so a criterion its issue earned there counts for the
 * requirement too. Null where the release weighs at what is served, or its basis could not be read:
 * there coverage reads the live build.
 */
export async function coverageLandingHolds(
  projectId: string,
  issueIds: readonly string[],
  judged: ReadonlyMap<string, readonly JudgedAgainst[]> = new Map(),
): Promise<LandingHoldsRead | null> {
  const delivered = await landedBuildHolds(projectId, issueIds, judged);
  if (delivered) return delivered;
  if ((await criteriaBasisOf(projectId)).kind !== 'landing') return null;
  const builds = await landedBuildsOf(issueIds);
  return { ...(await holdsOnBuilds(projectId, builds, judged)), promoted: true };
}

/** One waiting issue weighed at its landing: each criterion that does not count there, and why. */
export interface LandingCriteriaReport {
  issueId: string;
  /** The landing commit weighed at; null where the issue's merge names none. */
  landing: string | null;
  unearned: Array<{ criterion: number; why: string }>;
  /** Every criterion that counts there, and the commit its verdict was judged at: the landing
   *  itself, a later build that holds it, or an earlier one it descends from, `carried` saying how
   *  (`landed-weighing.ts:weighOnLanded`, ISS-845), or `release ${version}` where it was judged on
   *  a release the project's record counts (`release`, ISS-900). */
  counted: Array<{ criterion: number; at: string; carried?: string; release?: string }>;
}

/** Each of `issueIds` (of `projectId`) weighed at its landing commit, in the order given. */
export async function landingCriteriaReports(
  projectId: string,
  issueIds: readonly string[],
): Promise<LandingCriteriaReport[]> {
  if (issueIds.length === 0) return [];
  const builds = await landedBuildsOf(issueIds);
  const buildOf = (id: string) => builds.get(id.toLowerCase());
  const standings = await landedStandings(
    issueIds,
    (id) => buildOf(id)?.sha ?? '',
    (id) => {
      const b = buildOf(id);
      return b?.sha ? (b.via ?? null) : null;
    },
    (id) => {
      const b = buildOf(id);
      return b?.sha ? (b.head ?? null) : null;
    },
    (judged, judgedOnFor) => laterHoldersOf(projectId, builds, judged, judgedOnFor),
    (judged, judgedOnFor) => earlierCarriageOf(projectId, builds, judged, judgedOnFor),
  );
  const byId = new Map(standings.map((s) => [s.issueId, s]));
  return issueIds.map((issueId) => {
    const build = buildOf(issueId);
    const standing = byId.get(issueId);
    const criteria = standing?.criteria ?? [];
    if (!build || build.sha === null) {
      // No landing commit, so nothing a verdict names can be weighed: every owed criterion is unearned.
      const why = build?.why ?? 'nothing says where it landed';
      const owed = standing?.owes ? criteria.map((c) => c.criterion) : [];
      const unearned = owed.map((criterion) => ({ criterion, why }));
      return { issueId, landing: null, unearned, counted: [] };
    }
    return {
      issueId,
      landing: build.sha,
      unearned: criteria.flatMap((c) => (c.counts ? [] : [{ criterion: c.criterion, why: c.why }])),
      counted: criteria.flatMap((c) =>
        c.counts
          ? [
              {
                criterion: c.criterion,
                at: c.at,
                ...(c.carried ? { carried: c.carried } : {}),
                ...(c.release ? { release: c.release } : {}),
              },
            ]
          : [],
      ),
    };
  });
}
