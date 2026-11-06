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
// project judges on serve a landed change before the release that carries it? Forge deploys production
// only by a release whatever its trigger, but a door outside Forge may deploy it on every push, and the
// declaration never says which, so production's reading answers (`basisOfPath`): one that serves only
// commits its releases shipped, or names none (ISS-957), moves only by its releases. ISS-957 (FB-493)
// met it where production named no commit (agenfold's 0.123.0 draft asked for verdicts on 0.121.0);
// ISS-964 met it again once agenfold's /healthz named one: 0.125.0 asked for verdicts at a939c3f, the
// 0.123.0 build, and refused a pass at the landing as "not a commit this project is serving". There a
// criterion is earned at the landing, at a later build holding it, or, where production names no
// commit, on a shipped release whose record holds the issue (`released-line.ts:releaseHoldsIssue`); a
// criterion the issue's design classes `observable`, which only the running product with real data can
// show, holds no release: it is owed on the release that carries it once that ships
// (`landed-weighing.ts:weighLiveOnly`). A release holds an issue only for the round it carried
// (ISS-967, FB-495: agenfold's ISS-160, reopened after failing live on 0.128.0 and re-landed, was owed
// on 0.128.0 for ever): one that shipped it before its last reopen holds none of the fix re-landed
// since (`issues/release-evidence.ts:reworkedSince`, the rule the release read names a reworked issue
// by), so no pass counts on it, no criterion is owed on it, and the fail that caused the reopen holds
// nothing once the fix re-lands. Where production serves a commit no release shipped, a landing
// reached it, and a criterion is earned at what it serves; so too on a `delivery.judgedOn` environment
// (REQ-36 BC-18), which serves a change before its release.

import { judgedOnOf } from '@forge/contracts/delivery-policy';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { waitingForReleaseSql } from '../issues/index.js';
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
import { releasesAt, type ShippedRelease } from './shipped-releases.js';

/**
 * Why a change cannot be in what production serves before its release: a promotion stands between
 * the landing and production, or production moves only by its releases (ISS-964).
 */
export type LandingReason = 'promotion' | 'release-only';

/**
 * Why a change is earned at what is served: the environment it is judged on, a production a landing
 * reaches (it serves a commit no release shipped), or no production.
 */
export type ServingReason = 'judged-on' | 'landing-reaches' | 'no-production';

/** How production is deployed, as its declaration names it. */
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
 * What production's reading says of how it moves: `releases` where it serves only what releases
 * shipped while a change landed after them waits, `lands` where a landing reached it or nothing says
 * otherwise, `unread` where the reading names no commit, and `none` where the caller has no reading
 * and reaches no network (`productionMoves`).
 */
export type ProductionMoves = 'releases' | 'lands' | 'unread' | 'none';

/**
 * Where criteria are earned (ISS-964): where an environment the project judges on can serve a landed
 * change before the release that carries it. A promotion between the landing and production: no, so at
 * the landing. A `delivery.judgedOn` environment: yes, so at what it serves.
 *
 * Otherwise production, whose trigger cannot answer it. Forge deploys production only by a release:
 * `on-request` when a release asks, `on-land` when the sweep cuts one as work lands (the landing deploys
 * every other environment and never production, `landing-deploy.ts`; an issue reaches production only
 * at its release step, `coolify-commands.ts`). But a door outside Forge may deploy it on every push:
 * forge-dev's CI under `external` or `on-land`, a provider's own hook under `provider`, a Coolify app
 * watching its branch under any. The declaration never says which, so production's reading answers:
 * - it serves only commits releases shipped, though a change waiting at the gate landed after the
 *   latest of them: that landing did not reach it, so it moves only by its releases, and a waiting
 *   change is weighed at its landing (agenfold's 0.125.0, held for verdicts at its 0.123.0 build);
 * - it names no commit and nothing answers (no source probe, no deployment record, ISS-957): the same;
 * - it serves a commit no release shipped, or nothing waits to tell: at what it serves, as before;
 * - the caller has no reading and reaches no network: the served basis, as before ISS-964.
 * The landing never deadlocks where the reading is wrong: a pass at a later build holding the landing,
 * production's included, still counts there.
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
  const byRecord = servedCommitUnnamed(production) !== null;
  if (!(moves === 'releases' || (byRecord && moves === 'unread'))) {
    return { kind: 'serving', why: 'landing-reaches', judgedOn: null };
  }
  const declared = production.declaration.deployment;
  // with no branch named, the environment itself is what the words can name
  const deploysFrom = production.declaration.deploysFrom ?? defaultBranch ?? production.name;
  return {
    kind: 'landing',
    why: 'release-only',
    landsOn: defaultBranch ?? deploysFrom,
    deploysFrom,
    byRecord,
    deployment: 'trigger' in declared ? declared.trigger : 'external',
  };
}

/**
 * How production moves, read off `reading` (ISS-964): `releases` where it serves only commits releases
 * of the project shipped and a change waiting at the gate landed after the latest of those shipped, so
 * production did not take that landing; `lands` where it serves a commit no release shipped, or nothing
 * waits to say otherwise (the served basis, as before); `unread` where the reading names no commit.
 */
