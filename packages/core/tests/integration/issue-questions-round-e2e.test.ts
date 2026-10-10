/**
 * FB-80 (live dev.227, hop ISS-185): an issue with two open free-text questions, and the decision
 * composer offered neither, because it read `currentStep`, which this read never carries. Every
 * question read answers its open round through `QuestionRoundFacts` (`round`, `answerShape`, `prompt`
 * …); this pins that the read the issue page calls carries them, beside its `steps`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestIssue, createTestProject, createTestUser } from '../helpers/factories.js';

let token = '';
let issueId = '';
const questionId = crypto.randomUUID();

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { askQuestion } = await import('../../src/questions/index.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  const projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  issueId = (
    await createTestIssue(projectId, ownerId, 185, {
      status: 'in_progress',
      createdAt: new Date(Date.now() - 3_600_000),
    })
  ).id;
  await askQuestion({
    id: questionId,
    projectId,
    issueId,
    prompt: 'Which flag guards the tour?',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the flag', recommended: 'tours.v2' },
  });
}, 120_000);

afterAll(closeWorld);

describe('the questions the issue page reads', () => {
  it('carry the open round by number and shape, which a decision settling it names', async () => {
    const res = await api(token, 'GET', `/api/questions?issueId=${issueId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [q] = res.body.questions as Array<Record<string, unknown>>;
    expect(q).toMatchObject({
      id: questionId,
      status: 'open',
      answerShape: 'free_text',
      round: 1,
      prompt: 'Which flag guards the tour?',
      needed: 'the flag',
    });
    expect(q?.steps).toHaveLength(1);
  });
});
