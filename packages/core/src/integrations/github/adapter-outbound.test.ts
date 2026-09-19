/**
 * The one outbound verb github serves, and everything it refuses.
 *
 * ISS-1062 made the declaration and the implementation a gate rather than a
 * promise: `canDispatch: true` beside no `dispatchOutbound` fails the form axis,
 * and so does the reverse. This file is about the other half — what the verb
 * does when it is reached with something it does not serve, because a default
 * arm that published the contract check for any event would make a caller's
 * mistake return 200 and look like it worked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

let bindingRows: unknown[] = [{ id: 'binding-1' }];
const select = vi.fn(() => ({
  from: () => ({ where: () => ({ limit: async () => bindingRows }) }),
}));
vi.mock('../../db/client.js', () => ({ db: { select } }));

const recordDelivery = vi.fn(async () => 'delivery-1');
vi.mock('../deliveries.js', () => ({
  recordDelivery: (...args: unknown[]) => recordDelivery(...(args as [])),
  updateDelivery: async () => undefined,
}));

const publishForStoredPullRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  kind: 'published',
  deliveryId: 'delivery-2',
  outcome: 'created',
  checkRunId: 42,
}));
vi.mock('./contract-check.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    publishForStoredPullRequest: (...args: unknown[]) => publishForStoredPullRequest(...args),
  };
});

const mergeStoredPullRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  kind: 'merged',
  deliveryId: 'delivery-3',
  commitSha: 'e45b4ec',
  mergedAt: new Date(),
  stamped: true,
}));
vi.mock('./merge.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    mergeStoredPullRequest: (...args: unknown[]) => mergeStoredPullRequest(...args),
  };
});

const { CHECK_PUBLISH_EVENT } = await import('./contract-check.js');
const { MERGE_EVENT } = await import('./merge.js');
const { NonRetryableDispatchError } = await import('../types.js');
const { githubIntegration } = await import('./adapter.js');
const { __resetRegistry, dispatchThrough, registerIntegration } = await import('../registry.js');

__resetRegistry();
registerIntegration(githubIntegration as never);

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const PR_ID = '33333333-3333-4333-8333-333333333333';

const ctx = {
  connectionId: 'c1',
  bindingId: 'binding-1',
  projectId: PROJECT_ID,
  provider: 'github',
  role: 'service',
  stages: [],
  config: { owner: 'o', repo: 'r', installationId: '42' },
  secrets: { appId: '7', privateKey: 'pk' },
} as never;

const dispatch = () => githubIntegration.adapter?.dispatchOutbound;

beforeEach(() => {
  vi.clearAllMocks();
  bindingRows = [{ id: 'binding-1' }];
});

describe('the declaration and the implementation agree', () => {
  it('declares `canDispatch: true`', () => {
    expect(githubIntegration.capabilities.canDispatch).toBe(true);
  });

  it('is reachable through `dispatchThrough` instead of its "implements no outbound" refusal', async () => {
    const result = await dispatchThrough('github', ctx, {
      eventName: CHECK_PUBLISH_EVENT,
      payload: { pullRequestId: PR_ID },
    });
    expect(result).toMatchObject({ deliveryId: 'delivery-2', externalId: '42' });
    expect(publishForStoredPullRequest).toHaveBeenCalledWith(PR_ID, 'binding-1');
  });
});

describe('what it refuses, and by what name', () => {
  it('refuses an event it does not serve, naming it AND every verb it does', async () => {
    await expect(
      dispatch()?.(ctx, { eventName: 'pull_request.open', payload: {} }),
    ).rejects.toThrow(/pull_request\.open/);
    await expect(
      dispatch()?.(ctx, { eventName: 'pull_request.open', payload: {} }),
    ).rejects.toThrow(new RegExp(CHECK_PUBLISH_EVENT.replace('.', '\\.')));
    await expect(
      dispatch()?.(ctx, { eventName: 'pull_request.open', payload: {} }),
    ).rejects.toThrow(/pull_request\.merge/);
    expect(publishForStoredPullRequest).not.toHaveBeenCalled();
  });

  it('sends a caller naming a judgement verb to the face that carries it', async () => {
    await expect(
      dispatch()?.(ctx, { eventName: 'pull_request.review', payload: {} }),
    ).rejects.toThrow(/forge_github/);
  });

  it('refuses a project with no active binding, and writes that refusal to the log', async () => {
    bindingRows = [];
    await expect(
      dispatch()?.(ctx, { eventName: CHECK_PUBLISH_EVENT, payload: { pullRequestId: PR_ID } }),
    ).rejects.toThrow(/no active GitHub binding/);
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: null,
        direction: 'outbound',
        eventName: CHECK_PUBLISH_EVENT,
        status: 'failed',
      }),
    );
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ projectId: PROJECT_ID }) }),
    );
  });

  it('refuses a payload that names no pull request, saying what shape is valid', async () => {
    await expect(
      dispatch()?.(ctx, { eventName: CHECK_PUBLISH_EVENT, payload: {} }),
    ).rejects.toThrow(/pullRequestId/);
  });

  it('refuses a pull request the projection does not hold, naming its id', async () => {
    publishForStoredPullRequest.mockResolvedValue(null);
    await expect(
      dispatch()?.(ctx, { eventName: CHECK_PUBLISH_EVENT, payload: { pullRequestId: PR_ID } }),
    ).rejects.toThrow(new RegExp(PR_ID));
  });
});

describe('what it reports back', () => {
  it('carries no external id for a skip, because nothing was published', async () => {
    publishForStoredPullRequest.mockResolvedValue({
      kind: 'skipped',
      deliveryId: 'delivery-3',
      reason: 'the head branch names no issue',
    });
    const result = await dispatch()?.(ctx, {
      eventName: CHECK_PUBLISH_EVENT,
      payload: { pullRequestId: PR_ID },
    });
    expect(result).toMatchObject({ deliveryId: 'delivery-3' });
    expect(result?.externalId).toBeUndefined();
  });
});

/**
 * ISS-1073 — the merge verb's own door: what it refuses before calling anything,
 * and what shape its refusal takes on the way out.
 */
