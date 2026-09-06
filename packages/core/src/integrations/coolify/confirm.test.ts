/**
 * ISS-922 — the poller that replaced the webhook Coolify cannot send.
 *
 * Every axis of the outcome: success, reported failure, the deadline, the
 * multi-target business rule, the run-less deploy, and the classifier's
 * refusal to guess at a status it does not know.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    DEVICE_TOKEN_PEPPER: 'test-pepper',
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../queue/boss.js', () => ({ boss: { send: vi.fn() } }));

const recordDeliveryMock = vi.fn(async (_input: unknown) => 'inb-1');
vi.mock('../deliveries.js', () => ({
  recordDelivery: (input: unknown) => recordDeliveryMock(input),
}));

const settleMock = vi.fn(async (_args: unknown) => ({}) as Record<string, unknown>);
const isCloseDeferredMock = vi.fn(async () => false);
vi.mock('../../pipeline/deploy-confirmations.js', async () => {
  const real = await vi.importActual<typeof import('../../pipeline/deploy-confirmations.js')>(
    '../../pipeline/deploy-confirmations.js',
  );
  return {
    resolveDeployGate: real.resolveDeployGate,
    settleDeployTarget: (args: unknown) => settleMock(args),
    isCloseDeferred: (...a: unknown[]) => isCloseDeferredMock(...(a as [])),
  };
});

const closeRunMock = vi.fn(async () => 'settled' as const);
const setCurrentStepMock = vi.fn();
vi.mock('../../pipeline/runs.js', () => ({
  closeRun: (...a: unknown[]) => closeRunMock(...(a as [])),
  setCurrentStep: (...a: unknown[]) => setCurrentStepMock(...(a as [])),
  RELEASE_DEPLOY_DONE_STEP: 'release.deploy.done',
}));

const findBindingMock = vi.fn(async () => ({ id: 'bind-1', connectionId: 'conn-1' }));
const findConnectionMock = vi.fn(async () => ({ id: 'conn-1' }));
vi.mock('../store.js', () => ({
  findBindingById: (...a: unknown[]) => findBindingMock(...(a as [])),
  findConnectionById: (...a: unknown[]) => findConnectionMock(...(a as [])),
  buildContextFromBinding: () => ({
    config: { baseUrl: 'https://coolify.example' },
    secrets: { apiToken: 'cf' },
  }),
}));

const getDeploymentMock = vi.fn();
vi.mock('./log-fetch.js', () => ({
  buildClient: () => ({ getDeployment: (...a: unknown[]) => getDeploymentMock(...(a as [])) }),
}));

const { classifyDeploymentStatus, enqueueCoolifyConfirm, runCoolifyConfirm } = await import(
  './confirm.js'
);
const { boss } = await import('../../queue/boss.js');

const sendCalls = () => (boss.send as unknown as { mock: { calls: unknown[][] } }).mock.calls;

const RUN_ID = 'run-1';
const FUTURE = new Date(Date.now() + 600_000).toISOString();
const PAST = new Date(Date.now() - 1_000).toISOString();

function job(over: Record<string, unknown> = {}) {
  return {
    jobKind: 'coolify.confirm' as const,
    bindingId: 'bind-1',
    runId: RUN_ID as string | null,
    deliveryId: 'del-1',
    deploymentUuid: 'dep-1',
    targetLabel: 'Backend',
    deadlineAt: FUTURE,
    ...over,
  };
}

const holds = (status: 'pending' | 'succeeded' | 'failed', label = 'Frontend') => ({
  other: {
    bindingId: 'bind-1',
    deploymentUuid: 'dep-2',
    targetLabel: label,
    status,
    deadlineAt: FUTURE,
  },
});

beforeEach(() => {
  settleMock.mockResolvedValue({});
  isCloseDeferredMock.mockResolvedValue(false);
});
afterEach(() => vi.clearAllMocks());

describe('classifyDeploymentStatus', () => {
  it.each(['finished', 'success', 'SUCCEEDED', 'completed'])('%s is a success', (s) => {
    expect(classifyDeploymentStatus(s)).toBe('succeeded');
  });
  it.each(['failed', 'error', 'cancelled', 'canceled'])('%s is a failure', (s) => {
    expect(classifyDeploymentStatus(s)).toBe('failed');
  });
  it.each(['queued', 'in_progress', '', null, undefined, 'some-future-coolify-status'])(
    '%s is not terminal — an unknown status is never read as success',
    (s) => {
      expect(classifyDeploymentStatus(s)).toBe('pending');
    },
  );
});

describe('runCoolifyConfirm', () => {
  it('a successful deployment writes an inbound delivery row and marks the hold succeeded', async () => {
    getDeploymentMock.mockResolvedValue({ status: 'finished' });

    expect(await runCoolifyConfirm(job())).toEqual({ settled: 'succeeded', closedRun: false });
    expect(recordDeliveryMock.mock.calls[0]?.[0]).toMatchObject({
      direction: 'inbound',
      eventName: 'deploy.succeeded',
      requestId: 'dep-1',
      payload: { source: 'poll', status: 'succeeded', deployment_uuid: 'dep-1' },
    });
    expect(settleMock.mock.calls[0]?.[0]).toMatchObject({
      runId: RUN_ID,
      deliveryId: 'del-1',
      status: 'succeeded',
    });
  });

  it('does NOT close the run while a sibling target is still in flight', async () => {
    getDeploymentMock.mockResolvedValue({ status: 'finished' });
    settleMock.mockResolvedValue(holds('pending'));
    isCloseDeferredMock.mockResolvedValue(true);

    expect(await runCoolifyConfirm(job())).toEqual({ settled: 'succeeded', closedRun: false });
    expect(setCurrentStepMock.mock.calls).toEqual([]);
  });

  it('closes the deferred run only once EVERY target has confirmed', async () => {
    getDeploymentMock.mockResolvedValue({ status: 'finished' });
    settleMock.mockResolvedValue(holds('succeeded'));
    isCloseDeferredMock.mockResolvedValue(true);

    expect(await runCoolifyConfirm(job())).toEqual({
      settled: 'succeeded',
      closedRun: 'completed',
    });
    expect(setCurrentStepMock.mock.calls).toEqual([[RUN_ID, 'release.deploy.done']]);
    expect(closeRunMock.mock.calls).toEqual([[RUN_ID, 'completed']]);
  });

  it('leaves a run nobody tried to close alone, even with every target confirmed', async () => {
    getDeploymentMock.mockResolvedValue({ status: 'finished' });
    settleMock.mockResolvedValue(holds('succeeded'));
    isCloseDeferredMock.mockResolvedValue(false);

    expect(await runCoolifyConfirm(job())).toEqual({ settled: 'succeeded', closedRun: false });
    expect(setCurrentStepMock.mock.calls).toEqual([[RUN_ID, 'release.deploy.done']]);
    expect(closeRunMock.mock.calls).toEqual([]);
  });

  it('a reported failure FAILS the run rather than annotating it', async () => {
    getDeploymentMock.mockResolvedValue({ status: 'failed' });

    expect(await runCoolifyConfirm(job())).toEqual({
      settled: 'failed',
      closedRun: 'failed',
      detail: 'coolify reported failed',
    });
    expect(recordDeliveryMock.mock.calls[0]?.[0]).toMatchObject({ eventName: 'deploy.failed' });
    expect(closeRunMock.mock.calls).toEqual([[RUN_ID, 'failed']]);
  });

  it('re-polls while the deployment is non-terminal and the deadline is ahead', async () => {
    getDeploymentMock.mockResolvedValue({ status: 'in_progress' });

    expect(await runCoolifyConfirm(job())).toEqual({ settled: null, closedRun: false });
    expect(sendCalls()).toHaveLength(1);
    expect(closeRunMock.mock.calls).toEqual([]);
    expect(recordDeliveryMock.mock.calls).toEqual([]);
  });

  it('a deploy still non-terminal AT the deadline fails the run, naming what it could not confirm', async () => {
    getDeploymentMock.mockResolvedValue({ status: 'in_progress' });

    const out = await runCoolifyConfirm(job({ deadlineAt: PAST }));

    expect(out.settled).toBe('failed');
    expect(out.closedRun).toBe('failed');
    expect(out.detail).toContain('deadline');
    expect(sendCalls()).toEqual([]);
    expect(settleMock.mock.calls[0]?.[0]).toMatchObject({ status: 'failed' });
    expect(closeRunMock.mock.calls).toEqual([[RUN_ID, 'failed']]);
  });

  it('an unreachable Coolify is re-polled, never counted as a failed deploy', async () => {
    getDeploymentMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const out = await runCoolifyConfirm(job());

    expect(out.settled).toBeNull();
    expect(out.detail).toBe('ECONNREFUSED');
    expect(sendCalls()).toHaveLength(1);
    expect(closeRunMock.mock.calls).toEqual([]);
  });

  it('a run-less deploy is still polled and still audited, and advances no run', async () => {
    getDeploymentMock.mockResolvedValue({ status: 'finished' });

    expect(await runCoolifyConfirm(job({ runId: null }))).toEqual({
      settled: 'succeeded',
      closedRun: false,
    });
    expect(recordDeliveryMock.mock.calls[0]?.[0]).toMatchObject({ direction: 'inbound' });
    expect(settleMock.mock.calls).toEqual([]);
    expect(closeRunMock.mock.calls).toEqual([]);
  });

  it('a vanished binding resolves the hold rather than polling a dead integration forever', async () => {
    findBindingMock.mockResolvedValue(null as never);

    const out = await runCoolifyConfirm(job());

    expect(out).toMatchObject({ settled: 'failed', detail: expect.stringContaining('gone') });
    expect(settleMock.mock.calls[0]?.[0]).toMatchObject({ status: 'failed' });
    expect(sendCalls()).toEqual([]);
  });
});

describe('enqueueCoolifyConfirm', () => {
  it('gives every re-poll its own dedup key so pg-boss cannot swallow the second one', async () => {
    await enqueueCoolifyConfirm(job());
    await enqueueCoolifyConfirm(job());
    const keys = sendCalls().map((c) => (c[2] as { singletonKey: string }).singletonKey);
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.startsWith('del-1:'))).toBe(true);
  });
});
