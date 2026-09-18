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
  // cm:guard `stateOf` is the REAL one and not a stub, because it is the single definition of what
  // `merged` means and the merged arm this suite exercises is decided by it. A stub here would let
  // the two disagree, which is the thing the projection exists to stop.
  stateOf: (pr: { merged?: boolean; merged_at?: string | null; state?: string }) =>
    pr.merged === true || pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
}));

const recordIssueMerge = vi.fn(async () => ({ wrote: false, mergedAt: null, commitSha: null }));
vi.mock('../../issues/merge-record.js', () => ({
  recordIssueMerge: (...a: unknown[]) => recordIssueMerge(...(a as [])),
}));

let linkedIssueId: string | null = null;
vi.mock('./issue-link.js', () => ({ resolveIssueForHeadRef: async () => linkedIssueId }));

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
  // cm:guard this is criterion 41, and it is the one assertion that stops a delivery loop. Forge's OWN check run arrives back as a `check_run` delivery; publishing on it republishes on its own echo, forever, and a check run moves nothing the tracker's contract answers.
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

/**
 * ISS-1073 outcome 3 — a merge Forge did not make reaches the same row.
 *
 * The writer is `issues/merge-record.ts` for both routes, which is what makes
 * them one record rather than two: the kernel's merge and the delivery that
 * follows it both write under `merged_commit_sha IS NULL`, so whichever arrives
 * first holds the row. Here the writer is a spy; that the SECOND write finds
 * nothing is the predicate's own property and is proved in
 * `issues/merge-record.test.ts` and against Postgres in
 * `tests/integration/kernel-merge-e2e.test.ts`.
 */
describe('a merge somebody else made', () => {
  const merged = (over: Record<string, unknown> = {}) => ({
    action: 'closed',
    pull_request: {
      number: 481,
      merged: true,
      merged_at: '2026-09-18T06:30:01.449Z',
      merge_commit_sha: 'e45b4ecf596c58e10135c25af4f7279a0a804802',
      head: { ref: 'ISS-1073-kernel-merge', sha: 'c0ffee1' },
      base: { ref: 'main', sha: 'b' },
      ...over,
    },
  });

  beforeEach(() => {
    linkedIssueId = 'iss-1073';
  });

  it('stamps the issue the head branch names, with the commit and time GitHub reported', async () => {
    await applyProjectedEvent(ctx, 'pull_request', merged());
    expect(recordIssueMerge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        issueId: 'iss-1073',
        evidence: {
          kind: 'observed',
          commitSha: 'e45b4ecf596c58e10135c25af4f7279a0a804802',
          mergedAt: new Date('2026-09-18T06:30:01.449Z'),
          via: 'event',
        },
      }),
    );
  });

  // cm:guard the stamp is taken from the PAYLOAD, so a delivery the ordering guard skipped still
  // records the merge. `applyPullRequestEvent` answers 0 for a row whose scalars were not written,
  // and treating that as "nothing to do" would lose a landing to a retry arriving out of order.
  it('stamps even when the projection wrote no row', async () => {
    applyPullRequestEvent.mockResolvedValueOnce(0);
    await applyProjectedEvent(ctx, 'pull_request', merged());
    expect(recordIssueMerge).toHaveBeenCalled();
  });

  it('stamps nothing for a pull request that closed without merging', async () => {
    await applyProjectedEvent(ctx, 'pull_request', merged({ merged: false, merged_at: null }));
    expect(recordIssueMerge).not.toHaveBeenCalled();
  });

  it('stamps nothing when GitHub sent no merge commit', async () => {
    await applyProjectedEvent(ctx, 'pull_request', merged({ merge_commit_sha: null }));
    expect(recordIssueMerge).not.toHaveBeenCalled();
  });

  it('stamps nothing for a branch that names no issue on this project', async () => {
    linkedIssueId = null;
    await applyProjectedEvent(ctx, 'pull_request', merged());
    expect(recordIssueMerge).not.toHaveBeenCalled();
  });

  // cm:guard announced only when THIS delivery wrote. The kernel's own merge announces its own, so
  // announcing on a delivery that stamped nothing would republish the same change twice — once per
  // route — on every merge Forge made itself.
  it('does not announce a stamp it did not write', async () => {
    recordIssueMerge.mockResolvedValueOnce({ wrote: false, mergedAt: null, commitSha: null });
    const heard: unknown[] = [];
    const { hooks } = await import('../../pipeline/hooks.js');
    hooks.on('contractInputChanged', async (p) => void heard.push(p), { name: 'merged-arm-test' });
    await applyProjectedEvent(ctx, 'pull_request', merged());
    expect(heard).toHaveLength(0);
  });
});
