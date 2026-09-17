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

const { CHECK_PUBLISH_EVENT } = await import('./contract-check.js');
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

  // cm:guard `registry.ts:dispatchThrough` refuses a provider whose adapter implements no outbound dispatch, by name. This asserts github is no longer in that set — which is the whole of criterion 2, and it goes red the moment the method is dropped.
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
  it('refuses an event it does not serve, naming it AND the one it does', async () => {
    await expect(
      dispatch()?.(ctx, { eventName: 'pull_request.merge', payload: {} }),
    ).rejects.toThrow(/pull_request\.merge/);
    await expect(
      dispatch()?.(ctx, { eventName: 'pull_request.merge', payload: {} }),
    ).rejects.toThrow(new RegExp(CHECK_PUBLISH_EVENT.replace('.', '\\.')));
    expect(publishForStoredPullRequest).not.toHaveBeenCalled();
  });

  it('refuses the merge verb explicitly, which is a later layer and not this one', async () => {
    await expect(
      dispatch()?.(ctx, { eventName: 'pull_request.merge', payload: {} }),
    ).rejects.toThrow(/Merging/);
  });

  // cm:guard the refusal is RECORDED as well as thrown, and against a NULL binding rather than the dead one: a row scoped to a binding that is gone is a row nothing will list.
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
