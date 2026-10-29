/**
 * REQ-63 BC-4 under ISS-774: a merge GitLab reports (`source.merged`, from its merge request hook) is
 * information. It stamps no issue and closes no release; every issue the request delivers reads the
 * mark it owes, and a change-request release closes on Forge's own merge or the agent's mark. The
 * outbox runs as the server boots it, so a consumer that still wrote would show here.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { unlinkChangeRequestIssue } from '../../src/integrations/source-host/change-request-links.js';
import { owedMarks } from '../../src/issues/owed-merges.js';
import { issueWaitsOf } from '../../src/issues/standing-read.js';
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

// ISS-774 (owner ruling, 2026-10-29: Forge tells the agent, the agent records the merge): the host's
// report is information. It writes no mark and closes no release; each issue its request
// delivers reads the mark it owes, and the agent's mark is what closes the release.
describe('a merge the host reports writes nothing, and names the mark each delivered issue owes', () => {
  it('leaves ISS-1, ISS-2 and ISS-3 unmarked after !10 merges, each owing "mark merged !10"', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one, two, three, four } = await stack();
    await hostMerged(10, 'feat/req3-site-write-iss-1-2', HOST_SHA);
    for (const id of [one, two, three, four]) {
      expect((await issueRow(id))?.merged_at).toBeNull();
      expect((await issueRow(id))?.merged_commit_sha).toBeNull();
    }
    const waits = await issueWaitsOf(world.projectId, [one, two, three, four], null);
    for (const id of [one, two, three]) {
      const said = JSON.stringify(waits.get(id)?.standing.waitingOn);
      expect(said).toContain('issues.standing.act.markMerged');
      expect(said).toContain(HOST_SHA);
    }
    expect(JSON.stringify(waits.get(four)?.standing.waitingOn)).not.toContain('markMerged');
    expect((await owedMarks(world.projectId)).map((m) => m.number)).toEqual([10, 10, 10]);
  });

  // ISS-705: an issue a person unlinked is not delivered, though the branch itself names it
  it('owes no mark on ISS-2 once it is unlinked from !10', async () => {
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
    const owed = (await owedMarks(world.projectId)).map((m) => m.issueId).sort();
    expect(owed).toEqual([one, three].sort());
  });

  it("closes a change-request release on the agent's mark, never on the host's report of its last merge", async () => {
    await settleOutbox();
    await seedWorld(THROUGH_CHANGE_REQUESTS);
    const { one, two, three, four } = await stack();
    const runId = String((await cut([one, two, three, four], [10, 11])).body.runId);
    await approve(runId);
    expect((await mergeOf(one, 10)).status).toBe(200);
    await settleOutbox();

    await hostMerged(11, 'fix/req4-token-iss-4', HOST_SHA);

    expect(await issueRow(four)).toMatchObject({ status: 'awaiting_release', merged_at: null });
    const runStatus = async () =>
      (await rows<{ status: string }>(sql`SELECT status FROM pipeline_runs WHERE id = ${runId}`))[0]
        ?.status;
    expect(await runStatus()).toBe('running');

    const mark = await api(world.token, 'POST', `/api/issues/${four}/merge`, {
      target: BRANCH,
      commit: HOST_SHA,
      note: 'GitLab merged !11 into release/stg; marked by its agent',
    });
    expect(mark.status, JSON.stringify(mark.body)).toBe(200);

    for (const id of [one, two, three, four]) expect((await issueRow(id))?.status).toBe('closed');
    expect(await runStatus()).toBe('completed');
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
});
