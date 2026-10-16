/**
 * The BA's product layer over REST: a feedback item says whether work on it is running and when it is
 * done, or why no date is given (`GET …/forecast/feedback/:fb`); a person asks its reporter one
 * clarification where the route takes one (`can.clarify`); a draft not yet filed is compared with the
 * filed items (`POST …/feedback/similar`); and a question a person raised reads owed until somebody
 * else answers it (`GET …/raised-questions`).
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
let requirementKey = '';

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

async function file(title: string): Promise<string> {
  const made = ok(
    await say('member', 'POST', at('/feedback'), { kind: 'bug', title, screen: 'The board' }),
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
  projectId = (await createTestProject(owner)).id;
  await addProjectMember(projectId, member, 'member');
  say = requester(app, { owner: await signUserToken(owner), member: await signUserToken(member) });
  requirementKey = ok(
    await say('owner', 'POST', at('/requirements'), {
      title: 'The board keeps its cards',
      reason: 'the rule the feedback states',
      criteria: [{ body: 'A saved board shows every card it had.' }],
    }),
    201,
  ).key;
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
      }),
    );
    expect(again.code).toBe('FEEDBACK_CLARIFICATION_ALREADY_OPEN');
  });

  it('refuses a prompt shorter than the floor, naming the field', async () => {
    const fb = await file('The board jumps');
    const r = await say('member', 'POST', item(fb, 'clarification'), {
      prompt: 'Why',
      needed: 'x',
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

describe('a raised question is owed until somebody else answers it', () => {
  let questionId = '';

  it('lists the member’s requirement question as owed by project members', async () => {
    const posted = ok(
      await say('member', 'POST', at(`/requirements/${requirementKey}/comments`), {
        intent: 'question',
        body: 'Does a saved board keep archived cards?',
      }),
      201,
    );
    questionId = posted.comment.id;
    const mine = ok(await say('member', 'GET', at('/raised-questions')));
    expect(mine.by).toBe('me');
    expect(mine.owed).toBe(1);
    expect(mine.questions[0]).toMatchObject({
      id: questionId,
      target: { scope: 'requirement', key: requirementKey },
      answer: null,
      owedBy: 'members',
    });
  });

  it('is not listed as the owner’s own, and is listed among everyone’s', async () => {
    expect(ok(await say('owner', 'GET', at('/raised-questions'))).questions).toEqual([]);
    const all = ok(await say('owner', 'GET', at('/raised-questions?by=people')));
    expect(all.questions.map((q: Doc) => q.id)).toContain(questionId);
  });

  it('stays owed after the asker’s own reply, and reads answered after another person’s', async () => {
    ok(
      await say('member', 'POST', at(`/requirements/${requirementKey}/comments`), {
        intent: 'note',
        body: 'Adding: archived cards matter most.',
        parentId: questionId,
      }),
      201,
    );
    expect(ok(await say('member', 'GET', at('/raised-questions'))).owed).toBe(1);
    ok(
      await say('owner', 'POST', at(`/requirements/${requirementKey}/comments`), {
        intent: 'note',
        body: 'Yes, archived cards are kept.',
        parentId: questionId,
      }),
      201,
    );
    const mine = ok(await say('member', 'GET', at('/raised-questions')));
    expect(mine).toMatchObject({ owed: 0, answered: 1 });
    expect(mine.questions[0]).toMatchObject({
      id: questionId,
      owedBy: null,
      answer: { body: 'Yes, archived cards are kept.' },
    });
  });

  it('names the agent as owing a question on a live issue, and nobody once the issue ended', async () => {
    const i = await issue('Keep archived cards');
    ok(
      await say('member', 'POST', `/api/issues/${i.id}/comments`, {
        intent: 'question',
        body: 'Is this blocked on the export?',
      }),
      201,
    );
    const owedOn = async () =>
      (ok(await say('member', 'GET', at('/raised-questions'))).questions as Doc[]).find(
        (q) => q.target.key === i.key,
      );
    expect((await owedOn())?.owedBy).toBe('agent');
    await seedIssueStatus(i.id, 'dropped');
    expect((await owedOn())?.owedBy).toBe('nobody');
  });

  it('refuses a `by` it does not know, naming the values it takes', async () => {
    const r = await say('member', 'GET', at('/raised-questions?by=agents'));
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/me \| people/);
  });
});
