import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const queryQueue: unknown[] = [];

function makeChain() {
  const chain: Record<string, unknown> & PromiseLike<unknown> = {} as never;
  const methods = ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'offset'];
  for (const m of methods) (chain as Record<string, unknown>)[m] = () => chain;
  (chain as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) => {
    const result = queryQueue.shift() ?? [];
    return Promise.resolve(result).then(resolve, reject);
  };
  return chain;
}

vi.mock('../db/client.js', () => ({
  db: {
    select: () => makeChain(),
  },
}));

const { meAttentionRoutes } = await import('./attention-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{
    Variables: import('../middleware/request-id.js').RequestIdVars;
  }>();
  app.use('*', requestId());
  app.route('/api/me', meAttentionRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID_1 = '22222222-2222-4222-8222-222222222222';
const ISSUE_ID_2 = '33333333-3333-4333-8333-333333333333';
const ISSUE_ID_3 = '44444444-4444-4444-8444-444444444444';
const JOB_ID = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  queryQueue.length = 0;
});

async function token() {
  return signUserToken(USER_ID);
}

function authVerified() {
  queryQueue.push([{ emailVerifiedAt: new Date() }]);
}

describe('GET /api/me/attention', () => {
  it('401 without token', async () => {
    const res = await buildApp().request('/api/me/attention');
    expect(res.status).toBe(401);
  });

  it('returns empty buckets when nothing matches', async () => {
    authVerified();
    queryQueue.push([]); // needsReview
    queryQueue.push([]); // awaitingInput
    queryQueue.push([]); // mentions
    queryQueue.push([]); // failedJobs

    const res = await buildApp().request('/api/me/attention', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      needsReview: [],
      awaitingInput: [],
      mentions: [],
      failedJobs: [],
      total: 0,
    });
  });

  it('200 with all 4 buckets populated, total = sum of items', async () => {
    authVerified();
    const updatedAt = new Date('2026-04-26T10:00:00Z');
    const mentionedAt = new Date('2026-04-26T11:00:00Z');
    const finishedAt = new Date('2026-04-26T12:00:00Z');

    queryQueue.push([
      {
        id: ISSUE_ID_1,
        issSeq: 42,
        title: 'Refactor pipeline',
        status: 'developed',
        updatedAt,
        projectSlug: 'alpha',
        projectName: 'Alpha',
      },
    ]); // needsReview
    queryQueue.push([
      {
        id: ISSUE_ID_2,
        issSeq: 7,
        title: 'Need clarification on auth',
        status: 'needs_info',
        updatedAt,
        projectSlug: 'alpha',
        projectName: 'Alpha',
      },
    ]); // awaitingInput
    queryQueue.push([
      {
        notificationId: null,
        notificationTitle: 'You were mentioned in ISS-3',
        mentionedAt,
        issueDocId: ISSUE_ID_3,
        issSeq: 3,
        projectSlug: 'beta',
        projectName: 'Beta',
      },
    ]); // mentions
    queryQueue.push([
      {
        id: JOB_ID,
        type: 'code',
        finishedAt,
        createdAt: finishedAt,
        error: 'OOM killed',
        issueDocId: ISSUE_ID_1,
        issSeq: 42,
        projectSlug: 'alpha',
        projectName: 'Alpha',
      },
    ]); // failedJobs

    const res = await buildApp().request('/api/me/attention', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      needsReview: Array<{ kind: string; issueRef: string; status: string; link: string }>;
      awaitingInput: Array<{ kind: string; status: string }>;
      mentions: Array<{ kind: string; issueRef: string; title: string }>;
      failedJobs: Array<{ kind: string; title: string; status: string; issueRef?: string }>;
      total: number;
    };

    expect(body.total).toBe(4);
    expect(body.needsReview[0]).toMatchObject({
      kind: 'needs_review',
      issueRef: 'ISS-42',
      status: 'developed',
      link: `/projects/alpha/issues/${ISSUE_ID_1}`,
    });
    expect(body.awaitingInput[0]).toMatchObject({
      kind: 'awaiting_input',
      status: 'needs_info',
    });
    expect(body.mentions[0]).toMatchObject({
      kind: 'mention',
      issueRef: 'ISS-3',
      title: 'You were mentioned in ISS-3',
    });
    expect(body.failedJobs[0]).toMatchObject({
      kind: 'failed_job',
      status: 'failed',
      issueRef: 'ISS-42',
    });
    expect(body.failedJobs[0]?.title).toContain('OOM killed');
  });

  it('failed_job without linked issue links to project root, omits issueRef', async () => {
    authVerified();
    queryQueue.push([]);
    queryQueue.push([]);
    queryQueue.push([]);
    queryQueue.push([
      {
        id: JOB_ID,
        type: 'review',
        finishedAt: new Date('2026-04-26T12:00:00Z'),
        createdAt: new Date('2026-04-26T12:00:00Z'),
        error: null,
        issueDocId: null,
        issSeq: null,
        projectSlug: 'alpha',
        projectName: 'Alpha',
      },
    ]);

    const res = await buildApp().request('/api/me/attention', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      failedJobs: Array<{ link: string; title: string; issueRef?: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.failedJobs[0]?.link).toBe('/projects/alpha');
    expect(body.failedJobs[0]?.issueRef).toBeUndefined();
    expect(body.failedJobs[0]?.title).toBe('review job failed');
  });
});
