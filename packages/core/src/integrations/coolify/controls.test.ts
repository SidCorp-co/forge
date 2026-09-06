// ISS-925 — the two controls that change production, proved against recorded
// Coolify shapes. Nothing here reaches a real Coolify: a cancel or a rollback
// fired at a live tenant to see whether the code works is the harm this issue
// exists to remove.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const activeCoolifyIntegrations = vi.fn(async () => [] as unknown[]);
const recordDelivery = vi.fn(async () => 'delivery-1');
const updateDelivery = vi.fn(async () => undefined);
const findLastOutbound = vi.fn(async () => null as unknown);
const enqueueCoolifyConfirm = vi.fn(async () => undefined);
const prodActionNeedsHumanConfirm = vi.fn(async () => false);
const client = {
  cancelDeployment: vi.fn(),
  listRollbackImages: vi.fn(),
  rollbackApplication: vi.fn(),
  listApplications: vi.fn(),
};

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: TEST_SECRET,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/test',
    DEVICE_TOKEN_PEPPER: TEST_SECRET,
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('./commands.js', async (importActual) => {
  const actual = await importActual<typeof import('./commands.js')>();
  return { ...actual, activeCoolifyIntegrations: () => activeCoolifyIntegrations() };
});
vi.mock('../deliveries.js', () => ({
  recordDelivery: (...a: unknown[]) => recordDelivery(...(a as [])),
  updateDelivery: (...a: unknown[]) => updateDelivery(...(a as [])),
  findLastOutbound: (...a: unknown[]) => findLastOutbound(...(a as [])),
}));
vi.mock('./confirm.js', () => ({
  enqueueCoolifyConfirm: (...a: unknown[]) => enqueueCoolifyConfirm(...(a as [])),
}));
vi.mock('../../pipeline/release-coolify.js', () => ({
  prodActionNeedsHumanConfirm: (...a: unknown[]) => prodActionNeedsHumanConfirm(...(a as [])),
}));
vi.mock('../store.js', () => ({
  buildContextFromBinding: () => ({ config: {}, secrets: { apiToken: 'tok' } }),
}));
vi.mock('./log-fetch.js', () => ({ buildClient: () => client }));

const {
  assertRollbackTagListed,
  listCoolifyRollbackImages,
  resolveCoolifyTargets,
  runCoolifyCancel,
  runCoolifyRollback,
} = await import('./controls.js');
const { CoolifyCommandError } = await import('./commands.js');

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

function integration(over: { environment?: string; targets?: unknown[] } = {}) {
  return {
    id: 'binding-1',
    environment: over.environment ?? 'staging',
    config: {
      baseUrl: 'https://coolify.example',
      targets: over.targets ?? [{ id: 't1', label: 'Backend', resourceUuid: 'app-1' }],
    },
    lastHealthStatus: 'ok',
    breakerOpenedAt: null,
    pair: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prodActionNeedsHumanConfirm.mockResolvedValue(false);
  activeCoolifyIntegrations.mockResolvedValue([integration()]);
});

