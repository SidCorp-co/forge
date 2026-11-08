/**
 * ISS-826 (REQ-12 question 44bbaff5, refused three ways twice): an option worded to be answered in
 * words ("Decide per criterion, named in the answer") could be chosen but its answer could not be
 * given. An option declares `takesText` at ask time; choosing it carries the person's words and is
 * refused without them; words on an option that takes none are refused naming the one that does; the
 * question read shows which option takes text, and the answered round keeps option and words.
 *
 * @direct-test-of packages/core/src/questions/answer.ts
 * @direct-test-of packages/core/src/questions/answer-input.ts
 * @direct-test-of packages/core/src/questions/routes.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestIssue, createTestProject, createTestUser } from '../helpers/factories.js';

let token = '';
let questionId = '';

const option = (id: string, label: string, takesText?: boolean) => ({
  id,
  label,
  authority: 'writer',
  bindsTo: 'project',
  executedBy: 'human',
  ...(takesText ? { takesText } : {}),
});

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const ownerId = (await createTestUser({ verified: true })).id;
  const projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  const issueId = (
    await createTestIssue(projectId, ownerId, 826, {
      status: 'in_progress',
      createdAt: new Date(Date.now() - 3_600_000),
    })
  ).id;
  const asked = await api(token, 'POST', '/api/questions', {
    issueId,
    prompt: 'Which criteria of REQ-12 does the release keep?',
    options: [
      option('all', 'Keep every criterion'),
      option('per-criterion', 'Decide per criterion, named in the answer', true),
    ],
    recommendedOptionId: 'per-criterion',
  });
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  questionId = String(
    (asked.body as { id?: string; question?: { id: string } }).id ??
      (asked.body as { question: { id: string } }).question.id,
  );
}, 120_000);

afterAll(closeWorld);

const codeOf = (body: unknown) => (body as { error?: { code?: string } }).error?.code;

describe('an option answered in words', () => {
  it('is shown as taking text on the question read', async () => {
    const res = await api(token, 'GET', `/api/questions/${questionId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const steps =
      (
        res.body as {
          steps?: { options: { id: string; takesText?: boolean }[] }[];
          question?: { steps: { options: { id: string; takesText?: boolean }[] }[] };
        }
      ).steps ??
      (res.body as { question: { steps: { options: { id: string; takesText?: boolean }[] }[] } })
        .question.steps;
    expect(steps[0]?.options.map((o) => [o.id, o.takesText ?? false])).toEqual([
      ['all', false],
      ['per-criterion', true],
    ]);
  });

  it('is refused without its words, by name', async () => {
    const res = await api(token, 'POST', `/api/questions/${questionId}/answer`, {
      round: 1,
      optionId: 'per-criterion',
    });
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('QUESTION_OPTION_TEXT_REQUIRED');
  });

  it('refuses words on an option that takes none, naming the option that does', async () => {
    const res = await api(token, 'POST', `/api/questions/${questionId}/answer`, {
      round: 1,
      optionId: 'all',
      text: 'BC-1 only',
    });
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('QUESTION_OPTION_TAKES_NO_TEXT');
    expect(JSON.stringify(res.body)).toContain('per-criterion');
  });

  it('records the option and its words together', async () => {
    const res = await api(token, 'POST', `/api/questions/${questionId}/answer`, {
      round: 1,
      optionId: 'per-criterion',
      text: 'BC-1 keep, BC-2 drop',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const read = await api(token, 'GET', `/api/questions/${questionId}`);
    expect(JSON.stringify(read.body)).toContain('"chosenText":"BC-1 keep, BC-2 drop"');
    expect(JSON.stringify(read.body)).toContain('"chosenOptionId":"per-criterion"');
  });
});
