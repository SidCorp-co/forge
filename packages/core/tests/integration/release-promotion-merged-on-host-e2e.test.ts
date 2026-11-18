/**
 * ISS-1333 (FB-743, gwork 0.61.0, 2026-11-18): the release's one change request, its promotion #234,
 * was merged on the host before the master's call. `merge-pull-request` answered `alreadyMerged`,
 * `stamped: false` (a promotion stamps no issue, every roster issue already holds its own landing) and
 * its check read was refused HTTP 403, and the release went on reading "merge the requests in order"
 * while the master's owed line read "1 of 1 merged". The release page counted a step merged only
 * through a link from one of its roster issues to the request (`change-request-roster.ts:unmergedSteps`
 * over `readChangeRequestLinks`), and a promotion request names no issue, so it was never counted
 * merged whatever the host or the projection said. The step's own request row is what says it merged.
 *
 * The host is planted: the request already merged on it, and its commit-status read refused.
 *
 * @direct-test-of packages/core/src/release-batch/release-read.ts
 * @direct-test-of packages/core/src/release-batch/release-read-views.ts
 * @direct-test-of packages/core/src/release-batch/change-request-roster.ts
 * @direct-test-of packages/core/src/release-batch/change-request-settle.ts
 * @direct-test-of packages/core/src/integration-door/issue-merge-routes.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { releaseMergesOwed } from '../../src/release-batch/merges-owed.js';
import { api } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  call,
  EXTERNAL,
  HEAD,
  landedIssues,
  PROD,
  promotionRequest,
  seedPromotionWorld,
  world,
} from '../helpers/promotion-world.js';

const LANDING = 'f676efc5'.padEnd(40, '5');
const FORBIDDEN = `GET /repos/acme/gwork/commits/${HEAD}/status on acme/gwork returned HTTP 403`;

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const host = {
    provider: 'gitlab',
    fullName: 'acme/gwork',
    words: { mergeMethods: ['merge', 'squash'], changeRequest: 'merge request', sigil: '!' },
    compare: async () => 'diverged',
    readChangeRequestChecks: async () => {
      throw new Error(FORBIDDEN);
    },
    // merged on the host before the call: the host answers it merged, at its landing
    readChangeRequest: async (number: number) => ({
      number,
      url: null,
      title: 'Release 0.61.0',
      state: 'merged',
      draft: false,
      headRef: 'release/stg',
      headSha: HEAD,
      baseRef: PROD,
      baseSha: null,
      updatedAt: null,
      body: null,
      mergedAt: '2026-11-18T13:55:00.000Z',
      mergeCommitSha: LANDING,
    }),
    merge: async () => ({
      kind: 'already-merged',
      commitSha: LANDING,
      mergedAt: new Date('2026-11-18T13:55:00Z'),
      target: PROD,
      head: HEAD,
    }),
    branchContains: async () => true,
    readRange: async () => ({ ok: true, commits: [], complete: true }),
    readCommit: async () => null,
    sameTree: async () => true,
  };
  return {
    ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
    resolveSourceHost: async () => host,
    sourceHostForBinding: async () => host,
  };
});

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  await seedPromotionWorld(EXTERNAL);
});

/** The owner's go on the run's pending approval request, where one was asked. */
async function approve(runId: string) {
  const [pending] = [
    ...(await db.execute<{ id: string }>(sql`
      SELECT id FROM release_approvals WHERE run_id = ${runId} AND decision IS NULL`)),
  ];
  if (!pending) return;
  const res = await call('POST', `/release-batches/${runId}/approvals/${pending.id}/decision`, {
    decision: 'approve',
    reason: 'the owner read #234 at its head and approves it',
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

/** 0.61.0 cut and approved on its promotion #234, which names no issue, and merged on the host. */
async function cutAndMergedOnHost() {
  const ids = await landedIssues();
  await promotionRequest(234, HEAD);
  const cut = await call('POST', '/release-batches', {
    issueIds: ids,
    promotion: { request: 234 },
  });
  expect(cut.status, JSON.stringify(cut.body)).toBe(201);
  await approve(String(cut.body.runId));
  return { ids, runId: String(cut.body.runId), version: String(cut.body.version) };
}

const standingOf = async (version: string) => {
  const res = await call('GET', `/releases/${version}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { release: { waitingOn: { act: string; rule: string; who: string } } })
    .release.waitingOn;
};

describe('a promotion merged on the host before the call moves its release on (ISS-1333)', () => {
  it('answers the merge, names why the release still waits, and reads it waiting on its record', async () => {
    const { ids, runId, version } = await cutAndMergedOnHost();

    const res = await api(world.token, 'POST', `/api/issues/${ids[0]}/merge-pull-request`, {
      pullRequest: 234,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as {
      alreadyMerged: boolean;
      stamped: boolean;
      checks: { outcome: string; reason?: string };
      release: { runId: string; settled: boolean; pending: string | null; waits: string | null };
    };
    expect(body).toMatchObject({ alreadyMerged: true, stamped: false });
    // the check read refused is reported beside the merge and holds nothing
    expect(body.checks).toMatchObject({ outcome: 'unread' });
    expect(body.checks.reason).toContain('HTTP 403');
    // the release reads its record owed, never a merge already made
    const waiting = await standingOf(version);
    expect(waiting.act).not.toBe('merge the requests in order');
    expect(waiting.act).toBe('record the release production serves');
    // and the master is owed no merge for it
    expect(await releaseMergesOwed(world.projectId)).toEqual([]);
    // the release's answer says what it waits on by name, and which door ends the wait
    expect(body.release).toMatchObject({ runId, settled: false, pending: 'record' });
    expect(body.release.waits).toContain(`/api/projects/${world.projectId}/release-records`);
  });

  it('reads the step merged from its request even before any call, the projection having heard the host', async () => {
    const { version } = await cutAndMergedOnHost();
    await db.execute(sql`
      UPDATE repo_pull_requests SET state = 'merged', merge_commit_sha = ${LANDING}, merged_at = now()
       WHERE project_id = ${world.projectId} AND number = 234`);

    const waiting = await standingOf(version);
    expect(waiting.act).not.toBe('merge the requests in order');
    // the master records the merge through the merge door first: it is owed, 1 of 1 merged
    const owed = await releaseMergesOwed(world.projectId);
    expect(owed.map((o) => [o.merged, o.total])).toEqual([[1, 1]]);
  });
});
