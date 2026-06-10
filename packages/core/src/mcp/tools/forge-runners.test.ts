import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectImpl = vi.fn();
const selectDistinctImpl = vi.fn();
const insertImpl = vi.fn();
const updateImpl = vi.fn();
const executeImpl = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => selectImpl(...a),
    selectDistinct: (...a: unknown[]) => selectDistinctImpl(...a),
    insert: (...a: unknown[]) => insertImpl(...a),
    update: (...a: unknown[]) => updateImpl(...a),
    execute: (...a: unknown[]) => executeImpl(...a),
  },
}));

const { forgeRunnersTool } = await import('./forge-runners.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const RUNNER_ID = '55555555-5555-4555-8555-555555555555';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  machineId: null,
  gitCredentialRef: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'fake0001',
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

function buildCtx() {
  return {
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug: null,
  };
}

// loadVisibleProjectIdsForPrincipal: selectDistinct({id}).from.leftJoin.where.
function mockVisible(ids: string[]) {
  selectDistinctImpl.mockImplementationOnce(() => ({
    from: () => ({
      leftJoin: () => ({
        leftJoin: () => ({
          where: () => Promise.resolve(ids.map((id) => ({ id }))),
        }),
      }),
    }),
  }));
}

// select(...).from(...)[.leftJoin().leftJoin()].where(...).limit(1) — used by
// the runner-project lookup and by assertPrincipalIsAdmin → effectiveProjectRole
// (lib/authz.ts), which chains TWO leftJoins before where().limit(1).
function mockLimitOnce(rows: unknown[]) {
  selectImpl.mockImplementationOnce(() => {
    const tail = { where: () => ({ limit: () => Promise.resolve(rows) }) };
    return {
      from: () => ({ ...tail, leftJoin: () => ({ ...tail, leftJoin: () => tail }) }),
    };
  });
}

// effectiveProjectRole rows (lib/authz.ts) — effective admin vs plain member.
const adminAccessRow = { orgId: 'org-1', memberRole: 'admin', orgRole: null };
const memberAccessRow = { orgId: 'org-1', memberRole: 'member', orgRole: null };

const runnerRow = {
  id: RUNNER_ID,
  projectId: PROJECT_ID,
  type: 'claude-code',
  host: 'device',
  deviceId: DEVICE_ID,
  name: 'r1',
  labels: [],
  capabilities: {},
  config: {},
  status: 'disabled',
  lastSeenAt: null,
  lastError: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  selectImpl.mockReset();
  selectDistinctImpl.mockReset();
  insertImpl.mockReset();
  updateImpl.mockReset();
  executeImpl.mockReset();
});

