/**
 * Which webhook delivery publishes the contract check, and which must not.
 *
 * The `check_run` arm is the whole reason this file exists. Forge's own check
 * run comes back to Forge as a `check_run` delivery, so a publish on that arm
 * is a loop feeding on its own echo — and it would look like working software
 * until somebody read the delivery log.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const applyPullRequestEvent = vi.fn(async () => 1);
const applyCheckRunEvent = vi.fn(async () => 1);
const applyReviewEvent = vi.fn(async () => 1);
const findRowByNumber = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  id: 'pr-row-1',
}));
const openPullRequestsOnBase = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);

vi.mock('./projection.js', () => ({
  applyPullRequestEvent: (...a: unknown[]) => applyPullRequestEvent(...(a as [])),
  applyCheckRunEvent: (...a: unknown[]) => applyCheckRunEvent(...(a as [])),
  applyReviewEvent: (...a: unknown[]) => applyReviewEvent(...(a as [])),
  findRowByNumber: (...a: unknown[]) => findRowByNumber(...a),
  openPullRequestsOnBase: (...a: unknown[]) => openPullRequestsOnBase(...a),
  branchOfPush: (p: { ref?: string }) => p.ref?.replace('refs/heads/', '') ?? null,
}));

vi.mock('./projection-refresh.js', () => ({
  BASE_PUSH_REFRESH_CAP: 25,
  markRefreshCapped: async () => 0,
  refreshStoredPullRequest: async () => true,
  storeRefreshRefusal: async () => 0,
}));

vi.mock('./client.js', () => ({
  buildRepoClient: () => ({ bindingId: 'b', appId: '7', owner: 'o', repo: 'r' }),
  GitHubClientError: class extends Error {},
}));

const publishForStoredPullRequest = vi.fn(async () => null);
vi.mock('./contract-check.js', () => ({
  publishForStoredPullRequest: (...a: unknown[]) => publishForStoredPullRequest(...(a as [])),
}));

const { applyProjectedEvent } = await import('./projection-events.js');

const ctx = {
  bindingId: 'b',
  projectId: 'p',
  config: { owner: 'o', repo: 'r', installationId: '42' },
  secrets: { appId: '7', privateKey: 'pk' },
} as never;

const pullRequest = (action: string) => ({ action, pull_request: { number: 481 } });

beforeEach(() => {
  vi.clearAllMocks();
  findRowByNumber.mockResolvedValue({ id: 'pr-row-1' });
});

describe('the pull_request arm publishes', () => {
  it('publishes when a pull request is opened', async () => {
    await applyProjectedEvent(ctx, 'pull_request', pullRequest('opened'));
    expect(publishForStoredPullRequest).toHaveBeenCalledWith('pr-row-1');
  });

  it('republishes when a head moves', async () => {
    await applyProjectedEvent(ctx, 'pull_request', pullRequest('synchronize'));
    expect(publishForStoredPullRequest).toHaveBeenCalledWith('pr-row-1');
  });

  it('republishes when a draft is marked ready, or a pull request reopened', async () => {
    await applyProjectedEvent(ctx, 'pull_request', pullRequest('ready_for_review'));
    await applyProjectedEvent(ctx, 'pull_request', pullRequest('reopened'));
    expect(publishForStoredPullRequest).toHaveBeenCalledTimes(2);
  });

  it('publishes nothing for a row the projection does not hold', async () => {
    findRowByNumber.mockResolvedValue(null);
    await applyProjectedEvent(ctx, 'pull_request', pullRequest('opened'));
    expect(publishForStoredPullRequest).not.toHaveBeenCalled();
  });
});

describe('the arms that must not publish', () => {
  // cm:guard this is criterion 41, and it is the one assertion that stops a delivery loop.
  // Forge's OWN check run arrives back as a `check_run` delivery; publishing on it republishes
  // on its own echo, forever, and a check run moves nothing the tracker's contract answers.
  it('publishes nothing on a `check_run` delivery, which is Forge`s own run coming back', async () => {
    await applyProjectedEvent(ctx, 'check_run', {
      action: 'completed',
      check_run: { name: 'forge/issue-contract', head_sha: 'a'.repeat(40) },
    });
    expect(applyCheckRunEvent).toHaveBeenCalled();
    expect(publishForStoredPullRequest).not.toHaveBeenCalled();
  });

  it('publishes nothing on a review delivery', async () => {
    await applyProjectedEvent(ctx, 'pull_request_review', { action: 'submitted' });
    expect(publishForStoredPullRequest).not.toHaveBeenCalled();
  });

  // A push moves a BASE. The criteria are about the issue's record, not about what the head is
  // behind by, so there is nothing to recompute.
  it('publishes nothing on a push to a base', async () => {
    openPullRequestsOnBase.mockResolvedValue([{ id: 'pr-row-1' }, { id: 'pr-row-2' }]);
    await applyProjectedEvent(ctx, 'push', { ref: 'refs/heads/main' });
    expect(publishForStoredPullRequest).not.toHaveBeenCalled();
  });
});
