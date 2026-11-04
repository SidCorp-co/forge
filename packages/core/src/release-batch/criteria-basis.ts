// Where the automatic release weighs an issue's acceptance criteria before it carries the issue.
//
// A criterion is earned where the change can be judged before its release. Where a
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
// Where no promotion stands between, the question is the same one (ISS-964): can any environment this
// project judges on serve a landed change before the release that carries it? Production cannot: Forge
// deploys it only by a release, whatever its trigger (`basisOfPath` says what each one does), so its
// reading, whether or not it names a commit, never holds a waiting change. ISS-957 (FB-493) found this
// where production named no commit (agenfold's 0.123.0 draft asked for verdicts on 0.121.0); ISS-964
// found it again once agenfold's /healthz named one: 0.125.0 asked for verdicts at a939c3f, the 0.123.0
// build, and refused a pass at the landing as "not a commit this project is serving". There a criterion
// is earned at the landing, at a later build holding it, or, where production names no commit, on a
// shipped release whose record holds the issue (`released-line.ts:releaseHoldsIssue`); a criterion the
// issue's design classes `observable`, which only the running product with real data can show, holds
// no release: it is owed on the release that carries it once that ships (`landed-weighing.ts:weighLiveOnly`).
// Only an environment the project names to judge a change on before release (`delivery.judgedOn`,
// REQ-36 BC-18) serves it first, so only there is a criterion earned at what is served.

import { judgedOnOf } from '@forge/contracts/delivery-policy';
import { type ReleasePath, readReleasePath } from '../project-config/index.js';
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
import { shippedReleaseRuns } from './shipped-releases.js';

/**
 * Why a change cannot be in what production serves before its release: a promotion stands between
 * the landing and production, or production is deployed only by a release and no environment the
 * project judges on serves the change first (ISS-964).
 */
export type LandingReason = 'promotion' | 'release-only';

/** Why a change is earned at what is served: the environment it is judged on, or no production. */
export type ServingReason = 'judged-on' | 'on-land' | 'no-production';

/** How production is deployed, as `basisOfPath` reads its declaration. */
export type ProductionDeployment = 'on-land' | 'on-request' | 'provider' | 'external';

export type CriteriaBasis =
  | { kind: 'serving'; why: ServingReason; judgedOn: string | null }
  | {
      kind: 'landing';
      why: LandingReason;
      landsOn: string;
      deploysFrom: string;
      /** Production names no commit it serves: its releases are its agent's record (ISS-957). */
      byRecord: boolean;
      /** How production is deployed; null behind a promotion, where the promotion is the reason. */
      deployment: ProductionDeployment | null;
    }
  | { kind: 'unread'; why: string };

/**
 * What production's reading says of how an `on-land` production moves: `releases` where every commit
 * it serves is one a release of the project shipped (it moves only by its releases), `lands` where it
 * serves another, `unread` where the reading names none, and `none` where the caller has no reading
 * and reaches no network. `releases` moves it to the landing, and so does `unread` where it declares
 * no source probe (ISS-957); the others say nothing against the declaration, so it stands.
 */
export type ProductionMoves = 'releases' | 'lands' | 'unread' | 'none';

/**
 * Where criteria are earned (ISS-964). A promotion between the landing and production: at the landing.
 * A `delivery.judgedOn` environment serves the change before release: at what it serves. Otherwise it
 * turns on whether production can serve the change before its release, by its trigger:
 * - `on-request`: a release run deploys it, and nothing else does: at the landing.
 * - `provider`: the provider deploys it on its own schedule, and nothing declares that a change is
 *   deployed before its release. Ambiguous, so the basis that cannot deadlock: the landing, where a pass
 *   at a later build holding it (the one production serves included) still counts.
 * - external (`mode: external`): a door outside Forge deploys it and a release is the agent's record
 *   of that deploy (ISS-851): at the landing.
 * - `on-land`: the release sweep cuts a release when work lands, and the landing deploys production
 *   nowhere in Forge (`landing-deploy.ts`); what deploys it before then is outside Forge (forge-dev's CI
 *   on every push) or nothing (agenfold, whose release job deploys it). The declaration cannot say
 *   which, so production's reading does: where nothing names a commit it serves (no source probe and
 *   no deployment answering, ISS-957), or every commit it serves is one a release shipped, it moves
 *   only by its releases and a waiting change is weighed at its landing; where it serves another
 *   commit, a landing reached it, and criteria are earned there.
 */