describe('forge_runners', () => {
  it('list attaches inFlightCount per runner, scoped to visible projects', async () => {
    mockVisible([PROJECT_ID]);
    // primary list query
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            {
              id: RUNNER_ID,
              projectId: PROJECT_ID,
              type: 'claude-code',
              host: 'device',
              deviceId: DEVICE_ID,
              name: 'r1',
              labels: [],
              capabilities: {},
              config: { apiKey: 'secret' },
              status: 'online',
              lastSeenAt: null,
              lastError: null,
            },
          ]),
      }),
    }));
    // in-flight aggregation
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          groupBy: () => Promise.resolve([{ runnerId: RUNNER_ID, n: 2 }]),
        }),
      }),
    }));
    const tool = forgeRunnersTool(buildCtx());
    const res = (await tool.handler({ action: 'list' })) as {
      runners: Array<{ inFlightCount: number; config: { apiKey: string } }>;
    };
    expect(res.runners[0]?.inFlightCount).toBe(2);
    expect(res.runners[0]?.config.apiKey).toBe('***');
  });

  it('list returns empty when caller has no visible projects', async () => {
    mockVisible([]);
    const tool = forgeRunnersTool(buildCtx());
    const res = (await tool.handler({ action: 'list' })) as { runners: unknown[] };
    expect(res.runners).toEqual([]);
  });

  it('register validates capabilities and inserts runner', async () => {
    mockLimitOnce([adminAccessRow]); // assertPrincipalIsAdmin → effective admin
    insertImpl.mockImplementationOnce(() => ({
      values: () => ({
        returning: () =>
          Promise.resolve([
            {
              id: RUNNER_ID,
              projectId: PROJECT_ID,
              type: 'claude-code',
              host: 'device',
              deviceId: DEVICE_ID,
              name: 'r1',
              labels: [],
              capabilities: { skills: ['triage'] },
              config: {},
              status: 'offline',
              lastSeenAt: null,
              lastError: null,
            },
          ]),
      }),
    }));
    const tool = forgeRunnersTool(buildCtx());
    const res = (await tool.handler({
      action: 'register',
      data: {
        projectId: PROJECT_ID,
        type: 'claude-code',
        host: 'device',
        deviceId: DEVICE_ID,
        name: 'r1',
        capabilities: { skills: ['triage'] },
      },
    })) as { runner: { status: string } };
    expect(res.runner.status).toBe('offline');
  });

  it('register by a non-admin on the target project is refused', async () => {
    mockLimitOnce([memberAccessRow]); // member but not admin
    const tool = forgeRunnersTool(buildCtx());
    await expect(
      tool.handler({
        action: 'register',
        data: { projectId: PROJECT_ID, type: 'claude-code', host: 'device', name: 'r1' },
      }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it('register rejects invalid capability shape with INVALID_CAPABILITIES', async () => {
    mockLimitOnce([adminAccessRow]); // admin passes; caps validation fails next
    const tool = forgeRunnersTool(buildCtx());
    await expect(
      tool.handler({
        action: 'register',
        data: {
          projectId: PROJECT_ID,
          type: 'claude-code',
          host: 'device',
          name: 'r1',
          capabilities: { maxConcurrent: -3 },
        },
      }),
    ).rejects.toThrow(/INVALID_CAPABILITIES/);
  });

  it('retire with in-flight jobs and no force throws RUNNER_BUSY', async () => {
    mockLimitOnce([{ projectId: PROJECT_ID }]); // runner project lookup
    mockLimitOnce([adminAccessRow]); // assertPrincipalIsAdmin → effective admin
    executeImpl.mockResolvedValueOnce([{ count: '2' }]); // countInFlightForRunner
    const tool = forgeRunnersTool(buildCtx());
    await expect(tool.handler({ action: 'retire', runnerId: RUNNER_ID })).rejects.toThrow(
      /RUNNER_BUSY/,
    );
  });

  it('retire with force:true transitions through draining → disabled', async () => {
    mockLimitOnce([{ projectId: PROJECT_ID }]);
    mockLimitOnce([adminAccessRow]);
    executeImpl.mockResolvedValueOnce([{ count: '1' }]);
    // draining update (no returning needed)
    updateImpl.mockImplementationOnce(() => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }));
    // disabled update with returning
    updateImpl.mockImplementationOnce(() => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([runnerRow]),
        }),
      }),
    }));
    const tool = forgeRunnersTool(buildCtx());
    const res = (await tool.handler({
      action: 'retire',
      runnerId: RUNNER_ID,
      force: true,
    })) as { runner: { status: string } };
    expect(res.runner.status).toBe('disabled');
  });

  it('update_capabilities validates and writes new capabilities', async () => {
    mockLimitOnce([{ projectId: PROJECT_ID }]);
    mockLimitOnce([adminAccessRow]);
    updateImpl.mockImplementationOnce(() => ({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve([{ ...runnerRow, status: 'online', capabilities: { maxConcurrent: 4 } }]),
        }),
      }),
    }));
    const tool = forgeRunnersTool(buildCtx());
    const res = (await tool.handler({
      action: 'update_capabilities',
      runnerId: RUNNER_ID,
      capabilities: { maxConcurrent: 4 },
    })) as { runner: { capabilities: { maxConcurrent: number } } };
    expect(res.runner.capabilities.maxConcurrent).toBe(4);
  });
});
