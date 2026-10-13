/**
 * What the question routes read from the request, case by case: a field that is absent, empty,
 * populated or of the wrong type gives the refusal it always gave, now that the reads go through
 * the schema the reference declares.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.set('userId', 'user-1');
      c.set('principal', 'user');
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const read = {
  projectQuestionsFor: vi.fn(),
  readQuestionFor: vi.fn(),
  readQuestionsForIssue: vi.fn(),
  answerAs: vi.fn(),
  askAs: vi.fn(),
};
vi.mock('./read.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./read.js')>()),
  ...read,
}));

const voidQuestion = vi.fn();
vi.mock('./write.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./write.js')>()),
  voidQuestion: (...a: unknown[]) => voidQuestion(...a),
}));

const { questionRoutes } = await import('./routes.js');
const { QuestionRefused } = await import('./write.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/questions', questionRoutes);
  app.onError(errorHandler);
  return app;
}

const QUESTION = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

async function call(path: string, init?: RequestInit) {
  const res = await buildApp().request(`/api/questions${path}`, init);
  return { status: res.status, body: (await res.json()) as { code?: string; message?: string } };
}

const post = (path: string, body: unknown) =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/questions', () => {
  it.each([
    ['', 'issueId or projectId is required'],
    [`?issueId=${QUESTION}&projectId=${PROJECT}`, 'name issueId or projectId, not both'],
    [`?projectId=${PROJECT}&issue=any`, 'issue takes one value'],
    [`?projectId=${PROJECT}&status=nope`, 'status must be one of'],
    ['?projectId=nope', 'projectId must be a uuid'],
    ['?issueId=nope', 'issueId must be a uuid'],
  ])('refuses %s by name', async (query, message) => {
    const { status, body } = await call(query);
    expect(status).toBe(400);
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.message).toContain(message);
  });

  it.each(['&limit=', '&limit=0', '&limit=201', '&limit=x', '&cursor=nope'])(
    'refuses the page parameter %s',
    async (extra) => {
      const { status, body } = await call(`?projectId=${PROJECT}${extra}`);
      expect(status).toBe(400);
      expect(body.code).toBe('BAD_REQUEST');
    },
  );

  it('reads an absent limit as 50 and passes the scope through', async () => {
    read.projectQuestionsFor.mockResolvedValue({
      questions: [],
      total: 0,
      hasMore: false,
      nextCursor: null,
    });
    const { status } = await call(`?projectId=${PROJECT}&status=open&issue=none&limit=7`);
    expect(status).toBe(200);
    expect(read.projectQuestionsFor).toHaveBeenCalledWith(
      PROJECT,
      'user-1',
      'open',
      { limit: 7, cursor: undefined },
      true,
    );
    await call(`?projectId=${PROJECT}`);
    expect(read.projectQuestionsFor).toHaveBeenLastCalledWith(
      PROJECT,
      'user-1',
      undefined,
      { limit: 50, cursor: undefined },
      false,
    );
  });

  it('is a 404 when the caller cannot reach the project', async () => {
    read.projectQuestionsFor.mockResolvedValue(null);
    const { status, body } = await call(`?projectId=${PROJECT}`);
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/questions/:id/answer', () => {
  beforeEach(() => {
    read.answerAs.mockResolvedValue({ id: QUESTION });
  });

  it.each([
    ['no body', ''],
    ['a body that is not JSON', 'not json'],
    ['a JSON null', 'null'],
    ['an empty object', {}],
    ['an option that is not text', { optionId: 5, round: 1 }],
    ['empty option and blank text', { optionId: '', text: '  ', round: 1 }],
  ])('asks for an option or text when given %s', async (_name, body) => {
    const res = await post(`/${QUESTION}/answer`, body);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('optionId or text is required');
  });

  it('refuses an option and text together', async () => {
    const res = await post(`/${QUESTION}/answer`, { optionId: 'a', text: 'b', round: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('send optionId or text, never both');
  });

  it.each([{}, { round: '1' }, { round: 1.5 }, { round: null }])(
    'requires an integer round, given %j',
    async (extra) => {
      const res = await post(`/${QUESTION}/answer`, { optionId: 'a', ...extra });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('round is required, as an integer');
    },
  );

  it('reads a text of the wrong type as absent and answers with the option', async () => {
    const res = await post(`/${QUESTION}/answer`, { optionId: 'a', text: 7, round: 2 });
    expect(res.status).toBe(200);
    expect(read.answerAs).toHaveBeenCalledWith({
      questionId: QUESTION,
      answer: { kind: 'option', optionId: 'a' },
      round: 2,
      userId: 'user-1',
    });
  });

  it('answers with text when only text is given', async () => {
    await post(`/${QUESTION}/answer`, { text: 'yes', round: 1 });
    expect(read.answerAs).toHaveBeenCalledWith(
      expect.objectContaining({ answer: { kind: 'text', text: 'yes' }, round: 1 }),
    );
  });

  it('refuses an id that is not a uuid', async () => {
    const res = await post('/nope/answer', { optionId: 'a', round: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('the question id must be a uuid');
  });
});

describe('POST /api/questions/:id/void', () => {
  beforeEach(() => {
    read.readQuestionFor.mockResolvedValue({ id: QUESTION });
    voidQuestion.mockImplementation(async ({ reason }: { reason: string }) => {
      if (!reason.trim()) throw new QuestionRefused('no reason', 'QUESTION_REASON_REQUIRED');
    });
  });

  it.each([
    ['no body', ''],
    ['a JSON null', 'null'],
    ['a reason that is not text', { reason: 5 }],
    ['an empty object', {}],
  ])('asks for a reason when given %s', async (_name, body) => {
    const res = await post(`/${QUESTION}/void`, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('QUESTION_REASON_REQUIRED');
    expect(voidQuestion).toHaveBeenCalledWith({ questionId: QUESTION, reason: '' });
  });

  it('voids with the reason given', async () => {
    const res = await post(`/${QUESTION}/void`, { reason: 'moot' });
    expect(res.status).toBe(200);
    expect(voidQuestion).toHaveBeenCalledWith({ questionId: QUESTION, reason: 'moot' });
  });
});
