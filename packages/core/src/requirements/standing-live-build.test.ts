// @direct-test-of packages/core/src/requirements/standing-live-build.ts
// Owner 2026-11-08 (D2): the list read REQ-78 passing 0/7 while its record read 7/7. One read over
// every listed requirement let another requirement's own verdict swap the landing's holds for the live
// build's of that verdict's commit alone; each requirement's build is now the one its record reads.
import { describe, expect, it, vi } from 'vitest';
import type { StandingIssueCriterion } from './standing.js';

const LANDED = 'a'.repeat(40);
const OWN = 'b'.repeat(40);
const LIVE = 'c'.repeat(40);

vi.mock('../issues/index.js', () => ({
  issueCoresOf: async (ids: readonly string[]) =>
    new Map(ids.map((id) => [id, { projectId: 'p' }])),
}));
vi.mock('./recorded-landings.js', () => ({ recordedLandingsOf: async () => new Map() }));
vi.mock('./dependents.js', () => ({
  requirementDependents: () => ({
    releasedLine: async () => null,
    // production stands behind a promotion: each issue's verdicts are weighed at its landing
    landingHolds: async () => ({
      sha: null,
      holds: new Map([[LANDED, true]]),
      runtimes: new Map(),
      unanswered: new Map(),
      promoted: true,
    }),
    // what the live build holds of the commits a verdict at the requirement itself names
    liveBuildHolds: async (_p: string, asked: { commits: readonly string[] }) => ({
      sha: LIVE,
      holds: new Map(asked.commits.map((c) => [c, true])),
      runtimes: new Map(),
      unanswered: new Map(),
    }),
    servedLandings: async () => new Map(),
  }),
}));

const { liveBuildsOf, liveBuildOf } = await import('./standing-live-build.js');

const traced = (issueId: string): StandingIssueCriterion =>
  ({
    issueId,
    n: 1,
    requirementCriterionId: `rc-${issueId}`,
    verdict: 'pass',
    verdictAt: new Date('2026-11-08T00:00:00Z'),
    identity: { kind: 'commit', sha: LANDED },
  }) as unknown as StandingIssueCriterion;

describe('each listed requirement’s build is the one its record reads (D2)', () => {
  const rows = [
    { id: 'req-78', traced: [traced('i1')], own: [] },
    { id: 'req-79', traced: [traced('i2')], own: [{ commit: OWN }] },
  ];

  it('weighs a requirement’s traced verdicts at their landing beside one holding its own verdict', async () => {
    const builds = await liveBuildsOf('p', rows);
    expect(builds.get('req-78')?.holds.get(LANDED)).toBe(true);
    expect(builds.get('req-79')?.holds.get(OWN)).toBe(true);
  });

  it('answers each row as its record’s own read does', async () => {
    const builds = await liveBuildsOf('p', rows);
    for (const r of rows) {
      expect(builds.get(r.id)).toEqual(await liveBuildOf('p', r.traced, r.own));
    }
  });

  it('reads nothing for a requirement none of whose criteria is judged', async () => {
    const builds = await liveBuildsOf('p', [{ id: 'req-1', traced: [], own: [] }]);
    expect(builds.get('req-1')).toBeNull();
  });
});
