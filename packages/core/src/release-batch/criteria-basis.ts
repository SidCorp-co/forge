// Where the automatic release weighs an issue's acceptance criteria before it carries the issue.
//
// Where landing on the issue's branch IS deploying production (no promotion stands between), a
// criterion is earned at what production serves: the change is running there once it lands. Where a
// promotion stands between (sidcorp-mail, 2026-10-27: work lands on `dev`, production deploys
// `master`), what production serves cannot hold the change before the release that promotes it, so
// weighing there held every waiting issue for ever. There a criterion is earned at the issue's
// landing commit, or on the testing environment `delivery.judgedOn` names (REQ-36 BC-18), as a
// recorded landing weighs it (`landed-build.ts:landedStandings`).

import { readReleasePath } from '../project-config/index.js';
import { landedBuildsOf, landedStandings } from './landed-build.js';

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

/** One waiting issue weighed at its landing: each criterion that does not count there, and why. */
export interface LandingCriteriaReport {
  issueId: string;
  /** The landing commit weighed at; null where the issue's merge names none. */
  landing: string | null;
  unearned: Array<{ criterion: number; why: string }>;
}

/** Each of `issueIds` weighed at its landing commit, in the order given. */
export async function landingCriteriaReports(
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
      return { issueId, landing: null, unearned: owed.map((criterion) => ({ criterion, why })) };
    }
    return {
      issueId,
      landing: build.sha,
      unearned: criteria.flatMap((c) => (c.counts ? [] : [{ criterion: c.criterion, why: c.why }])),
    };
  });
}
