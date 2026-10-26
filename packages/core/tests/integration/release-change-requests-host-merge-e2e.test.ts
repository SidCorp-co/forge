/**
 * REQ-63 BC-4 through the host's own report: a merge GitLab reports (`source.merged`, from its merge
 * request hook) stamps every issue the request delivers, not only the one its branch leads with, and
 * the report of a change-request release's last merge closes that release. The outbox runs as the
 * server boots it, so the stamp and the settle are the consumer's own.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { unlinkChangeRequestIssue } from '../../src/integrations/source-host/change-request-links.js';
import { emitEvent } from '../../src/outbox/index.js';
import { api } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  BRANCH,
  hostMerged,
  issue,
  issueRow,
  mergeOf,
  mergeRequest,
  rows,
  seedWorld,
  world,
} from '../helpers/host-merge-world.js';
import { merged, trees } from '../helpers/planted-gitlab-merges.js';

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const planted = await import('../helpers/planted-gitlab-merges.js');
  return {
    ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
    resolveSourceHost: async () => planted.plantedRepository(),
    sourceHostForBinding: async () => planted.plantedSourceHost(),
  };
});

const HEAD_A = 'a1'.repeat(20);
const HEAD_B = 'b2'.repeat(20);
const _HEAD_C = 'c3'.repeat(20);
const THROUGH_CHANGE_REQUESTS = { approval: { required: true }, changeRequests: true };

const _linkedTo = (number: number) =>
  rows<{ key: number; linked_by: string }>(sql`
    SELECT i.iss_seq AS key, l.linked_by FROM repo_pull_request_issues l
      JOIN repo_pull_requests p ON p.id = l.pull_request_id
      JOIN issues i ON i.id = l.issue_id
     WHERE p.project_id = ${world.projectId} AND p.number = ${number}
     ORDER BY i.iss_seq`);

const cut = (issueIds: string[], changeRequests?: number[]) =>
  api(world.token, 'POST', `/api/projects/${world.projectId}/release-batches`, {
    issueIds,
    ...(changeRequests ? { changeRequests } : {}),
  });

const _codeOf = (body: unknown) => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

/** Two requests over three issues: !10 delivers ISS-1 and ISS-2 by branch and ISS-3 by description. */
async function stack() {
  const one = await issue(1, 'awaiting_release');
  const two = await issue(2, 'awaiting_release');
  const three = await issue(3, 'awaiting_release');
  const four = await issue(4, 'awaiting_release');
  await mergeRequest(
    10,
    'feat/req3-site-write-iss-1-2',
    HEAD_A,
    'Also delivers ISS-3. Serves REQ-4.',
  );
  await mergeRequest(11, 'fix/req4-token-iss-4', HEAD_B, null);
  return { one, two, three, four };
}

async function approve(runId: string) {
  const [pending] = await rows<{ id: string }>(sql`
    SELECT id FROM release_approvals WHERE run_id = ${runId} AND decision IS NULL`);
  const res = await api(
    world.token,
    'POST',
    `/api/projects/${world.projectId}/release-batches/${runId}/approvals/${pending?.id}/decision`,
    { decision: 'approve', reason: 'the owner read both merge requests and accepts them' },
  );
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const HOST_SHA = 'd4'.repeat(20);

describe('BC-4: a merge the host reports stamps every issue its request delivers', () => {
  it('stamps ISS-1, ISS-2 and ISS-3 from one report of !10', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one, two, three, four } = await stack();
    await hostMerged(10, 'feat/req3-site-write-iss-1-2', HOST_SHA);
    for (const id of [one, two, three]) {
      expect((await issueRow(id))?.merged_commit_sha).toBe(HOST_SHA);
    }
    expect((await issueRow(four))?.merged_commit_sha).toBeNull();
  });

  // ISS-705: an issue a person unlinked is not stamped, though the branch itself names it
  it('leaves ISS-2 unstamped once it is unlinked from !10', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one, two, three } = await stack();
    const off = await unlinkChangeRequestIssue({
      bindingId: world.bindingId,
      number: 10,
      label: '!10',
      issueId: two,
      issueKey: 'ISS-2',
      actor: { id: world.ownerId, agency: 'human' },
    });
    expect(off.ok).toBe(true);
    await hostMerged(10, 'feat/req3-site-write-iss-1-2', HOST_SHA);
    for (const id of [one, three]) {
      expect((await issueRow(id))?.merged_commit_sha).toBe(HOST_SHA);
    }
    expect((await issueRow(two))?.merged_commit_sha).toBeNull();
  });

  it('closes a change-request release when the host reports its last merge', async () => {
    await settleOutbox();
    await seedWorld(THROUGH_CHANGE_REQUESTS);
    const { one, two, three, four } = await stack();
    const runId = String((await cut([one, two, three, four], [10, 11])).body.runId);
    await approve(runId);
    expect((await mergeOf(one, 10)).status).toBe(200);
    await settleOutbox();

    await hostMerged(11, 'fix/req4-token-iss-4', HOST_SHA);

    expect(await issueRow(four)).toMatchObject({ status: 'closed', merged_commit_sha: HOST_SHA });
    for (const id of [one, two, three]) expect((await issueRow(id))?.status).toBe('closed');
    const [run] = await rows<{ status: string }>(sql`
      SELECT status FROM pipeline_runs WHERE id = ${runId}`);
    expect(run?.status).toBe('completed');
  });
});

