import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ISS-1085 — the outbound dispatch worker routes by the BINDING's provider.
 *
 * It called `coolifyAdapter.dispatchOutbound` directly until this change, which was correct only
 * while Coolify was the one provider that dispatched. With Sentry dispatching too, a retried Sentry
 * delivery would have reached Coolify's client — a wrong provider answering as if it were the right
 * one, which is the silent substitution this repo refuses.
 *
 * The worker is driven through the handler `registerIntegrationsWorker` registers, rather than
 * through an export made for this file: what has to be proved is the WIRING, and a directly-called
 * private function proves the function.
 */

const findBindingById = vi.fn();
const findConnectionById = vi.fn();
const dispatchThrough = vi.fn();
const createQueue = vi.fn();
const work = vi.fn();

vi.mock('./store.js', () => ({
  findBindingById: (...a: unknown[]) => findBindingById(...(a as [])),
  findConnectionById: (...a: unknown[]) => findConnectionById(...(a as [])),
  buildContextFromBinding: ({ binding, connection }: Record<string, never>) => ({
    connectionId: (connection as unknown as { id: string }).id,
    bindingId: (binding as unknown as { id: string }).id,
    projectId: 'proj-1',
    provider: (binding as unknown as { provider: string }).provider,
    role: 'service',
    stages: (binding as unknown as { stages?: string[] }).stages ?? [],
    config: {},
    secrets: {},
    integrationSecret: null,
  }),
}));
vi.mock('./registry.js', () => ({
  dispatchThrough: (...a: unknown[]) => dispatchThrough(...(a as [])),
}));
vi.mock('../queue/boss.js', () => ({
  boss: {
    createQueue: (...a: unknown[]) => createQueue(...(a as [])),
    work: (...a: unknown[]) => work(...(a as [])),
  },
}));
vi.mock('./coolify/confirm.js', () => ({
  applyDeploySettlement: vi.fn(),
  runCoolifyConfirm: vi.fn(),
}));
vi.mock('./coolify/health-gate.js', () => ({
  probeHealth: vi.fn(),
  runCoolifyHealthGate: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { registerIntegrationsWorker } = await import('./queue.js');

type Handler = (arg: unknown) => Promise<void>;
let handler: Handler;

beforeEach(async () => {
  createQueue.mockResolvedValue(undefined);
  work.mockImplementation(async (_queue: string, _opts: unknown, h: Handler) => {
    handler = h;
    return 'worker-1';
  });
  dispatchThrough.mockResolvedValue({ deliveryId: 'del-1', durationMs: 1 });
  await registerIntegrationsWorker();
});

afterEach(() => {
  vi.clearAllMocks();
});

function bound(provider: string) {
  findBindingById.mockResolvedValueOnce({
    id: 'bind-1',
    provider,
    connectionId: 'conn-1',
    active: true,
    stages: ['live'],
  });
  findConnectionById.mockResolvedValueOnce({ id: 'conn-1', active: true });
}

describe('the outbound dispatch worker — criterion 15', () => {
  it('dispatches a sentry binding through sentry, not through coolify', async () => {
    bound('sentry');
    await handler({
      data: {
        jobKind: 'coolify.dispatch',
        bindingId: 'bind-1',
        runId: null,
        issueId: null,
        eventName: 'sentry.issue.set-status',
        payload: { issueId: '4411', targetLabel: 'forge-core', status: 'resolvedInNextRelease' },
      },
    });

    expect(dispatchThrough).toHaveBeenCalledTimes(1);
    expect(dispatchThrough.mock.calls[0]?.[0]).toBe('sentry');
  });

  it('dispatches a coolify binding through coolify', async () => {
    bound('coolify');
    await handler({
      data: {
        jobKind: 'coolify.dispatch',
        bindingId: 'bind-1',
        runId: 'run-1',
        issueId: 'iss-1',
        eventName: 'release.deploy',
      },
    });
    expect(dispatchThrough.mock.calls[0]?.[0]).toBe('coolify');
  });
});

describe('the replay — criterion 16', () => {
  it('dispatches the job payload unchanged where the job carries one', async () => {
    bound('sentry');
    const payload = {
      issueId: '4411',
      targetLabel: 'forge-core',
      status: 'resolvedInNextRelease',
    };
    await handler({
      data: {
        jobKind: 'coolify.dispatch',
        bindingId: 'bind-1',
        runId: null,
        issueId: null,
        eventName: 'sentry.issue.set-status',
        requestId: 'retry_abc',
        payload,
      },
    });

    expect(dispatchThrough.mock.calls[0]?.[2]).toEqual({
      eventName: 'sentry.issue.set-status',
      payload,
      requestId: 'retry_abc',
      runId: null,
    });
  });

  it('builds the payload the old way for a job that carries none', async () => {
    bound('coolify');
    await handler({
      data: {
        jobKind: 'coolify.dispatch',
        bindingId: 'bind-1',
        runId: 'run-1',
        issueId: 'iss-1',
        eventName: 'release.deploy',
      },
    });

    expect(dispatchThrough.mock.calls[0]?.[2]).toMatchObject({
      payload: { runId: 'run-1', issueId: 'iss-1', stages: ['live'] },
    });
  });
});

describe('the guards the worker already had', () => {
  it('drops the job when the binding is inactive', async () => {
    findBindingById.mockResolvedValueOnce({ id: 'bind-1', provider: 'sentry', active: false });
    await handler({
      data: {
        jobKind: 'coolify.dispatch',
        bindingId: 'bind-1',
        runId: null,
        issueId: null,
        eventName: 'x',
      },
    });
    expect(dispatchThrough).not.toHaveBeenCalled();
  });

  it('drops the job when the connection is inactive (breaker open)', async () => {
    findBindingById.mockResolvedValueOnce({
      id: 'bind-1',
      provider: 'sentry',
      connectionId: 'conn-1',
      active: true,
    });
    findConnectionById.mockResolvedValueOnce({ id: 'conn-1', active: false });
    await handler({
      data: {
        jobKind: 'coolify.dispatch',
        bindingId: 'bind-1',
        runId: null,
        issueId: null,
        eventName: 'x',
      },
    });
    expect(dispatchThrough).not.toHaveBeenCalled();
  });

  it('rethrows a dispatch failure so pg-boss schedules the retry', async () => {
    bound('sentry');
    dispatchThrough.mockRejectedValueOnce(new Error('sentry: Sentry answered HTTP 500'));
    await expect(
      handler({
        data: {
          jobKind: 'coolify.dispatch',
          bindingId: 'bind-1',
          runId: null,
          issueId: null,
          eventName: 'sentry.issue.read',
          payload: { issueId: '4411', targetLabel: 'forge-core' },
        },
      }),
    ).rejects.toThrow('Sentry answered HTTP 500');
  });
});

/**
 * ISS-1073 — a refusal that must not come back an hour later.
 *
 * `enqueueOutboundDispatch` retries five times with exponential backoff, which is
 * right for a deploy that met a transient API blip and wrong for an operation
 * whose refusal is a statement about the world. A merge refused because a
 * required check went red, re-sent after the backoff, lands the moment somebody
 * pushes a fix — a merge nobody asked for at a moment nobody chose.
 */
describe('a terminal refusal is not retried', () => {
  const dispatchOne = () =>
    handler({
      data: {
        jobKind: 'coolify.dispatch',
        bindingId: 'bind-1',
        runId: null,
        issueId: null,
        eventName: 'pull_request.merge',
        payload: { pullRequestId: 'pr-1', requestedBy: 'user:alice' },
      },
    });

  it('resolves rather than rethrowing, so pg-boss marks the job done', async () => {
    const { NonRetryableDispatchError } = await import('./types.js');
    bound('github');
    dispatchThrough.mockRejectedValueOnce(
      new NonRetryableDispatchError('the base branch requires `ci-passed`', 'required-check'),
    );
    await expect(dispatchOne()).resolves.toBeUndefined();
    expect(dispatchThrough).toHaveBeenCalledTimes(1);
  });

  it('still rethrows an ordinary failure, which is what the retries are for', async () => {
    bound('coolify');
    dispatchThrough.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(dispatchOne()).rejects.toThrow(/ECONNRESET/);
  });
});
