/**
 * What `forge_github` answers when the tracker write after a GitHub action fails: the action
 * stands and the result says why the write did not, naming the statement and none of its values.
 */

import { DrizzleQueryError } from 'drizzle-orm/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x/y',
    DEVICE_TOKEN_PEPPER: 'pepper',
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const projectOpenedPullRequest = vi.fn();
const noteReviewOnIssue = vi.fn();

vi.mock('../../integrations/github/agent-client.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  githubAgentClient: async () => ({ bindingId: 'b1', fullName: 'acme/app' }),
}));
vi.mock('../../integrations/github/agent-ops.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openPullRequest: async () => ({ number: 7, url: 'https://example.test/pull/7', headRef: 'x' }),
  submitReview: async () => ({
    reviewId: 11,
    repository: 'acme/app',
    number: 7,
    headRef: 'ISS-1-x',
    reviewer: 'bot',
    state: 'APPROVED',
    submittedAt: '2026-10-07T00:00:00Z',
    url: 'https://example.test/pull/7#review-11',
  }),
}));
vi.mock('../../integrations/github/opened-pull-request.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  projectOpenedPullRequest: (...args: unknown[]) => projectOpenedPullRequest(...args),
}));
vi.mock('../../integrations/github/review-note.js', () => ({
  noteReviewOnIssue: (...args: unknown[]) => noteReviewOnIssue(...args),
}));
vi.mock('./lib.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveEffectiveProjectId: async () => 'p1',
  assertPrincipalIsMember: async () => undefined,
  assertPrincipalIsWriter: async () => undefined,
}));

const { forgeGithubTool } = await import('./forge-github.js');

const VALUE = 'zq9-bound-review-body';

function failedWrite(): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into "comments" ("issue_id", "body") values ($1, $2)',
    ['ISS-1', VALUE],
    Object.assign(new Error('canceling statement due to statement timeout'), {
      severity: 'ERROR',
      code: '57014',
    }),
  );
}

const tool = forgeGithubTool({ principal: { userId: 'u1' } } as never);

describe("forge_github's reason for a tracker write that failed after GitHub acted", () => {
  beforeEach(() => {
    projectOpenedPullRequest.mockReset().mockRejectedValue(failedWrite());
    noteReviewOnIssue.mockReset().mockRejectedValue(failedWrite());
  });

  it.each([
    [
      'open-pull-request',
      { action: 'open-pull-request', head: 'ISS-1-x', base: 'main', title: 't' },
      (out: Record<string, { reason: string }>) => out.projection?.reason,
    ],
    [
      'review',
      { action: 'review', pullRequest: 7, verdict: 'APPROVE', body: VALUE },
      (out: Record<string, { reason: string }>) => out.issueComment?.reason,
    ],
  ])('%s names the statement and none of its bound values', async (_, args, reasonOf) => {
    const out = (await tool.handler(args as never)) as Record<string, { reason: string }>;
    const reason = reasonOf(out);
    expect(reason).toContain('insert into "comments"');
    expect(reason).not.toContain(VALUE);
  });
});