export function basisOfPath(path: ReleasePath, moves: ProductionMoves): CriteriaBasis {
  const { crossing, production, defaultBranch } = path;
  if (crossing) {
    return {
      kind: 'landing',
      why: 'promotion',
      landsOn: defaultBranch ?? crossing.from,
      deploysFrom: crossing.to,
      byRecord: false,
      deployment: null,
    };
  }
  const judgedOn = judgedOnOf(path.document.delivery);
  if (judgedOn !== null) return { kind: 'serving', why: 'judged-on', judgedOn };
  if (!production) return { kind: 'serving', why: 'no-production', judgedOn: null };
  const declared = production.declaration.deployment;
  const deployment: ProductionDeployment = 'trigger' in declared ? declared.trigger : 'external';
  const byRecord = servedCommitUnnamed(production) !== null;
  // a commit no release shipped, or no reading at all, keeps the declaration's word: a landing reaches it
  const movesByReleases = moves === 'releases' || (byRecord && moves === 'unread');
  if (deployment === 'on-land' && !movesByReleases) {
    return { kind: 'serving', why: 'on-land', judgedOn: null };
  }
  // with no branch named, the environment itself is what the words can name
  const deploysFrom = production.declaration.deploysFrom ?? defaultBranch ?? production.name;
  return {
    kind: 'landing',
    why: 'release-only',
    landsOn: defaultBranch ?? deploysFrom,
    deploysFrom,
    byRecord,
    deployment,
  };
}

/** How an `on-land` production moves, read off `reading` and the commits its releases shipped. */
async function productionMoves(
  projectId: string,
  reading: ServingReading | null,
): Promise<ProductionMoves> {
  if (reading === null) return 'none';
  if (reading.kind !== 'serving' || reading.served.length === 0) return 'unread';
  const shipped = new Set((await shippedReleaseRuns(projectId)).map((r) => r.commit));
  return reading.served.every((s) => shipped.has(s.commit.toLowerCase())) ? 'releases' : 'lands';
}

/**
 * Where this project's criteria are earned (`basisOfPath`), or why that could not be read. `serving`
 * is the caller's reading of production: absent, it is read here where the basis turns on it; null,
 * the caller has none and reaches no network.
 */
export async function criteriaBasisOf(
  projectId: string,
  serving?: ServingReading | null,
): Promise<CriteriaBasis> {
  const read = await readReleasePath(projectId);
  if (!read.ok) return { kind: 'unread', why: read.reason };
  const { production } = read.path;
  const declared = production?.declaration.deployment;
  const onLand = declared !== undefined && 'trigger' in declared && declared.trigger === 'on-land';
  if (!onLand || read.path.crossing || judgedOnOf(read.path.document.delivery) !== null) {
    return basisOfPath(read.path, 'none');
  }
  const reading = serving === undefined ? await readServingNow(projectId) : serving;
  return basisOfPath(read.path, await productionMoves(projectId, reading));
}

const DEPLOYED: Record<ProductionDeployment, string> = {
  'on-land':
    'its `on-land` trigger is the release Forge cuts once work lands, and every commit it serves is one a release shipped',
  'on-request': 'its `on-request` trigger deploys it only when a release asks',
  provider:
    'its `provider` trigger leaves deploying to the provider, and nothing declares that it deploys a change before its release',
  external: 'it is deployed outside Forge, and a release is the record of that deploy',
};

/** Why a change is weighed at its landing, in the words every hold and read of it shares. */
export function landingWhere(basis: Extract<CriteriaBasis, { kind: 'landing' }>): string {
  if (basis.why === 'promotion') {
    return `this project's work lands on \`${basis.landsOn}\` and production deploys \`${basis.deploysFrom}\` through a promotion`;
  }
  // a production naming no commit it serves is read on its agent's release record (ISS-957)
  const how =
    basis.byRecord && basis.deployment === 'on-land'
      ? 'its `on-land` trigger is the release Forge cuts once work lands'
      : basis.deployment
        ? DEPLOYED[basis.deployment]
        : null;
  const record = basis.byRecord
    ? '; it names no commit it serves, and the release its record says is live cannot hold a change that has not shipped'
    : '';
  return `this project's production is deployed only by a release${how ? ` (${how})` : ''}, and no environment it judges a change on (\`delivery.judgedOn\`) serves the change before that release, so what production serves cannot hold it${record}`;
}

/** Why a change is weighed at what is served, in the words a hold of it shares (ISS-964). */
export function servingWhere(judgedOn: string | null): string {
  return judgedOn === null
    ? "it is weighed at what this project's production serves, which deploys on land and serves a commit no release shipped, so a landing reaches it before its release"
    : `it is weighed at what \`${judgedOn}\` serves, the environment this project judges a change on before its release (\`delivery.judgedOn\`)`;
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
    ...(basis.byRecord ? { byRecord: true as const } : {}),
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
