import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { errorHandler } from '../middleware/error.js';

vi.mock('../integrations/source-host/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../integrations/source-host/index.js')>();
  return {
    ...real,
    openPullRequestsForIssue: async () => ['pr-1'],
    mergeStoredChangeRequest: async () => {
      throw new real.MergeInputError(
        'MERGE_RUN_NOT_FOUND',
        'merge: `runId` r1 names no pipeline run',
      );
    },
  };
});
vi.mock('../issues/index.js', () => ({
  issueScopeOf: async () => ({ projectId: 'p1' }),
  mergedCommitShaSchema: z.string(),
  recordIssueMerge: async () => ({ wrote: true }),
}));
vi.mock('../lib/authz.js', () => ({ loadProjectAccess: async () => ({}) }));
vi.mock('../permissions/index.js', () => ({ requireHeld: () => {} }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.set('userId', 'u1');
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
  restActor: () => ({ type: 'user', id: 'u1', agency: 'human' }),
}));

const { issueMergePullRequestRoutes } = await import('./issue-merge-routes.js');

describe('POST /:id/merge-pull-request: a caller-input fault', () => {
  it('is refused by its own name, not a bare 400 BAD_REQUEST', async () => {
    const app = new Hono().route('/', issueMergePullRequestRoutes);
    app.onError(errorHandler as never);
    const res = await app.request('/00000000-0000-4000-8000-000000000001/merge-pull-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: '00000000-0000-4000-8000-000000000002' }),
    });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('MERGE_RUN_NOT_FOUND');
    expect(res.status).toBe(422);
  });
});
