/**
 * REQ-65 BC-3..BC-6 (ISS-690): the value check's questions and holds. The assistant drafts first and
 * asks at most three questions, each with a recommended answer, which the author answers; only a
 * missing problem or value, or a contradicted criterion, holds the check, and every other gap takes its
 * question's recommended answer as an assumption naming that source; a person keeps a refused request
 * with a one-line reason. The doors and outcomes: value-check-e2e.test.ts.
 *
 * Driven through the real app on a throwaway Postgres, the model a stub gateway on a local port
 * (helpers/value-check-world.ts).
 *
 * @direct-test-of packages/core/src/intake/acts.ts
 * @direct-test-of packages/core/src/requirements/value-refusal.ts
 */

import type { IntakeDraftResponse } from '@forge/contracts/intake-drafts';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';
import {
  create,
  draftOf,
  RECOMMENDED,
  seen,
  statusOf,
  useValueCheckWorld,
  world,
} from '../helpers/value-check-world.js';

useValueCheckWorld();
let projectId: string;
let ownerId: string;
let owner: string;
let viewer: string;
beforeAll(() => {
  ({ projectId, ownerId, owner, viewer } = world);
});

describe('the assistant drafts first and asks at most three questions, each with a recommended answer (REQ-65 BC-3)', () => {
  it('fills the draft while a question holds the check, and the author answers it to end the check', async () => {
    const key = await create('Held: Match referrals before booking');
    const held = await draftOf(key);
    expect(held?.applied?.as).toBe('revision');
    expect(held?.value?.outcome).toBeNull();
    expect(held?.questions.map((q) => [q.number, q.blocks, q.recommended])).toEqual([
      [1, null, 'weekly'],
      [2, 'problem', 'clerk'],
    ]);
    expect(held?.can.answer).toBe(true);

    const answered = await api(
      owner,
      'POST',
      `/api/projects/${projectId}/intake-drafts/${key}/answers`,
      {
        question: 2,
        option: 'clerk',
      },
    );
    expect(answered.status, JSON.stringify(answered.body).slice(0, 400)).toBe(200);
    await settleOutbox();
    const after = await draftOf(key);
    expect(after?.value?.outcome).toEqual({ kind: 'accept' });
    expect(after?.value?.who).toMatchObject({ value: 'The referral clerk', source: { key } });
    expect(after?.answered.map((a) => [a.prompt, a.label])).toEqual([
      ['Whose work does this change?', 'The referral clerk'],
    ]);
    expect(seen.at(-1)?.user).toContain(
      'Answered: Whose work does this change? → The referral clerk',
    );
  });

  it('refuses an answer naming no question or no option it offers, by name', async () => {
    const key = await create('Accept: Book the matched referral');
    const noQuestion = await api(
      owner,
      'POST',
      `/api/projects/${projectId}/intake-drafts/${key}/answers`,
      {
        question: 3,
        option: 'weekly',
      },
    );
    expect(noQuestion.status).toBe(400);
    expect(JSON.stringify(noQuestion.body)).toContain('INTAKE_QUESTION_UNKNOWN');
    const noOption = await api(
      owner,
      'POST',
      `/api/projects/${projectId}/intake-drafts/${key}/answers`,
      {
        question: 1,
        option: 'yearly',
      },
    );
    expect(noOption.status).toBe(400);
    expect(JSON.stringify(noOption.body)).toContain('offers weekly, monthly, not \\"yearly\\"');
    const byViewer = await api(
      viewer,
      'POST',
      `/api/projects/${projectId}/intake-drafts/${key}/answers`,
      {
        question: 1,
        option: 'monthly',
      },
    );
    expect(byViewer.status).toBe(403);
  });
});

