/**
 * A mark naming a commit the repository vouches for is a merge Forge observed, whoever marks it and
 * whatever work evidence the issue already carries. On forge dev, 2026-10-30, the repository was read
 * only for an agent's mark on an issue with no work evidence: ISS-781's mark at 8cf12bc1e read
 * `observed`, while ISS-562's at 61043f926 (its run had recorded its branch; the subject names
 * ISS-562) and ISS-783's at e54c95e12 (a person's mark at the merge of #1235, which links ISS-783,
 * made before the host's report of that merge reached the projection) read `asserted`, with
 * `merged_commit_sha` empty. A commit the repository does not vouch for is still recorded as the
 * caller's claim, as before, and the mark says why the repository did not take it.
 *
 * @direct-test-of packages/core/src/issues/merge-marker.ts
 * @direct-test-of packages/core/src/issues/commit-landing.ts
 * @direct-test-of packages/core/src/issues/merge-identity.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestDevice } from '../helpers/factories.js';
import {
  BRANCH,
  issue,
  issueRow,
  mergeRequest,
  rows,
  seedWorld,
  world,
} from '../helpers/host-merge-world.js';
import { messages } from '../helpers/planted-gitlab-merges.js';
import { boxToken } from '../helpers/preview-world.js';

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const planted = await import('../helpers/planted-gitlab-merges.js');
  return {
    ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
    resolveSourceHost: async () => planted.plantedRepository(),
    sourceHostForBinding: async () => planted.plantedSourceHost(),
  };
});

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const C4 = '61043f92'.repeat(5);
const PR_1235 = 'e54c95e1'.repeat(5);
let box = '';

async function world_() {
  await settleOutbox();
  await seedWorld(null);
  box = await boxToken(world.ownerId, await createTestDevice(world.ownerId));
}

const mark = (token: string, issueId: string, commit: string) =>
  api(token, 'POST', `/api/issues/${issueId}/merge`, { commit, target: BRANCH });

const detailOf = (body: unknown) => JSON.stringify(body);

describe('a mark naming a commit the repository vouches for is observed', () => {
  it('observes a run’s mark on an issue that carries its branch (ISS-562 at 61043f926)', async () => {
    await world_();
    messages.set(C4, 'test(core): the old-query probe types its query builders (ISS-562)');
    const iss562 = await issue(562, 'in_progress');
    // the branch its run recorded: work evidence, which kept the mark from reading the repository
    await rows(sql`
      INSERT INTO issue_work_state (issue_id, branch) VALUES (${iss562}, 'fix/iss562-c4-retired-query')
      ON CONFLICT (issue_id) DO UPDATE SET branch = excluded.branch`);

    const res = await mark(box, iss562, C4);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(iss562))?.merged_commit_sha).toBe(C4);
    expect(detailOf(res.body)).toContain('this mark is a merge Forge observed');
  });

  it('observes a person’s mark at a request’s merge that links the issue, before the host reports it (ISS-783 at e54c95e12)', async () => {
    await world_();
    const iss783 = await issue(783, 'in_progress');
    await mergeRequest(1235, 'req-80-env-variables', 'a'.repeat(40), 'Delivers ISS-783.');
    messages.set(PR_1235, 'Merge pull request #1235 from SidCorp-co/req-80-env-variables');

    const res = await mark(world.token, iss783, PR_1235);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(iss783))?.merged_commit_sha).toBe(PR_1235);
    expect(detailOf(res.body)).toContain('this mark is a merge Forge observed');
  });

  it('keeps a commit declaring another issue as the caller’s claim, and says why', async () => {
    await world_();
    const other = 'd5'.repeat(20);
    messages.set(other, 'fix(core): the header keeps its height (ISS-55)');
    const iss562 = await issue(562, 'in_progress');

    const res = await mark(world.token, iss562, other);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(iss562))?.merged_commit_sha).toBeNull();
    const detail = detailOf(res.body);
    expect(detail).toContain('this mark is a CLAIM Forge did not observe');
    expect(detail).toContain('COMMIT_NOT_THIS_ISSUE');
    expect(detail).toContain('it declares ISS-55');
  });

  it('keeps a commit the repository does not hold as the caller’s claim, and says why', async () => {
    await world_();
    const iss562 = await issue(562, 'in_progress');

    const res = await mark(world.token, iss562, 'f0'.repeat(20));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(iss562))?.merged_commit_sha).toBeNull();
    expect(detailOf(res.body)).toContain('COMMIT_NOT_IN_REPOSITORY');
  });
});