// adminhub-api ISS-1, 2026-10-26: merged through Forge as !5008 into release/stg at cf94a1e6, and the
// stamp held merged_at with no target; 21 of 22 issues stamped by the route read the same.
describe('a merge through Forge records the target and the head on every issue it stamps', () => {
  it('stamps the base branch and the head, with its tree read identical, on ISS-1, ISS-2 and ISS-3', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one, two, three, four } = await stack();

    const res = await mergeOf(one, 10);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ target: BRANCH });

    for (const id of [one, two, three]) {
      expect(await issueRow(id)).toMatchObject({
        merged_commit_sha: merged.get(10),
        merged_target: BRANCH,
        merged_head: { sha: `0010${'a'.repeat(36)}`, treeIdentical: true, why: null },
      });
    }
    expect((await issueRow(four))?.merged_target).toBeNull();
  });

  it('keeps the head unread, with why, where the host could not say whether the trees match', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one } = await stack();
    trees.same = new Error('GitLab answered 503');

    expect((await mergeOf(one, 10)).status).toBe(200);

    const row = await issueRow(one);
    expect(row?.merged_head?.treeIdentical).toBeNull();
    expect(row?.merged_head?.why).toContain('GitLab answered 503');
  });

  it('keeps a tree reading when the host replays the same merge with no head or an unread one', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one } = await stack();
    expect((await mergeOf(one, 10)).status).toBe(200);
    const read = { sha: `0010${'a'.repeat(36)}`, treeIdentical: true, why: null };

    for (const head of [
      {
        ...read,
        treeIdentical: null,
        why: 'GitLab answered 503',
        readAt: new Date().toISOString(),
      },
      null,
    ]) {
      await emitEvent(db, 'source.merged', {
        projectId: world.projectId,
        headRef: 'feat/req3-site-write-iss-1-2',
        baseRef: BRANCH,
        commitSha: merged.get(10) as string,
        mergedAt: '2026-10-25T09:10:00.000Z',
        head,
      });
      await settleOutbox();
      expect((await issueRow(one))?.merged_head).toMatchObject(read);
    }
  });

  // catalog-fe ISS-11..19, 2026-10-26: !312 and !313 merged into `dev`, and the column read
  // `release/stg`, which a mark wrote into the column the route had left empty
  it('keeps the target the merge read when a later mark names another branch', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one } = await stack();
    expect((await mergeOf(one, 10)).status).toBe(200);

    const mark = await api(world.token, 'POST', `/api/issues/${one}/merge`, {
      target: 'release/prod',
      commit: merged.get(10),
    });
    expect(mark.status, JSON.stringify(mark.body)).toBe(200);

    expect((await issueRow(one))?.merged_target).toBe(BRANCH);
    expect(String(mark.body.detail)).toContain(
      '`release/prod`, which this call named, is recorded as its claim',
    );
  });

  // adminhub-api ISS-2, 2026-10-26: linked to !5011 and !5012; the first-wins stamp kept !5011
  // (68153bdf) though its work finished in !5012 (62bf8d33)
  it('lands an issue delivered across two requests at the later merge', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const one = await issue(1, 'awaiting_release');
    await mergeRequest(10, 'feat/req3-site-write-iss-1', HEAD_A, null);
    await mergeRequest(12, 'fix/req3-site-write-rest-iss-1', HEAD_B, null);

    const first = await mergeOf(one, 10);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await issueRow(one))?.merged_commit_sha).toBe(merged.get(10));
    expect((await mergeOf(one, 12)).status).toBe(200);

    const row = await issueRow(one);
    expect(row?.merged_commit_sha).toBe(merged.get(12));
    expect(new Date(String(row?.merged_at)).toISOString()).toBe('2026-10-23T09:12:00.000Z');
    expect(row?.merged_head?.sha).toBe(`0012${'a'.repeat(36)}`);
  });

  it('records the base branch a merge the host reports names', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one } = await stack();

    await hostMerged(10, 'feat/req3-site-write-iss-1-2', HOST_SHA);

    expect(await issueRow(one)).toMatchObject({
      merged_commit_sha: HOST_SHA,
      merged_target: BRANCH,
    });
  });
});
