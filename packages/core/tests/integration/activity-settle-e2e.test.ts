/**
 * ISS-1053: after a person settles an item on its own page, the workspace's Activity stops listing it
 * under "waiting on you" on its next read cycle, even where the glance it serves was read less than
 * 30 s before the act. The act's event reaches `ws/broadcast-subscribers.ts:tellOrg`, which marks the
 * project's held glances stale (`activity/read.ts:projectMoved`): the next read serves what is held,
 * starts its refresh and answers `refreshing: true`, so the page reads once more, and that read no
 * longer lists it. Before the fix the move reached the page but never the cache: the read after the
 * act answered `refreshing: false` and kept the row until the held glance aged out.
 *
 * @direct-test-of packages/core/src/activity/read.ts
 * @direct-test-of packages/core/src/activity/glance-cache.ts
 * @direct-test-of packages/core/src/ws/broadcast-subscribers.ts
 * @direct-test-of packages/contracts/src/outbox-consumers.ts
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import {
  closeWorld,
  type Doc,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  seedOrg,
} from '../helpers/factories.js';

let ownerId = '';
let token = '';
let orgId = '';
let projectId = '';
let questionId = '';

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  token = await userToken(ownerId);
  orgId = await seedOrg(ownerId);
  projectId = (await createTestProject(ownerId, { orgId })).id;
  const issue = await createTestIssue(projectId, ownerId, 7, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  const { askQuestion } = await import('../../src/questions/index.js');
  questionId = randomUUID();
  await askQuestion({
    id: questionId,
    projectId,
    issueId: issue.id,
    askedBy: ownerId,
    prompt: 'Which flag guards the tour?',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the flag' },
  } as never);
  await settleOutbox();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** The page's own read: the route, which waits on nothing kept off its path. */
async function pageRead(): Promise<{ refreshing: boolean; row: Doc }> {
  const res = await api(token, 'GET', `/api/orgs/${orgId}/activity`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const body = res.body as Doc;
  const row = (body.projects as Doc[]).find((p) => p.projectId === projectId) as Doc;
  return { refreshing: body.refreshing === true, row };
}

const listsTheQuestion = (row: Doc) =>
  (row.people.items as Doc[]).some((i) => i.decisionId === `question:${questionId}`);

describe('ISS-1053 a settled decision leaves Activity on the next read cycle', () => {
  it('a question answered under 30 s after the glance was read clears once the page reads again', async () => {
    const { readOrgActivity, peopleGlances } = await import('../../src/activity/read.js');
    peopleGlances.forget();
    // the glance the page serves, read just now: under 30 s old when the person answers
    const warm = await readOrgActivity(orgId, { userId: ownerId, agency: 'human' }, new Date(), {
      waitMs: 60_000,
    });
    const before = warm.projects.find((p) => p.projectId === projectId);
    expect(before?.people.items.map((i) => i.decisionId)).toContain(`question:${questionId}`);

    const answered = await api(token, 'POST', `/api/questions/${questionId}/answer`, {
      round: 1,
      text: 'tours.v2',
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    // the answer's event is delivered to the org-activity consumer, which tells the page and the cache
    await settleOutbox();

    const next = await pageRead();
    expect(next.refreshing, 'the read after the answer started no refresh').toBe(true);

    // the page reads again while `refreshing`; the refresh it started has landed by its next read
    const until = Date.now() + 30_000;
    let after = await pageRead();
    while (after.refreshing && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      after = await pageRead();
    }
    expect(after.refreshing).toBe(false);
    expect(listsTheQuestion(after.row), 'the answered question is still waiting on you').toBe(
      false,
    );
    expect(after.row.people.total).toBe(0);
  }, 90_000);
});
