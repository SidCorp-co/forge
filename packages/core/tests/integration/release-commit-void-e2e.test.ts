/**
 * ISS-900 — a fail judged at a release's build reads failing on that release, though it reopened its
 * issue. On a project whose releases are read by commit (production declares a source probe), a fail
 * judged at the build a release shipped reopened the issue, and the reopen voided that criterion's
 * verdicts for the issue's next round, so the release that shipped it read the criterion unjudged,
 * never failing. The rule agenfold's ISS-59 set for a release read by version holds here too: a
 * release that never shipped the fix reads the fail; from the release that ships it, the void holds.
 *
 * @direct-test-of packages/core/src/release-batch/judged-before-reopen.ts
 * @direct-test-of packages/core/src/release-batch/release-facts.ts
 * @direct-test-of packages/core/src/release-batch/release-read-views.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { reopenOnFail } from '../../src/issues/fail-reopen.js';
import { api } from '../helpers/api.js';
import { seedIssueStatus } from '../helpers/factories.js';
import {
  C1,
  F4,
  landedIssue,
  ok,
  record,
  seedLandedWorld,
  statusOf,
  world,
} from '../helpers/landed-world.js';
import { seedProduction } from '../helpers/release-world.js';

type ReleaseRead = {
  criteria: { proven: number; failing: number; total: number };
  issueCriteria: Array<{ key: string; criteria: Array<{ standing?: string }> }>;
};

const releaseOf = async (version: string) =>
  (await ok(api(world.token, 'GET', `/api/projects/${world.projectId}/releases/${version}`)))
    .release as unknown as ReleaseRead;

const judge = (issueId: string, n: number, verdict: 'pass' | 'fail', sha: string) =>
  ok(
    api(world.token, 'POST', `/api/issues/${issueId}/verdicts`, {
      criterion: n,
      verdict,
      reason: `${verdict === 'pass' ? 'Held' : 'Broke'} on production at ${sha.slice(0, 12)}.`,
      identity: { kind: 'commit', sha },
      evidence: ['https://catalog.example.test/clips/iss-7.webm'],
    }),
  );

const recorded = async (issueIds: string[], commit: string, version: string) => {
  const res = await record(issueIds, commit, { version });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
};

beforeEach(async () => {
  await seedLandedWorld();
  await seedProduction({ projectId: world.projectId, ownerId: world.ownerId, probes: 'source' });
});

describe('a release read by commit keeps a fail judged at its build (ISS-900)', () => {
  it('reads failing on the release that shipped it until one ships the fix', async () => {
    const iss7 = await landedIssue(7, F4, ['A product lists', 'A product opens']);
    for (const n of [1, 2]) await judge(iss7, n, 'pass', F4);
    await recorded([iss7], F4, '0.5.0');
    const failed = await judge(iss7, 1, 'fail', F4);
    // the fail-reopen consumer, as `verdict.recorded` runs it
    await reopenOnFail({
      criterion: 1,
      requirement: null,
      reason: 'Broke on production.',
      authorUserId: world.ownerId,
      authorDeviceId: null,
      agency: 'agent',
      issueId: iss7,
      verdictId: String((failed.verdict as { id?: string } | undefined)?.id ?? failed.id),
    });
    expect(await statusOf(iss7)).toBe('reopen');

    const shipped = await releaseOf('0.5.0');
    expect(shipped.criteria).toMatchObject({ proven: 1, failing: 1, total: 2 });
    const read = shipped.issueCriteria.find((i) => i.key === 'ISS-7');
    expect(read?.criteria.map((c) => c.standing)).toEqual(['fail', 'pass']);

    // the release that ships the fix judges it anew: the void holds there
    await seedIssueStatus(iss7, 'awaiting_release');
    await recorded([iss7], C1, '0.6.0');
    const fixed = (await releaseOf('0.6.0')).issueCriteria.find((i) => i.key === 'ISS-7');
    expect(fixed?.criteria.map((c) => c.standing)).toEqual(['unjudged', 'unjudged']);
    // and 0.5.0, which never shipped it, still reads the fail
    expect((await releaseOf('0.5.0')).criteria).toMatchObject({ failing: 1 });
  });
});