async function productionMoves(
  projectId: string,
  reading: ServingReading | null,
): Promise<ProductionMoves> {
  if (reading === null) return 'none';
  if (reading.kind !== 'serving' || reading.served.length === 0) return 'unread';
  const served = [...new Set(reading.served.map((s) => s.commit.toLowerCase()))];
  const rows = await db.execute<{ shipped: number; untaken: boolean }>(sql`
    WITH serving AS (
      SELECT max(r.release_released_at) AS at, count(DISTINCT lower(r.metadata -> 'finish' ->> 'commit')) AS n
        FROM pipeline_runs r
       WHERE r.project_id = ${projectId}
         AND r.metadata ->> 'source' = 'release-batch'
         AND r.metadata -> 'finish' ->> 'state' = 'finished'
         AND r.release_released_at IS NOT NULL
         AND lower(r.metadata -> 'finish' ->> 'commit') IN (${sql.join(
           served.map((c) => sql`${c}`),
           sql`, `,
         )})
    )
    SELECT serving.n::int AS shipped,
           EXISTS (SELECT 1 FROM issues i
                    WHERE i.project_id = ${projectId} AND ${waitingForReleaseSql(sql`i`)}
                      AND i.merged_at > serving.at) AS untaken
      FROM serving
  `);
  const [row] = [...rows];
  return row && row.shipped === served.length && row.untaken ? 'releases' : 'lands';
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
  const { crossing, production, document } = read.path;
  if (crossing || !production || judgedOnOf(document.delivery) !== null) {
    return basisOfPath(read.path, 'none');
  }
  const reading = serving === undefined ? await readServingNow(projectId) : serving;
  return basisOfPath(read.path, await productionMoves(projectId, reading));
}

/** Why a change is weighed at its landing, in the words every hold and read of it shares. */
export function landingWhere(basis: Extract<CriteriaBasis, { kind: 'landing' }>): string {
  if (basis.why === 'promotion') {
    return `this project's work lands on \`${basis.landsOn}\` and production deploys \`${basis.deploysFrom}\` through a promotion`;
  }
  // a production naming no commit it serves is read on its agent's release record (ISS-957)
  const seen = basis.byRecord
    ? 'it names no commit it serves, and the release its record says is live cannot hold a change that has not shipped'
    : 'it serves only what its releases shipped while a change landed since waits';
  const how =
    basis.deployment === 'external' ? 'deployed outside Forge' : `\`${basis.deployment}\``;
  return `this project's production is deployed only by a release (${how}: ${seen}), and no environment it judges a change on (\`delivery.judgedOn\`) serves the change before that release, so what production serves cannot hold it`;
}

/**
 * Why a change is weighed at what is served, in the words a hold of it shares (ISS-964). `named` says
 * what production serves by Forge's release records (`servedNamed`): agenfold's 0.140.0 hold called
 * 87a8c61, the commit 0.139.0 shipped, "a commit no release shipped" (ISS-997).
 */
export function servingWhere(judgedOn: string | null, named?: string): string {
  const what = named === undefined ? '' : ` (${named})`;
  return judgedOn === null
    ? `it is weighed at what this project's production serves${what}, as on a project whose landings reach production before their release`
    : `it is weighed at what \`${judgedOn}\` serves${what}, the environment this project judges a change on before its release (\`delivery.judgedOn\`)`;
}

/**
 * What each commit a reading serves is, by the releases Forge recorded shipping: the release it
 * shipped as (the latest, where several did), or that no release names it. Undefined where the
 * reading names no commit.
 */
export function servedNamed(
  serving: ServingReading,
  releases: readonly ShippedRelease[],
): string | undefined {
  if (serving.kind !== 'serving' || serving.served.length === 0) return undefined;
  const said = serving.served.map((s) => {
    const shipped = releasesAt(s.commit, releases).at(-1);
    return shipped ? `the commit release ${shipped.version} shipped` : 'a commit no release names';
  });
  return [...new Set(said)].join(' and ');
}

/**
 * The builds a requirement's coverage weighs its issues' verdicts on, by the basis the release weighs
 * their criteria on: on a project with no production environment, each issue's delivered build
 * (`landedBuildHolds`); where a promotion stands between the landing and production, or production
 * moves only by its releases (ISS-964), each issue's landing commit as `landingCriteriaReports` reads it (`landedBuildsOf`), with what later and earlier
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

/**
 * Where the release weighs at what is served, each of `issueIds` at its landing commit, by the very
 * reading `coverageLandingHolds` gives a landing basis (`landedBuildsOf`, `holdsOnBuilds`): a
 * requirement's coverage weighs there a verdict the live build does not hold (ISS-1018,
 * `requirements/standing-identity.ts:LiveBuildHolds.landings`), so one judged on a build that carries
 * its issue's landing outside the lineage production serves counts as its release would count it.
 */
export async function servedLandingHolds(
  projectId: string,
  issueIds: readonly string[],
  judged: ReadonlyMap<string, readonly JudgedAgainst[]> = new Map(),
): Promise<LandingHoldsRead['landed']> {
  if (issueIds.length === 0) return new Map();
  const builds = await landedBuildsOf(issueIds);
  return (await holdsOnBuilds(projectId, builds, judged)).landed;
}

/** One waiting issue weighed at its landing: each criterion that does not count there, and why. */
export interface LandingCriteriaReport {
  issueId: string;
  /** The landing commit weighed at; null where the issue's merge names none. */
  landing: string | null;
  /** Each criterion that holds it, and why; `liveOnly` where only the running product shows it, so a
   *  verdict at the landing never earns it and its `why` names the act that does (ISS-967). */
  unearned: Array<{ criterion: number; why: string; liveOnly?: true }>;
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
      c.counts
        ? []
        : [
            {
              criterion: c.criterion,
              why: c.why,
              after: c.afterRelease === true,
              ...(c.liveOnly ? { liveOnly: true as const } : {}),
            },
          ];
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
