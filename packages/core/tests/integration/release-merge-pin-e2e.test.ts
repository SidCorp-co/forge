/**
 * ISS-1114 (FB-571, adminhub-api 0.16.0, 2026-11-07): the release was cut on promotion !5193 and its
 * approval named 7af1ce5b; ISS-211 then merged into `release/stg`, moving !5193's head to 778740be.
 * `merge-pull-request` took its expected head from the caller (`headSha`), so a caller naming the new
 * head merged an issue outside the roster and a contract the owner never approved. Core now derives
 * the head a release merges at from the release's approval, refuses a request carrying any other
 * head by name (both shas, the commits between, and the way out), and lets no caller move the pin.
 * The way out it names works: once the owner approves the new head, that head merges.
 *
 * GitLab is planted: the request's head on the host, the commits between, and every merge it makes.
 *
 * ISS-1349 (FB-759, sidcorp-mail, 2026-11-19): a merge naming release run 08d38871, cancelled two
 * minutes before, merged release MR !92, and its deploy was then refused RELEASE_RUN_NOT_OPEN. The
 * caller's `runId` is now read: an ended run, or one that is not the release holding the request,
 * merges nothing and names the run that holds it.
 *
 * ISS-1410 c4 (FB-821 carried the same correction again): a release run that finished is refused
 * naming its state as a cancelled one is, and merges nothing.
 *
 * @direct-test-of packages/core/src/integrations/source-host/merge.ts
 * @direct-test-of packages/core/src/integrations/source-host/merge-landed.ts
 * @direct-test-of packages/core/src/integration-door/issue-merge-routes.ts
 * @direct-test-of packages/core/src/release-batch/change-request-merge.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  call,
  codeOf,
  EXTERNAL,
  landedIssues,
  PROD,
  promotionRequest,
  seedPromotionWorld,
  world,
} from '../helpers/promotion-world.js';

const APPROVED = '7af1ce5b'.padEnd(40, '1');
const MOVED = '778740be'.padEnd(40, '2');
const ISS_211 = 'ab211211'.padEnd(40, '3');
const LANDING = 'e1e1e1e1'.padEnd(40, '4');

const planted = vi.hoisted(() => ({
  head: '',
  merges: [] as string[],
  between: [] as Array<{ sha: string; message: string; parents: string[] }>,
}));

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const host = {
    provider: 'gitlab',
    fullName: 'acme/adminhub-api',
    words: { mergeMethods: ['merge', 'squash'], changeRequest: 'merge request', sigil: '!' },
    compare: async () => 'diverged',
    readChangeRequestChecks: async () => [],
    readChangeRequest: async (number: number) => ({
      number,
      url: null,
      title: 'Promote release/stg to production',
      state: planted.merges.length > 0 ? 'merged' : 'open',
      draft: false,
      headRef: 'release/stg',
      headSha: planted.head,
      baseRef: 'release/production',
      baseSha: null,
      updatedAt: null,
      body: null,
      mergedAt: planted.merges.length > 0 ? '2026-11-07T13:00:00.000Z' : null,
      mergeCommitSha: planted.merges.length > 0 ? LANDING : null,
    }),
    branchContains: async () => false,
    readRange: async () => ({ ok: true, commits: planted.between, complete: true }),
    readCommit: async () => null,
    sameTree: async () => true,
    // GitLab's own merge holds the `sha` it is sent, as `merge.ts:mergeGitLabMergeRequest` does
    merge: async ({ expectedHeadSha }: { expectedHeadSha?: string }) => {
      if (expectedHeadSha && !planted.head.startsWith(expectedHeadSha)) {
        return { kind: 'refused', reason: 'head-moved', detail: `head is ${planted.head}` };
      }
      planted.merges.push(planted.head);
      return {
        kind: 'merged',
        commitSha: LANDING,
        mergedAt: new Date('2026-11-07T13:00:00Z'),
        target: PROD,
        head: planted.head,
      };
    },
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
  planted.head = APPROVED;
  planted.merges = [];
  planted.between = [];
});

type Refusal = { code: string; detail: string };
const refusalOf = (body: unknown) =>
  ((body as { error?: { refusals?: Refusal[] } }).error?.refusals ?? [])[0];

/** The owner's go on the run's pending approval request. */
async function approve(runId: string) {
  const [pending] = [
    ...(await db.execute<{ id: string }>(sql`
      SELECT id FROM release_approvals WHERE run_id = ${runId} AND decision IS NULL`)),
  ];
  const res = await call('POST', `/release-batches/${runId}/approvals/${pending?.id}/decision`, {
    decision: 'approve',
    reason: 'the owner read !5193 at its head and approves it',
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

/** 0.16.0 cut on !5193 at the head the owner approved, then ISS-211 moving the head on GitLab. */
async function approvedThenMoved() {
  const ids = await landedIssues();
  await promotionRequest(5193, APPROVED);
  const cut = await call('POST', '/release-batches', {
    issueIds: ids,
    promotion: { request: 5193 },
  });
  expect(cut.status, JSON.stringify(cut.body)).toBe(201);
  const runId = String(cut.body.runId);
  await approve(runId);
  planted.head = MOVED;
  planted.between = [{ sha: ISS_211, message: 'ISS-211: contract 17.1.0', parents: [APPROVED] }];
  return { ids, runId };
}

const mergeOf = (issueId: string, body: Record<string, unknown>) =>
  api(world.token, 'POST', `/api/issues/${issueId}/merge-pull-request`, {
    pullRequest: 5193,
    ...body,
  });

describe('a release merge is held to the head its approval names (FB-571)', () => {
  it('refuses a caller naming the moved head, and merges nothing', async () => {
    const { ids } = await approvedThenMoved();

    const res = await mergeOf(ids[0] as string, { headSha: MOVED });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusal = refusalOf(res.body);
    expect(refusal?.code).toBe('RELEASE_MERGE_HEAD_MOVED');
    expect(refusal?.detail).toContain(APPROVED);
    expect(refusal?.detail).toContain('a caller cannot move it');
    expect(planted.merges, 'the unapproved head never merged').toEqual([]);
  });

  it('refuses the moved head with no caller head, naming both shas, the commits between and the way out', async () => {
    const { ids } = await approvedThenMoved();
    // GitLab's hook reported the push: the projection carries the moved head too
    await promotionRequest(5193, MOVED);

    const res = await mergeOf(ids[0] as string, {});

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusal = refusalOf(res.body);
    expect(refusal?.code).toBe('RELEASE_MERGE_HEAD_MOVED');
    expect(refusal?.detail).toContain(`head is ${MOVED}`);
    expect(refusal?.detail).toContain(`merges only ${APPROVED}, the head its approval names`);
    expect(refusal?.detail).toContain(
      '1 commit between them: ab2112113333 ISS-211: contract 17.1.0',
    );
    expect(refusal?.detail).toContain(
      'abort the release and cut it again, or have the new head approved',
    );
    expect(planted.merges).toEqual([]);
  });

  it('refuses the moved head the projection never heard of, from the host’s own read', async () => {
    const { ids } = await approvedThenMoved();

    const res = await mergeOf(ids[0] as string, {});

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(refusalOf(res.body)?.code).toBe('RELEASE_MERGE_HEAD_MOVED');
    expect(planted.merges).toEqual([]);
  });

  it('merges the new head once the owner approves it', async () => {
    const { ids, runId } = await approvedThenMoved();
    await promotionRequest(5193, MOVED);
    const asked = await call('POST', `/release-batches/${runId}/approvals`, {
      evidence: { commit: MOVED, reading: '!5193 at 778740be carries ISS-211; approved with it.' },
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    await approve(runId);

    const res = await mergeOf(ids[0] as string, {});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ merged: true, alreadyMerged: false, commitSha: LANDING });
    expect(planted.merges).toEqual([MOVED]);
  });

  it('merges the approved head, unchanged, as it always did', async () => {
    const ids = await landedIssues();
    await promotionRequest(5193, APPROVED);
    const cut = await call('POST', '/release-batches', {
      issueIds: ids,
      promotion: { request: 5193 },
    });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    await approve(String(cut.body.runId));

    const res = await mergeOf(ids[0] as string, { headSha: APPROVED.slice(0, 12) });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(planted.merges).toEqual([APPROVED]);
    expect(codeOf(res.body)).toBeNull();
  });
});

/** A run of the project standing beside the release: a release-batch run that ended, or any open run. */
async function sideRun(kind: 'system' | 'interactive', status: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${id}, ${world.projectId}, ${kind}, ${status}, now(),
            ${JSON.stringify(kind === 'system' ? { source: 'release-batch' } : {})}::jsonb)`);
  return id;
}

/** 0.16.0 cut on !5193 and approved at its head, which has not moved. */
async function approvedRelease() {
  const ids = await landedIssues();
  await promotionRequest(5193, APPROVED);
  const cut = await call('POST', '/release-batches', {
    issueIds: ids,
    promotion: { request: 5193 },
  });
  expect(cut.status, JSON.stringify(cut.body)).toBe(201);
  const runId = String(cut.body.runId);
  await approve(runId);
  return { ids, runId };
}

describe('a merge naming a run is held to the release that holds the request (ISS-1349, FB-759)', () => {
  it('refuses a release run that was cancelled, naming the run holding the request, and merges nothing', async () => {
    const { ids, runId } = await approvedRelease();
    const cancelled = await sideRun('system', 'cancelled');

    const res = await mergeOf(ids[0] as string, { runId: cancelled });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusal = refusalOf(res.body);
    expect(refusal?.code).toBe('MERGE_RUN_NOT_OPEN');
    expect(refusal?.detail).toContain(`${cancelled} names a run that is cancelled`);
    expect(refusal?.detail).toContain(`Release run ${runId} holds this request`);
    expect(planted.merges, 'nothing merged for an ended run').toEqual([]);
  });

  it('refuses a release run that finished, naming its state, and merges nothing', async () => {
    const { ids, runId } = await approvedRelease();
    const finished = await sideRun('system', 'completed');

    const res = await mergeOf(ids[0] as string, { runId: finished });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusal = refusalOf(res.body);
    expect(refusal?.code).toBe('MERGE_RUN_NOT_OPEN');
    expect(refusal?.detail).toContain(`${finished} names a run that is completed`);
    expect(refusal?.detail).toContain(`Release run ${runId} holds this request`);
    expect(planted.merges, 'nothing merged for a finished run').toEqual([]);
  });

  it('refuses an open run that is not the release holding the request', async () => {
    const { ids, runId } = await approvedRelease();
    const other = await sideRun('interactive', 'running');

    const res = await mergeOf(ids[0] as string, { runId: other });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusal = refusalOf(res.body);
    expect(refusal?.code).toBe('MERGE_RUN_NOT_THE_RELEASE');
    expect(refusal?.detail).toContain(`Release run ${runId} holds this request`);
    expect(planted.merges).toEqual([]);
  });

  it('merges naming the release that holds the request, as a merge naming none does', async () => {
    const { ids, runId } = await approvedRelease();

    const res = await mergeOf(ids[0] as string, { runId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ merged: true, release: { runId } });
    expect(planted.merges).toEqual([APPROVED]);
  });
});
