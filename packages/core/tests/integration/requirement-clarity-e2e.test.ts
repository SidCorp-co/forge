/**
 * A requirement is precise from its input (JU-6, JU-5): a revision carries its open business
 * questions and its assumptions, each open question asked as a question on the requirement, and a
 * blocking one refuses the agree by name until it is answered. A business question raised on a build
 * issue names its requirement through `about`, stays on the issue, and its answer reaches the
 * requirement as a decision; the requirement's Decisions tab and the project's decision log both
 * roll up the decisions on its issues. A person links an existing issue to it, and the requirement
 * then lists the issue.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { api, type Body, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';

let owner = '';
let ownerId = '';
let projectId = '';

const at = (path: string) => `/api/projects/${projectId}${path}`;

async function ok(res: Promise<{ status: number; body: Body }>, status = 200): Promise<Body> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
}

const refusalsOf = (body: Body): { code: string; path: string; detail: string }[] =>
  (body.error as { refusals?: { code: string; path: string; detail: string }[] } | undefined)
    ?.refusals ?? [];

async function refused(res: Promise<{ status: number; body: Body }>, code: string) {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
  const named = refusalsOf(r.body).find((x) => x.code === code);
  expect(named, JSON.stringify(r.body)).toBeDefined();
  return named as { code: string; path: string; detail: string };
}

const read = (req: string) => ok(api(owner, 'GET', at(`/requirements/${req}`)));

async function draftWith(spec: Body): Promise<string> {
  const body = await ok(
    api(owner, 'POST', at('/requirements'), {
      title: `Referral reports ${Math.random()}`,
      reason: 'clinics ask who referred whom',
      spec,
      criteria: [{ body: 'A referral manager sees the referrals they made.' }],
    }),
    201,
  );
  return body.key as string;
}

async function current(req: string) {
  await ok(api(owner, 'POST', at(`/requirements/${req}/revisions/1/propose`), {}));
  await ok(api(owner, 'POST', at(`/requirements/${req}/revisions/1/accept`), { reason: 'ok' }));
}

async function agreed(): Promise<string> {
  const req = await draftWith({ goal: 'referrals' });
  await current(req);
  await ok(api(owner, 'POST', at(`/requirements/${req}/agree`), { revision: 1, reason: 'ok' }));
  return req;
}

async function issueUnder(req: string | null, title: string): Promise<Body> {
  const issue = await ok(api(owner, 'POST', at('/issues'), { title, status: 'draft' }), 201);
  if (req) await ok(api(owner, 'POST', at(`/requirements/${req}/issues`), { issue: issue.id }));
  return issue;
}

const choice = {
  options: [
    {
      id: 'yes',
      label: 'Yes',
      authority: 'writer',
      bindsTo: 'this_call',
      executedBy: 'agent',
      fingerprint: 'f',
    },
    {
      id: 'no',
      label: 'No',
      authority: 'writer',
      bindsTo: 'this_call',
      executedBy: 'agent',
      fingerprint: 'f',
    },
  ],
  recommendedOptionId: 'no',
};

beforeAll(async () => {
  ownerId = (await createTestUser({ verified: true })).id;
  owner = await userToken(ownerId);
  projectId = (await createTestProject(ownerId)).id;
}, 60_000);

describe('a revision that leaves business questions open', () => {
  it('asks each as a question on the requirement, lists them with its assumptions, and refuses the agree while a blocking one stands', async () => {
    const req = await draftWith({
      goal: 'Referral managers see their referrals',
      openQuestions: [
        {
          question: 'May a referral manager download the aggregate report?',
          whoAnswers: 'the clinic owner',
          blocking: true,
        },
        {
          question: 'Is referrer feedback a new consent purpose?',
          whoAnswers: 'the DPO',
          blocking: false,
        },
      ],
      assumptions: [
        {
          text: 'Every referral names one referrer.',
          owner: 'the BA',
          confirmBy: 'a count over last month',
        },
      ],
    });
    const drafted = await read(req);
    const head = (drafted.revisions as Body[])[0] as Body;
    const stored = (head.spec as Body).openQuestions as Body[];
    expect(stored.every((q) => typeof q.questionId === 'string')).toBe(true);
    expect((head.spec as Body).assumptions).toEqual([
      {
        text: 'Every referral names one referrer.',
        owner: 'the BA',
        confirmBy: 'a count over last month',
      },
    ]);
    expect(drafted.unclear).toBe(2);
    const questions = drafted.questions as Body[];
    expect(
      questions.map((q) => [q.prompt, q.blocking, q.whoAnswers, (q.place as Body).kind]),
    ).toEqual(
      expect.arrayContaining([
        [
          'May a referral manager download the aggregate report?',
          true,
          'the clinic owner',
          'requirement',
        ],
        ['Is referrer feedback a new consent purpose?', false, 'the DPO', 'requirement'],
      ]),
    );

    await current(req);
    const refusal = await refused(
      api(owner, 'POST', at(`/requirements/${req}/agree`), { revision: 1, reason: 'ok' }),
      'REQUIREMENT_OPEN_QUESTIONS',
    );
    expect(refusal.detail).toContain('download the aggregate report');
    expect(refusal.detail).not.toContain('referrer feedback');
    expect((await read(req)).status).toBe('draft');

    const blocking = questions.find((q) => q.blocking === true) as Body;
    await ok(
      api(owner, 'POST', `/api/questions/${blocking.id as string}/answer`, {
        round: blocking.round,
        text: 'No: only the owner downloads the aggregate.',
      }),
    );
    await ok(api(owner, 'POST', at(`/requirements/${req}/agree`), { revision: 1, reason: 'ok' }));
    const after = await read(req);
    expect(after.status).toBe('agreed');
    expect(after.unclear).toBe(1);

    const rolled = await ok(api(owner, 'GET', at(`/requirements/${req}/decisions`)));
    expect((rolled.decisions as Body[]).map((d) => (d.decision as Body).decision)).toContain(
      'No: only the owner downloads the aggregate.',
    );
  });

  it('refuses a spec entry naming a question this requirement does not list', async () => {
    const other = await issueUnder(null, 'elsewhere');
    const q = await ok(
      api(owner, 'POST', '/api/questions', { issueId: other.id, prompt: 'Unrelated?', ...choice }),
      201,
    );
    const res = api(owner, 'POST', at('/requirements'), {
      title: 'Borrowed question',
      reason: 'r',
      spec: {
        openQuestions: [
          { question: 'Unrelated?', whoAnswers: 'x', blocking: true, questionId: q.id },
        ],
      },
      criteria: [{ body: 'c' }],
    });
    const refusal = await refused(res, 'REQUIREMENT_OPEN_QUESTION_UNKNOWN');
    expect(refusal.path).toBe('/spec/openQuestions/0/questionId');
  });
});

describe('a business question raised on a build issue', () => {
  it('names its requirement through about, stays on the issue, and its answer reaches the requirement as a decision', async () => {
    const req = await agreed();
    const issue = await issueUnder(req, 'referral report export');
    const asked = await ok(
      api(owner, 'POST', '/api/questions', {
        issueId: issue.id,
        prompt: 'Does referral_manager get report.download_aggregate?',
        about: { requirement: null },
        ...choice,
      }),
      201,
    );
    expect(asked.issueId).toBe(issue.id);
    expect(asked.requirementId).toBeNull();

    const listed = ((await read(req)).questions as Body[]).find((q) => q.id === asked.id) as Body;
    expect(listed).toMatchObject({
      status: 'open',
      place: { kind: 'issue', key: issue.displayId },
    });

    await ok(
      api(owner, 'POST', `/api/questions/${asked.id as string}/answer`, {
        round: 1,
        optionId: 'no',
      }),
    );
    const rolled = await ok(api(owner, 'GET', at(`/requirements/${req}/decisions`)));
    const decision = (rolled.decisions as Body[]).find(
      (d) => (d.decision as Body).decision === 'No',
    ) as Body;
    expect(decision.target).toMatchObject({ scope: 'requirement', key: req });
    expect((decision.decision as Body).reason).toContain(issue.displayId as string);
    expect((rolled.answers as Body[]).map((a) => a.questionId)).toContain(asked.id);
  });

  it('refuses an about naming no requirement of the project, and a null one on an issue that delivers none', async () => {
    const loose = await issueUnder(null, 'loose');
    await refused(
      api(owner, 'POST', '/api/questions', {
        issueId: loose.id,
        prompt: 'Who decides?',
        about: { requirement: 'REQ-9999' },
        ...choice,
      }),
      'QUESTION_ABOUT_UNKNOWN',
    );
    await refused(
      api(owner, 'POST', '/api/questions', {
        issueId: loose.id,
        prompt: 'Who decides?',
        about: { requirement: null },
        ...choice,
      }),
      'QUESTION_ABOUT_NO_REQUIREMENT',
    );
  });
});

describe('the decisions a requirement rolls up', () => {
  it("shows a decision made on one of its issues, on its Decisions tab and in the project's log filtered to it, and not another requirement's", async () => {
    const req = await agreed();
    const other = await agreed();
    const mine = await issueUnder(req, 'consent screen');
    const theirs = await issueUnder(other, 'unrelated screen');
    const decide = (issueId: unknown, decision: string) =>
      ok(
        api(owner, 'POST', `/api/issues/${issueId as string}/comments`, {
          intent: 'decision',
          decision: { decision, reason: 'the clinic owner said so' },
        }),
        201,
      );
    await decide(mine.id, 'Referrer feedback is its own consent purpose');
    await decide(theirs.id, 'Not this requirement');

    const tab = await ok(api(owner, 'GET', at(`/requirements/${req}/decisions`)));
    const onTab = (tab.decisions as Body[]).map((d) => (d.target as Body).key);
    expect(onTab).toContain(mine.displayId);
    expect(onTab).not.toContain(theirs.displayId);

    const log = await ok(api(owner, 'GET', at(`/decisions?requirement=${req}`)));
    const inLog = (log.decisions as Body[]).map(
      (d) => (d.decision as Body | null)?.decision ?? d.body,
    );
    expect(inLog.join('\n')).toContain('Referrer feedback is its own consent purpose');
    expect(inLog.join('\n')).not.toContain('Not this requirement');

    const byIssue = await ok(
      api(owner, 'GET', at(`/decisions?issue=${theirs.displayId as string}`)),
    );
    expect((byIssue.decisions as Body[]).map((d) => (d.target as Body).key)).toEqual([
      theirs.displayId,
    ]);
    const byWho = await ok(api(owner, 'GET', at(`/decisions?who=${ownerId}&since=2000-01-01`)));
    expect((byWho.decisions as Body[]).length).toBeGreaterThanOrEqual(2);
    const none = await ok(api(owner, 'GET', at('/decisions?until=2000-01-01')));
    expect(none.decisions).toEqual([]);
  });
});

describe('a person links an existing issue to a requirement', () => {
  it('lists the issue under the requirement and counts it, and refuses a requirement not agreed by name', async () => {
    const req = await agreed();
    const before = await read(req);
    const issue = await issueUnder(null, 'built before the requirement was written');
    const linked = await ok(
      api(owner, 'POST', at(`/requirements/${req}/issues`), { issue: issue.displayId }),
    );
    expect((linked.issues as Body[]).map((i) => i.displayId)).toContain(issue.displayId);
    const facts = ((linked.standing as Body).facts as Body).issuesTotal as number;
    expect(facts).toBe((((before.standing as Body).facts as Body).issuesTotal as number) + 1);

    const draft = await draftWith({ goal: 'not agreed yet' });
    const loose = await issueUnder(null, 'another');
    await refused(
      api(owner, 'POST', at(`/requirements/${draft}/issues`), { issue: loose.displayId }),
      'REQUIREMENT_NOT_AGREED',
    );
  });
});
