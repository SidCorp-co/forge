/**
 * The BA's product layer over REST: a feedback item says whether work on it is running and when it is
 * done, or why no date is given (`GET …/forecast/feedback/:fb`); a person asks its reporter one
 * clarification where the route takes one (`can.clarify`); a draft not yet filed is compared with the
 * filed items (`POST …/feedback/similar`).
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

type Who = 'owner' | 'member' | 'reporter';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';

const at = (path: string) => `/api/projects/${projectId}${path}`;
const item = (fb: string, act = '') => at(`/feedback/${fb}${act ? `/${act}` : ''}`);
const progress = async (fb: string): Promise<Doc> =>
  ok(await say('member', 'GET', at(`/forecast/feedback/${fb}`)));

function refusal(r: Reply): Doc {
  expect(r.status, JSON.stringify(r.json)).toBeGreaterThanOrEqual(400);
  const [first] = r.json.error?.refusals ?? [];
  expect(first, JSON.stringify(r.json)).toBeDefined();
  return first;
}

async function file(title: string, by: Who = 'member'): Promise<string> {
  const made = ok(
    await say(by, 'POST', at('/feedback'), { kind: 'bug', title, screen: 'The board' }),
    201,
  );
  return made.feedback.key as string;
}

async function issue(title: string): Promise<{ id: string; key: string }> {
  const made = ok(await say('owner', 'POST', at('/issues'), { title }), 201);
  return { id: made.id, key: made.displayId };
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const owner = (await createTestUser({ verified: true })).id;
  const member = (await createTestUser({ verified: true })).id;
  const reporter = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  await addProjectMember(projectId, member, 'member');
  await addProjectMember(projectId, reporter, 'member');
  say = requester(app, {
    owner: await signUserToken(owner),
    member: await signUserToken(member),
    reporter: await signUserToken(reporter),
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a feedback item always says whether work runs and when it is done', () => {
  let fb = '';

  beforeAll(async () => {
    fb = await file('Saving the board loses every card');
  });

  it('reads an untriaged item as untriaged, with no date and who triages it', async () => {
    const p = await progress(fb);
    expect(p.label).toBe('forecast');
    expect(p.key).toBe(fb);
    expect(p.work).toMatchObject({ state: 'untriaged', running: 0, total: 0, issues: [] });
    expect(p.estimate.kind).toBe('none');
    expect(p.estimate.reason).toBe('untriaged');
    expect(p.estimate.waits?.who).toBeDefined();
  });

  it('reads running, naming each issue with its status, once one carrier is in progress', async () => {
    const a = await issue('Save the cards');
    const b = await issue('Save the columns');
    ok(
      await say('owner', 'POST', item(fb, 'triage'), {
        answers: TRIAGE_ANSWERS,
        route: 'issue',
        issue: [a.key, b.key],
      }),
    );
    await seedIssueStatus(a.id, 'in_progress');
    await seedIssueStatus(b.id, 'open');
    const p = await progress(fb);
    expect(p.work).toMatchObject({ state: 'running', running: 1, total: 2 });
    expect(p.work.issues).toEqual([
      { key: a.key, title: 'Save the cards', status: 'in_progress' },
      { key: b.key, title: 'Save the columns', status: 'open' },
    ]);
    // the estimate is either dated or names why not: never absent
    expect(['dated', 'none']).toContain(p.estimate.kind);
    if (p.estimate.kind === 'none') expect(p.estimate.reason).toBeTruthy();
  });

  it('reads shipped once every carrier is closed', async () => {
    const p0 = await progress(fb);
    for (const i of p0.work.issues as Doc[]) {
      const [row] = await rows<{ id: string }>(
        sql`SELECT id FROM issues WHERE project_id = ${projectId} AND iss_seq = ${Number(String(i.key).split('-')[1])}`,
      );
      await rows(sql`UPDATE issues SET merged_at = now() WHERE id = ${row?.id}`);
      await seedIssueStatus(row?.id as string, 'closed');
    }
    const p = await progress(fb);
    expect(p.work.state).toBe('shipped');
    expect(p.estimate.kind).toBe('shipped');
  });

  it('reads the work of the requirement a new-requirement route opened', async () => {
    const other = await file('The filters forget their order');
    ok(
      await say('owner', 'POST', item(other, 'triage'), {
        answers: TRIAGE_ANSWERS,
        route: 'new_requirement',
        title: 'Filters keep their order',
      }),
    );
    const p = await progress(other);
    expect(p.work.requirement).toMatchObject({ title: 'Filters keep their order' });
    expect(p.work.state).toBe('no_issues');
    expect(p.estimate).toMatchObject({ kind: 'none', reason: 'no_issues' });
  });

  it('reads a declined item as no work, with that reason', async () => {
    const other = await file('Make the board purple');
    ok(await say('owner', 'POST', item(other, 'triage'), { route: 'decline', note: 'Not ours.' }));
    const p = await progress(other);
    expect(p.work.state).toBe('no_work');
    expect(p.estimate).toMatchObject({ kind: 'none', reason: 'no_work' });
  });

  it('refuses an item the project does not hold, by name', async () => {
    const r = await say('member', 'GET', at('/forecast/feedback/FB-99999'));
    expect(r.status).toBe(404);
  });
});

describe('a clarification is asked where the route takes one', () => {
  it('offers it on a new item, takes one, and then refuses a second while it is open', async () => {
    const fb = await file('The board scrolls by itself');
    expect(ok(await say('member', 'GET', item(fb))).feedback.can.clarify).toBe(true);
    const asked = ok(
      await say('member', 'POST', item(fb, 'clarification'), {
        prompt: 'Which browser shows it?',
        needed: 'The browser and its version',
        recommended: 'The default answer',
      }),
    );
    expect(asked.feedback.clarification).toMatchObject({
      status: 'open',
      prompt: 'Which browser shows it?',
    });
    expect(asked.feedback.can.clarify).toBe(false);
    const again = refusal(
      await say('member', 'POST', item(fb, 'clarification'), {
        prompt: 'And which device?',
        needed: 'The device',
        recommended: 'The default answer',
      }),
    );
    expect(again.code).toBe('FEEDBACK_CLARIFICATION_ALREADY_OPEN');
  });

  it('reads every question about the item on the item, open and then answered, and no other item’s', async () => {
    // one question at a time per reporter (REQ-66 BC-4): each item is a reporter's with none open
    const fb = await file('The board loses its filter', 'owner');
    const other = await file('The board forgets its sort', 'reporter');
    const asked = ok(
      await say('member', 'POST', item(fb, 'clarification'), {
        prompt: 'Which filter was set?',
        needed: 'The filter and its value',
        recommended: 'The default answer',
      }),
    );
    ok(
      await say('member', 'POST', item(other, 'clarification'), {
        prompt: 'Which sort was set?',
        needed: 'The sort',
        recommended: 'The default answer',
      }),
    );
    const open = asked.feedback.questions;
    expect(open).toEqual([
      expect.objectContaining({
        id: asked.feedback.clarification.id,
        kind: 'clarification',
        status: 'open',
        prompt: 'Which filter was set?',
        answer: null,
        answeredAt: null,
      }),
    ]);
    ok(
      await say('member', 'POST', `/api/questions/${asked.feedback.clarification.id}/answer`, {
        round: 1,
        text: 'Status is open',
      }),
    );
    const read = ok(await say('member', 'GET', item(fb))).feedback.questions;
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({
      status: 'answered',
      prompt: 'Which filter was set?',
      answer: 'Status is open',
    });
    expect(read[0].answeredAt).toEqual(expect.any(String));
  });

  it('refuses a prompt shorter than the floor, naming the field', async () => {
    const fb = await file('The board jumps');
    const r = await say('member', 'POST', item(fb, 'clarification'), {
      prompt: 'Why',
      needed: 'x',
      recommended: 'The default answer',
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/prompt/);
  });
});

describe('a draft is compared with the filed items before it is sent', () => {
  it('answers why nothing was compared where no provider can embed, never an empty match', async () => {
    const r = ok(
      await say('member', 'POST', at('/feedback/similar'), {
        title: 'Saving the board loses the cards',
        body: 'Every card is gone after a save.',
      }),
    );
    expect(r.status).not.toBe('ok');
    expect(['provider_not_configured', 'withheld_by_policy', 'failed']).toContain(r.status);
    expect(r.message).toBeTruthy();
    expect(r.hits).toEqual([]);
  });

  it('refuses a draft with no title, and a field the shape does not name', async () => {
    expect((await say('member', 'POST', at('/feedback/similar'), { body: 'x' })).status).toBe(400);
    const extra = await say('member', 'POST', at('/feedback/similar'), {
      title: 'A title',
      kind: 'bug',
    });
    expect(extra.status).toBe(400);
  });
});
