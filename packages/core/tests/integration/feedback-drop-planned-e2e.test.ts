/**
 * Dropping a planned feedback item (feedback-lifecycle: `declined` is drawn from the stored
 * `triaged`, which reads planned while an issue carries it). QA of dev.219 could not drop FB-110: it
 * read planned, the item page offered no control, and the decline route refused it. Now a holder of
 * feedback.approve drops it with a reason; every other route is still refused for a planned item;
 * the carrying issue keeps its link and says the item was dropped.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  seedIssueStatus,
} from '../helpers/factories.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

type Who = 'owner' | 'member';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';

const at = (path: string) => `/api/projects/${projectId}${path}`;
const item = (fb: string, act = '') => at(`/feedback/${fb}${act ? `/${act}` : ''}`);

function refusal(r: Reply): Doc {
  expect(r.status, JSON.stringify(r.json)).toBeGreaterThanOrEqual(400);
  const [first] = r.json.error?.refusals ?? [];
  expect(first, JSON.stringify(r.json)).toBeDefined();
  return { code: first.code, path: first.path, detail: first.detail };
}

async function planned(title: string): Promise<{ fb: string; issue: string; issueId: string }> {
  const made = ok(
    await say('member', 'POST', at('/feedback'), { kind: 'bug', title, screen: 'The board' }),
    201,
  );
  const fb = made.feedback.key as string;
  const made2 = ok(await say('owner', 'POST', at('/issues'), { title: `Fix: ${title}` }), 201);
  const issue = made2.displayId as string;
  ok(
    await say('owner', 'POST', item(fb, 'triage'), {
      answers: TRIAGE_ANSWERS,
      route: 'issue',
      issue,
    }),
  );
  return { fb, issue, issueId: made2.id as string };
}

const read = async (fb: string, who: Who = 'owner'): Promise<Doc> =>
  ok(await say(who, 'GET', item(fb))).feedback;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const owner = (await createTestUser({ verified: true })).id;
  const member = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  await addProjectMember(projectId, member, 'member');
  say = requester(app, { owner: await signUserToken(owner), member: await signUserToken(member) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a planned item can be dropped with a reason', () => {
  it('offers Drop to a holder of feedback.approve and to nobody else', async () => {
    const { fb } = await planned('The probe item');
    const view = await read(fb);
    expect(view.phase).toBe('planned');
    expect(view.can).toMatchObject({ drop: true, triage: false });
    expect((await read(fb, 'member')).can.drop).toBe(false);
  });

  it('refuses every route but decline for a planned item, naming why', async () => {
    const { fb } = await planned('Only decline is open');
    const again = refusal(
      await say('owner', 'POST', item(fb, 'triage'), {
        answers: TRIAGE_ANSWERS,
        route: 'issue',
        createIssue: {},
      }),
    );
    expect(again.code).toBe('FEEDBACK_STATUS_INVALID');
    expect(again.detail).toContain('use the decline route with a reason');
    expect((await read(fb)).phase, 'a refused route must leave it planned').toBe('planned');
  });

  it('refuses a drop with no reason, and from a member without the approval', async () => {
    const { fb } = await planned('Drop needs a reason and a right');
    expect(refusal(await say('owner', 'POST', item(fb, 'triage'), { route: 'decline' })).code).toBe(
      'FEEDBACK_DECLINE_REASON_REQUIRED',
    );
    expect(
      refusal(await say('member', 'POST', item(fb, 'triage'), { route: 'decline', note: 'x' }))
        .code,
    ).toBe('PERMISSION_FORBIDDEN');
    expect((await read(fb)).phase).toBe('planned');
  });

  it('drops it, keeps the link on the carrying issue, and the issue says it was dropped', async () => {
    const { fb, issue } = await planned('Drop me');
    const kept = ok(await say('owner', 'GET', at(`/issues/standing/${issue}`))).standing;
    expect(kept).toMatchObject({ feedback: [fb], feedbackDropped: [] });
    const out = ok(
      await say('owner', 'POST', item(fb, 'triage'), {
        route: 'decline',
        note: 'The probe is finished.',
      }),
    ).feedback;
    expect(out.status).toBe('declined');
    expect(out.can.drop).toBe(false);
    const after = ok(await say('owner', 'GET', at(`/issues/standing/${issue}`))).standing;
    expect(after).toMatchObject({ feedback: [fb], feedbackDropped: [fb] });
  });

  it('does not drop a resolved item: the lifecycle draws no decline from there', async () => {
    const { fb, issueId } = await planned('Resolved is not droppable');
    await rows(sql`UPDATE issues SET merged_at = now() WHERE id = ${issueId}`);
    await seedIssueStatus(issueId, 'closed');
    const view = await read(fb);
    expect(view.phase).toBe('resolved');
    expect(view.can.drop).toBe(false);
    expect(
      refusal(await say('owner', 'POST', item(fb, 'triage'), { route: 'decline', note: 'x' })).code,
    ).toBe('FEEDBACK_STATUS_INVALID');
  });
});