describe('the merge verb', () => {
  const merge = (payload: Record<string, unknown>) =>
    dispatch()?.(ctx, { eventName: MERGE_EVENT, payload });

  it('carries the binding the context authorised into the merge', async () => {
    await merge({ pullRequestId: PR_ID, requestedBy: 'user:alice' });
    expect(mergeStoredPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pullRequestId: PR_ID, requestedBy: 'user:alice' }),
      'binding-1',
    );
  });

  it.each([
    ['a misspelled merge method', { method: 'sqaush' }, /is not a merge method/],
    ['a merge method that is not a string', { method: 7 }, /is not a merge method/],
    ['an expected head that is not a sha', { expectedHeadSha: 'not-a-sha' }, /must be a git sha/],
    [
      'an expected head that is not a string',
      { expectedHeadSha: { sha: 'x' } },
      /must be a git sha/,
    ],
  ])('refuses %s by name, before anything is called', async (_what, over, says) => {
    await expect(
      merge({ pullRequestId: PR_ID, requestedBy: 'user:alice', ...over }),
    ).rejects.toThrow(says);
    expect(mergeStoredPullRequest).not.toHaveBeenCalled();
  });

  it('still takes the defaults when the optional fields are absent', async () => {
    await merge({ pullRequestId: PR_ID, requestedBy: 'user:alice' });
    const sent = mergeStoredPullRequest.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('method');
    expect(sent).not.toHaveProperty('expectedHeadSha');
  });

  it('throws a terminal refusal, so the queue does not send it again', async () => {
    mergeStoredPullRequest.mockResolvedValue({
      kind: 'refused',
      deliveryId: 'd1',
      reason: 'required-check',
      detail: 'the base branch requires the check `ci-passed`',
    });
    await expect(merge({ pullRequestId: PR_ID, requestedBy: 'user:alice' })).rejects.toBeInstanceOf(
      NonRetryableDispatchError,
    );
  });

  it('needs a pull request id, naming the verb that asked for one', async () => {
    await expect(merge({ requestedBy: 'user:alice' })).rejects.toThrow(/pull_request\.merge/);
    expect(mergeStoredPullRequest).not.toHaveBeenCalled();
  });
});
