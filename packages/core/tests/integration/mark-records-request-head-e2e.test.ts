/**
 * ISS-1168 (adminhub-api, 2026-11-09): on a project releasing through change requests, a request a
 * person merged on the host and the master then marked through `POST /api/issues/:id/merge` carried
 * no head, so a verdict judged at that request's head, its tree identical to the merge commit's,
 * never counted for the landing (REQ-63 BC-6) and about 100 criteria read as owing a re-judge. The
 * mark now records the head as Forge's own merge door does (`readMergedHead`), and a one-time pass
 * gives the marks already standing theirs. A head whose tree differs, or could not be read, still
 * does not count.
 *
 * @direct-test-of packages/core/src/issues/host-mark.ts
 * @direct-test-of packages/core/src/issues/merged-head-backfill.ts
 * @direct-test-of packages/core/src/issues/merge-record.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { runMarkedRequestHeadBackfillOnce } from '../../src/issues/index.js';
import { landingCriteriaReports } from '../../src/release-batch/criteria-basis.js';
import { api } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { seedIssueStatus } from '../helpers/factories.js';
import {
  BRANCH,
  hostMerged,
  issue,
  issueRow,
  mergeRequest,
  rows,
  seedWorld,
  stampObserved,
  world,
} from '../helpers/host-merge-world.js';
import { trees } from '../helpers/planted-gitlab-merges.js';

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const planted = await import('../helpers/planted-gitlab-merges.js');
  return {
    ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
    resolveSourceHost: async () => planted.plantedRepository(),
    sourceHostForBinding: async () => planted.plantedSourceHost(),
  };
});

const HEAD = 'a1'.repeat(20);
const MERGE = 'd4'.repeat(20);
const BRANCH_REF = 'feat/req1-site-write-iss-1';
const THROUGH_CHANGE_REQUESTS = { approval: { required: true }, changeRequests: true };
/** adminhub-api's delivery policy since its criteria are judged: a verdict is owed on each one. */
const JUDGED = { delivery: { verdictsRequired: true } };

/** ISS-1, its two criteria, delivered by !10 at HEAD, which the host merged as MERGE. */
async function mergedOnHost(): Promise<string> {
  const id = await issue(1, 'in_progress');
  await replaceCriteria(id, [
    { n: 1, statement: 'A site writes through to the catalog' },
    { n: 2, statement: 'A failed write is retried once' },
  ]);
  await seedIssueStatus(id, 'awaiting_release');
  await mergeRequest(10, BRANCH_REF, HEAD, null);
  await hostMerged(10, BRANCH_REF, MERGE);
  return id;
}

