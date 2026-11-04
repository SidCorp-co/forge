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
//
// Where production names no commit it serves (no source probe: its releases are its agent's record by
// version, ISS-900), the same holds without a promotion (ISS-957, FB-493): the release its record says
// is live cannot hold a change that landed after it, so weighing there asked agenfold's ISS-127, 128
// and 142 for verdicts on 0.121.0 and held 0.123.0, the release that would ship them, for ever. There
// too a criterion is earned at the landing, or on a shipped release whose record holds the issue
// (`released-line.ts:releaseHoldsIssue`); and a criterion the issue's design classes `observable`,
// which only the running product with real data can show, holds no release: it is owed on the
// release that carries it once that ships (`landed-weighing.ts:weighLiveOnly`).

import { judgedOnOf } from '@forge/contracts/delivery-policy';
import { readReleasePath } from '../project-config/index.js';
import { type LandedCriterion, landedBuildsOf, landedStandings } from './landed-build.js';
import {
  earlierCarriageOf,
  holdsOnBuilds,
  type JudgedAgainst,
  type LandingHoldsRead,
  landedBuildHolds,
  laterHoldersOf,
} from './landed-build-holds.js';
import { servedCommitUnnamed } from './released-line.js';
import { readServingNow, type ServingReading } from './serving-reading.js';

/**
 * Why a change cannot be in what production serves before its release: a promotion stands between
 * the landing and production, or production names no commit it serves, so the release its record
 * says is live predates the change (ISS-957).
 */
export type LandingReason = 'promotion' | 'release-record';

export type CriteriaBasis =
  | { kind: 'serving' }
  | { kind: 'landing'; why: LandingReason; landsOn: string; deploysFrom: string }
  | { kind: 'unread'; why: string };

/**
 * Where this project's criteria are earned. A production with no source probe whose reading names no
 * commit it serves (ISS-957) is weighed at the landing; one whose deployment record names the commit
 * it serves keeps weighing there, and so does a project naming the environment it judges a change on
 * before release (`delivery.judgedOn`, REQ-36 BC-18), which can hold the change. `serving` is the caller's reading of production: absent, it is read
 * here; null, the caller has none and reaches no network, so nothing says production names no commit.
 */
export async function criteriaBasisOf(
  projectId: string,
  serving?: ServingReading | null,
): Promise<CriteriaBasis> {
  const read = await readReleasePath(projectId);
  if (!read.ok) return { kind: 'unread', why: read.reason };
  const { crossing, production, defaultBranch } = read.path;
  if (crossing) {
    return {
      kind: 'landing',
      why: 'promotion',
      landsOn: defaultBranch ?? crossing.from,
      deploysFrom: crossing.to,
    };
  }
  if (!production || servedCommitUnnamed(production) === null) return { kind: 'serving' };
  // an environment the project judges a change on before release can hold it: weighed there
  if (judgedOnOf(read.path.document.delivery) !== null) return { kind: 'serving' };
  const reading = serving === undefined ? await readServingNow(projectId) : serving;
  if (reading === null || reading.kind === 'serving') return { kind: 'serving' };
  // with no branch named, the environment itself is what the words can name
  const deploysFrom = production.declaration.deploysFrom ?? defaultBranch ?? production.name;
  return {
    kind: 'landing',
    why: 'release-record',
    landsOn: defaultBranch ?? deploysFrom,
    deploysFrom,
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
  const basis = await criteriaBasisOf(projectId);
  if (basis.kind !== 'landing') return null;
  const builds = await landedBuildsOf(issueIds);
  return {
    ...(await holdsOnBuilds(projectId, builds, judged)),
    promoted: true,
    ...(basis.why === 'release-record' ? { byRecord: true as const } : {}),
  };
}

/** One waiting issue weighed at its landing: each criterion that does not count there, and why. */
export interface LandingCriteriaReport {
  issueId: string;
  /** The landing commit weighed at; null where the issue's merge names none. */
  landing: string | null;
  unearned: Array<{ criterion: number; why: string }>;
  /**
   * Live-only criteria owed on the release that carries the issue once it ships, which hold no release
   * (`landed-weighing.ts:weighLiveOnly`, ISS-957): judged after that release. Empty on any other project.
   */
  afterRelease: Array<{ criterion: number; why: string }>;
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
      return { issueId, landing: null, unearned, afterRelease: [], counted: [] };
    }
    const short = (c: LandedCriterion) =>
      c.counts ? [] : [{ criterion: c.criterion, why: c.why, after: c.afterRelease === true }];
    const owing = criteria.flatMap(short);
    return {
      issueId,
      landing: build.sha,
      unearned: owing.flatMap(({ after, ...c }) => (after ? [] : [c])),
      afterRelease: owing.flatMap(({ after, ...c }) => (after ? [c] : [])),
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