describe('a question blocks only on a missing problem or value, or a contradicted criterion (REQ-65 BC-4)', () => {
  it('holds the agree on the question holding the check', async () => {
    const key = await create('Held: Hold a referral missing its clinic code', {
      criteria: [{ body: 'A referral missing its code waits for a clerk.' }],
    });
    expect((await draftOf(key))?.value?.outcome).toBeNull();
    for (const step of ['propose', 'accept']) {
      const res = await api(
        owner,
        'POST',
        `/api/projects/${projectId}/requirements/${key}/revisions/1/${step}`,
        step === 'accept' ? { reason: 'Reads right.' } : {},
      );
      expect(res.status, `${step}: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(200);
    }
    const agree = await api(owner, 'POST', `/api/projects/${projectId}/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Reads right to me.',
    });
    expect(agree.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(agree.body)).toContain('Whose work does this change?');
  });

  it('refuses a question that blocks on what the check states, and the retry lets it take its recommended answer', async () => {
    const before = seen.length;
    const key = await create('Wrongblock: Count wrong matches');
    expect(seen.length - before).toBe(2);
    expect(seen.at(-1)?.user).toContain(
      'questions[0] blocks on the problem, which value.who states: a question blocks only on what is missing',
    );
    const draft = await draftOf(key);
    expect(draft?.questions.map((q) => q.blocks)).toEqual([null]);
    expect(draft?.value?.outcome).toEqual({ kind: 'accept' });
  });

  it('refuses a question blocking on a criterion no conflict link quotes', async () => {
    const before = seen.length;
    const key = await create('Criterion: Match referrals by patient name');
    expect(seen.length - before).toBe(2);
    expect(seen.at(-1)?.user).toContain(
      'questions[0] blocks on a criterion, but no conflict link that stands quotes one',
    );
    const draft = await draftOf(key);
    expect(draft?.links.map((l) => [l.relation, l.basis?.criterion])).toEqual([
      ['conflict', 'BC-1'],
    ]);
    expect(draft?.questions.map((q) => q.blocks)).toEqual(['criterion']);
    expect(draft?.value?.outcome).toBeNull();
  });
});

describe('every other gap takes the recommended answer, shown as an assumption with its source (REQ-65 BC-5)', () => {
  it('takes the unanswered question’s recommended answer for how it is measured, naming the question', async () => {
    const key = await create('Accept: Count referrals booked the same day');
    const value = (await draftOf(key))?.value;
    expect(value?.measured).toEqual({
      value: RECOMMENDED.label,
      source: { kind: 'recommended', question: 1 },
    });
  });

  it('refuses a check that leaves how it is measured open, and keeps it as a named miss', async () => {
    const before = seen.length;
    const key = await create('Nomeasure: Count referrals booked late');
    expect(seen.length - before).toBe(2);
    expect(seen.at(-1)?.user).toContain('value.measured is null, a gap that does not block');
    const draft = await draftOf(key);
    expect([draft?.outcome, draft?.code, draft?.value]).toEqual(['failed', 'INTAKE_SHAPE', null]);
  });
});

describe('a person may keep a refused request by giving a one-line reason (REQ-65 BC-6)', () => {
  it('keeps it as a draft again, with the reason and who kept it on its check and its history', async () => {
    const key = await create('Refuse: Paint the footer purple');
    expect(await statusOf(key)).toBe('refused');
    expect((await draftOf(key))?.can.keep).toBe(true);
    const kept = await api(owner, 'POST', `/api/projects/${projectId}/intake-drafts/${key}/keep`, {
      reason: 'The brand guide asks for it.',
    });
    expect(kept.status, JSON.stringify(kept.body).slice(0, 400)).toBe(200);
    expect(await statusOf(key)).toBe('draft');
    const draft = (kept.body as unknown as IntakeDraftResponse).draft;
    expect(draft?.value?.kept).toMatchObject({
      reason: 'The brand guide asks for it.',
      by: { id: ownerId },
    });
    const [move] = await rows<{ reason: string }>(
      sql`SELECT t.reason FROM kernel_transitions t JOIN requirements r ON r.id = t.entity_id
          WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(key.slice(4))} AND t.from_status = 'refused'`,
    );
    expect(move?.reason).toBe('The brand guide asks for it.');
  });

  it('refuses a reason of more than one line, a viewer, and a keep of a request that was not refused', async () => {
    const key = await create('Refuse: Paint the sidebar purple');
    const twoLines = await api(
      owner,
      'POST',
      `/api/projects/${projectId}/intake-drafts/${key}/keep`,
      {
        reason: 'The brand guide.\nAnd the owner.',
      },
    );
    expect(twoLines.status).toBe(400);
    expect(JSON.stringify(twoLines.body)).toContain('one line: no line break');
    const byViewer = await api(
      viewer,
      'POST',
      `/api/projects/${projectId}/intake-drafts/${key}/keep`,
      {
        reason: 'I like purple.',
      },
    );
    expect(byViewer.status).toBe(403);
    expect(await statusOf(key)).toBe('refused');
    const accepted = await create('Accept: Show the clinic code on the list');
    const notRefused = await api(
      owner,
      'POST',
      `/api/projects/${projectId}/intake-drafts/${accepted}/keep`,
      {
        reason: 'Keep it.',
      },
    );
    expect(notRefused.status).toBe(409);
    expect(JSON.stringify(notRefused.body)).toContain(
      `${accepted} is draft: only a requirement its value check refused is kept`,
    );
  });
});
