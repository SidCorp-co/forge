/**
 * ISS-1073 — the kernel merge's door, and what it will not let a caller decide.
 *
 * The operation itself is proved in `integrations/github/merge.test.ts`. What is
 * left here is the wiring, and one property of it that no other test can see:
 * the identity the merge is recorded under comes from the AUTHENTICATED
 * principal and never from the request body. A `requestedBy` a caller could send
 * would turn the attribution this route exists to record back into a field the
 * caller fills in, which is the testimony the whole issue replaced.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const PR_ROW = '33333333-3333-4333-8333-333333333333';

let issueRow: Record<string, unknown> | undefined = { id: ISSUE_ID, projectId: PROJECT_ID };
const selectLimit = vi.fn(async () => (issueRow ? [issueRow] : []));
vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }) },
}));

vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: async () => ({ role: 'member' }),
  assertProjectRole: () => undefined,
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', 'user-9');
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
  restActor: () => ({ type: 'user', id: 'user-9', agency: 'human' }),
}));

let openPullRequests: string[] = [PR_ROW];
vi.mock('../integrations/github/contract-check.js', () => ({
  openPullRequestsForIssue: async () => openPullRequests,
}));

const mergeStoredPullRequest = vi.fn();
vi.mock('../integrations/github/merge.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, mergeStoredPullRequest: (...a: unknown[]) => mergeStoredPullRequest(...a) };
});

const { issueMergeRoutes } = await import('./merge-routes.js');
const { errorHandler } = await import('../middleware/error.js');

// biome-ignore lint/suspicious/noExplicitAny: test-only mount, as the integration harness does
const app: any = new Hono();
app.route('/api/issues', issueMergeRoutes);
app.onError(errorHandler);

const post = (body: unknown) =>
  app.request(`/api/issues/${ISSUE_ID}/merge-pull-request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  issueRow = { id: ISSUE_ID, projectId: PROJECT_ID };
  openPullRequests = [PR_ROW];
  mergeStoredPullRequest.mockResolvedValue({
    kind: 'merged',
    deliveryId: 'd1',
    commitSha: 'e45b4ec',
    mergedAt: new Date('2026-09-18T06:30:01.449Z'),
    stamped: true,
  });
});

describe('POST /api/issues/:id/merge-pull-request', () => {
  it('merges the issue one open pull request and answers with the commit', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ merged: true, commitSha: 'e45b4ec', stamped: true });
    expect(mergeStoredPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pullRequestId: PR_ROW }),
    );
  });

  // cm:guard the planted violation for criterion 32 at this door: send `requestedBy` in the body and
  // it must reach nothing. A route that spread the body into the call would pass every other test in
  // this file while letting a caller sign somebody else's name to a merge.
  it('takes the caller from the principal and ignores one sent in the body', async () => {
    const res = await post({ requestedBy: 'user:someone-else' });
    expect(res.status).toBe(400);
    expect(mergeStoredPullRequest).not.toHaveBeenCalled();
  });

  it('records the authenticated principal as the caller', async () => {
    await post({});
    expect(mergeStoredPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: 'user:user-9' }),
    );
  });

  it('passes the head the caller judged, so a head that moved is refused downstream', async () => {
    await post({ headSha: 'c0ffee1234567' });
    expect(mergeStoredPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: 'c0ffee1234567' }),
    );
  });

  // cm:guard a refusal is a 422 and never a 200 with a `refused` field. What the caller does next —
  // dispatch the dependents — turns on this, and it must be readable from the status alone.
  it('answers 422 with the reason when the merge is refused', async () => {
    mergeStoredPullRequest.mockResolvedValue({
      kind: 'refused',
      deliveryId: 'd1',
      reason: 'required-check',
      detail: 'the base branch requires the check `ci-passed`',
    });
    const res = await post({});
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('ci-passed');
  });

  // cm:guard choosing for the caller here is what made a master misread ISS-1027 on 2026-09-17: a
  // landing pull request and a follow-up on one issue, and only the open one read.
  it('refuses to choose when the issue has more than one open pull request', async () => {
    openPullRequests = [PR_ROW, '44444444-4444-4444-8444-444444444444'];
    const res = await post({});
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('will not choose between them');
    expect(mergeStoredPullRequest).not.toHaveBeenCalled();
  });

  it('refuses when the issue has no open pull request Forge knows of', async () => {
    openPullRequests = [];
    const res = await post({});
    expect(res.status).toBe(422);
    expect(mergeStoredPullRequest).not.toHaveBeenCalled();
  });

  it('answers 404 for an issue that is not there', async () => {
    issueRow = undefined;
    expect((await post({})).status).toBe(404);
  });

  it('turns a merge naming no caller into a 400 rather than a 500', async () => {
    const { MergeInputError } = await import('../integrations/github/merge.js');
    mergeStoredPullRequest.mockRejectedValue(new MergeInputError('a merge needs `requestedBy`'));
    const res = await post({});
    expect(res.status).toBe(400);
  });
});