/** QA's pass on every criterion, judged at `commit`. */
async function passedAt(issueId: string, commit: string) {
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    author_user_id, author_agency, judge)
    SELECT c.id, ${issueId}, 'pass', ${`pass on the box at ${commit}`}, 'commit', ${commit},
           ${world.ownerId}, 'agent', 'qa'
      FROM issue_criteria c WHERE c.issue_id = ${issueId} AND c.retired_at IS NULL
  `);
}

const markMerged = (id: string) =>
  api(world.token, 'POST', `/api/issues/${id}/merge`, { target: BRANCH, commit: MERGE });

async function weighed(id: string) {
  const [report] = await landingCriteriaReports(world.projectId, [id]);
  return report;
}

beforeAll(async () => {
  testEnv();
  await startQueue({ pollSeconds: 0.5 });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  await seedWorld(THROUGH_CHANGE_REQUESTS, JUDGED);
});

describe('a mark on the host merge of a request records that request’s head', () => {
  it('counts a verdict judged at the request’s tree-identical head for the landing', async () => {
    const id = await mergedOnHost();
    const mark = await markMerged(id);
    expect(mark.status, JSON.stringify(mark.body)).toBe(200);
    await passedAt(id, HEAD);

    const report = await weighed(id);
    expect(report?.landing).toBe(MERGE);
    expect(report?.unearned).toEqual([]);
    expect(report?.counted.map((c) => c.criterion)).toEqual([1, 2]);
    expect(await issueRow(id)).toMatchObject({
      merged_commit_sha: MERGE,
      merged_target: BRANCH,
      merged_head: { sha: HEAD, treeIdentical: true, why: null },
    });
  });

  it('does not count a verdict at a head whose tree differs from the landing’s', async () => {
    const id = await mergedOnHost();
    trees.same = false;
    expect((await markMerged(id)).status).toBe(200);
    await passedAt(id, HEAD);

    expect((await issueRow(id))?.merged_head).toMatchObject({ sha: HEAD, treeIdentical: false });
    const report = await weighed(id);
    expect(report?.counted).toEqual([]);
    expect(report?.unearned[0]?.why).toContain('the host shows the two trees differ');
  });

  it('keeps a head the host could not read unread, with why, and does not count it', async () => {
    const id = await mergedOnHost();
    trees.same = new Error('GitLab answered 503');
    expect((await markMerged(id)).status).toBe(200);
    await passedAt(id, HEAD);

    const row = await issueRow(id);
    expect(row?.merged_head?.treeIdentical).toBeNull();
    expect(row?.merged_head?.why).toContain('GitLab answered 503');
    const report = await weighed(id);
    expect(report?.counted).toEqual([]);
    expect(report?.unearned[0]?.why).toContain('whether the two trees are identical was not read');
  });

  it('fills the head on a stamp of this merge holding none when the issue is marked again', async () => {
    const id = await mergedOnHost();
    await stampObserved(id, MERGE, '2026-10-23T10:00:00.000Z');
    expect((await issueRow(id))?.merged_head).toBeNull();

    expect((await markMerged(id)).status).toBe(200);

    expect((await issueRow(id))?.merged_head).toMatchObject({ sha: HEAD, treeIdentical: true });
  });
});

describe('the marks already standing are given their request’s head once', () => {
  it('fills a standing mark’s head from the projection and the host, moving nothing else', async () => {
    const id = await mergedOnHost();
    await stampObserved(id, MERGE, '2026-10-23T10:00:00.000Z');
    await passedAt(id, HEAD);
    const before = await issueRow(id);
    expect((await weighed(id))?.counted).toEqual([]);

    const report = await runMarkedRequestHeadBackfillOnce();

    expect(report?.projects).toEqual([
      expect.objectContaining({ projectId: world.projectId, ambiguous: [] }),
    ]);
    expect(report?.projects[0]?.filled.map((f) => f.issueId)).toEqual([id]);
    const after = await issueRow(id);
    expect(after).toMatchObject({
      status: before?.status,
      merged_commit_sha: before?.merged_commit_sha,
      merged_target: before?.merged_target,
      merged_head: { sha: HEAD, treeIdentical: true, why: null },
    });
    expect(after?.merged_at).toEqual(before?.merged_at);
    expect((await weighed(id))?.counted.map((c) => c.criterion)).toEqual([1, 2]);

    // the second run is a no-op: the marker stands, and the row is as the first run left it
    expect(await runMarkedRequestHeadBackfillOnce()).toBeNull();
    expect(await issueRow(id)).toEqual(after);
    const markers = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM backfill_markers WHERE key = 'marked-request-head'`,
    );
    expect(markers[0]?.n).toBe(1);
  });

  it('keeps a standing mark’s head unread, with why, where the host cannot say', async () => {
    const id = await mergedOnHost();
    await stampObserved(id, MERGE, '2026-10-23T10:00:00.000Z');
    trees.same = new Error('GitLab answered 503');

    await runMarkedRequestHeadBackfillOnce();

    const row = await issueRow(id);
    expect(row?.merged_head).toMatchObject({ sha: HEAD, treeIdentical: null });
    expect(row?.merged_head?.why).toContain('GitLab answered 503');
  });

  it('leaves a project that does not release through change requests as it was', async () => {
    await seedWorld({ approval: { required: true } }, JUDGED);
    const id = await mergedOnHost();
    await stampObserved(id, MERGE, '2026-10-23T10:00:00.000Z');

    const report = await runMarkedRequestHeadBackfillOnce();

    expect(report?.projects).toEqual([]);
    expect((await issueRow(id))?.merged_head).toBeNull();
  });
});