describe('runCoolifyCancel', () => {
  it('cancels the last recorded deployment and audits it as one outbound delivery', async () => {
    findLastOutbound.mockResolvedValue({ response: { deployment_uuid: 'dep-7' } });
    client.cancelDeployment.mockResolvedValue({ status: 'cancelled-by-user' });

    const out = await runCoolifyCancel({ projectId: PROJECT_ID });

    expect(client.cancelDeployment).toHaveBeenCalledWith('dep-7');
    expect(out).toMatchObject({ performed: true, deploymentUuid: 'dep-7' });
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'outbound',
        eventName: 'deploy.cancel.requested',
        payload: expect.objectContaining({ deploymentUuid: 'dep-7' }),
      }),
    );
    expect(updateDelivery).toHaveBeenCalledWith(
      'delivery-1',
      expect.objectContaining({ status: 'ok' }),
    );
  });

  it('refuses when the integration has recorded no deployment to cancel', async () => {
    findLastOutbound.mockResolvedValue(null);
    await expect(runCoolifyCancel({ projectId: PROJECT_ID })).rejects.toThrow(
      /no deployment to cancel/,
    );
    expect(client.cancelDeployment).not.toHaveBeenCalled();
  });

  it('records the failure and never reports a cancel Coolify refused', async () => {
    findLastOutbound.mockResolvedValue({ response: { deployment_uuid: 'dep-7' } });
    client.cancelDeployment.mockRejectedValue(
      new Error('Deployment cannot be cancelled. Current status: finished'),
    );

    await expect(runCoolifyCancel({ projectId: PROJECT_ID })).rejects.toThrow(/Current status/);
    expect(updateDelivery).toHaveBeenCalledWith(
      'delivery-1',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('parks a prod cancel for a human instead of dispatching it', async () => {
    activeCoolifyIntegrations.mockResolvedValue([integration({ environment: 'prod' })]);
    prodActionNeedsHumanConfirm.mockResolvedValue(true);

    const out = await runCoolifyCancel({ projectId: PROJECT_ID, deploymentUuid: 'dep-7' });

    expect(out).toMatchObject({ performed: false, pendingHumanConfirm: true });
    expect(client.cancelDeployment).not.toHaveBeenCalled();
  });
});

describe('assertRollbackTagListed', () => {
  it('names the tag it refused and the tags Coolify does list', () => {
    const err = (() => {
      try {
        assertRollbackTagListed([{ tag: 'sha-a' }, { tag: 'sha-b' }], 'sha-gone', 'Backend');
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toContain('sha-gone');
    expect(err?.message).toContain('sha-a, sha-b');
  });

  it('refuses an empty list rather than reading it as nothing to check against', () => {
    expect(() => assertRollbackTagListed([], 'sha-a', 'Backend')).toThrow(
      /listed no rollback images/,
    );
  });

  it('accepts a tag Coolify lists', () => {
    expect(() => assertRollbackTagListed([{ tag: 'sha-a' }], 'sha-a', 'Backend')).not.toThrow();
  });
});

describe('runCoolifyRollback', () => {
  it('rolls back to a listed image and queues the confirmation poll', async () => {
    client.listRollbackImages.mockResolvedValue({
      current: 'sha-b',
      images: [
        { tag: 'sha-a', is_current: false },
        { tag: 'sha-b', is_current: true },
      ],
    });
    client.rollbackApplication.mockResolvedValue({ deployment_uuid: 'dep-9' });

    const out = await runCoolifyRollback({ projectId: PROJECT_ID, commit: 'sha-a' });

    expect(client.rollbackApplication).toHaveBeenCalledWith({
      resourceUuid: 'app-1',
      commit: 'sha-a',
    });
    expect(out).toMatchObject({ performed: true, deploymentUuid: 'dep-9' });
    expect(enqueueCoolifyConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentUuid: 'dep-9', runId: null }),
      { startAfterSeconds: 0 },
    );
  });

  it('never calls Coolify for a tag it does not list', async () => {
    client.listRollbackImages.mockResolvedValue({ images: [{ tag: 'sha-a' }] });

    await expect(
      runCoolifyRollback({ projectId: PROJECT_ID, commit: 'sha-gone' }),
    ).rejects.toBeInstanceOf(CoolifyCommandError);
    expect(client.rollbackApplication).not.toHaveBeenCalled();
  });

  it('treats a 200 carrying no deployment_uuid as a rollback that did not happen', async () => {
    client.listRollbackImages.mockResolvedValue({ images: [{ tag: 'sha-a' }] });
    client.rollbackApplication.mockResolvedValue({ message: 'Deployment skipped.' });

    await expect(runCoolifyRollback({ projectId: PROJECT_ID, commit: 'sha-a' })).rejects.toThrow(
      /queued nothing/,
    );
    expect(enqueueCoolifyConfirm).not.toHaveBeenCalled();
  });

  it('parks a prod rollback for a human before it reads anything', async () => {
    activeCoolifyIntegrations.mockResolvedValue([integration({ environment: 'prod' })]);
    prodActionNeedsHumanConfirm.mockResolvedValue(true);

    const out = await runCoolifyRollback({ projectId: PROJECT_ID, commit: 'sha-a' });

    expect(out).toMatchObject({ performed: false, pendingHumanConfirm: true });
    expect(client.listRollbackImages).not.toHaveBeenCalled();
    expect(client.rollbackApplication).not.toHaveBeenCalled();
  });

  it('refuses to pick a target for the caller when the binding has several', async () => {
    activeCoolifyIntegrations.mockResolvedValue([
      integration({
        targets: [
          { id: 't1', label: 'Backend', resourceUuid: 'app-1' },
          { id: 't2', label: 'Frontend', resourceUuid: 'app-2' },
        ],
      }),
    ]);
    await expect(runCoolifyRollback({ projectId: PROJECT_ID, commit: 'sha-a' })).rejects.toThrow(
      /pass resourceUuid/,
    );
  });
});

describe('listCoolifyRollbackImages', () => {
  it('drops an entry Coolify could not name and keeps the current marker', async () => {
    client.listRollbackImages.mockResolvedValue({
      current: 'sha-b',
      images: [{ tag: 'sha-a', created_at: 'then', is_current: false }, { created_at: 'then' }],
    });

    const res = await listCoolifyRollbackImages({ projectId: PROJECT_ID });

    expect(res.current).toBe('sha-b');
    expect(res.images).toEqual([{ tag: 'sha-a', createdAt: 'then', isCurrent: false }]);
  });
});

describe('resolveCoolifyTargets', () => {
  it('reports found:false for a bound uuid Coolify does not list', async () => {
    activeCoolifyIntegrations.mockResolvedValue([
      integration({
        targets: [
          { id: 't1', label: 'Backend', resourceUuid: 'app-1' },
          { id: 't2', label: 'Frontend', resourceUuid: 'app-gone' },
        ],
      }),
    ]);
    client.listApplications.mockResolvedValue([
      { uuid: 'app-1', name: 'forge-api', git_branch: 'main', git_commit_sha: 'abc1234' },
    ]);

    const { targets } = await resolveCoolifyTargets({ projectId: PROJECT_ID });

    expect(targets[0]).toMatchObject({ found: true, name: 'forge-api', gitBranch: 'main' });
    expect(targets[1]).toMatchObject({ found: false, label: 'Frontend', uuid: 'app-gone' });
  });
});
