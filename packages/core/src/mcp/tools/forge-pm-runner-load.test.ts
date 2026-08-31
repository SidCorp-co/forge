import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const queue: unknown[] = [];

// biome-ignore lint/suspicious/noExplicitAny: chainable mock proxy
const chain: any = {};
chain.from = () => chain;
chain.leftJoin = () => chain;
chain.where = () => chain;
chain.orderBy = () => chain;
chain.limit = () => chain;
chain.groupBy = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) => Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => chain), execute: () => Promise.resolve(queue.shift()) },
}));

const { pmRunnerLoadHandler, pmRunnerLoadInputSchema } = await import('./forge-pm-runner-load.js');

// cm:why these cases used to run through the deprecated `forge_pm.<action>` shim factory, which was deleted once nothing named it; the handler and its schema are what `forge_project_pm` actually dispatches into, so the coverage moves down one layer instead of leaving with the shim — for runner_load, dispatch and write_decision this file is still the only place that behaviour is tested
const forgePmRunnerLoadTool = (c: typeof ctx) => ({
  handler: async (args: unknown) =>
    pmRunnerLoadHandler(c.device, pmRunnerLoadInputSchema.parse(args)),
});

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

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
  disabledAt: null,
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

const ctx = {
  principal: { kind: 'device' as const, device: fakeDevice },
  device: fakeDevice,
  projectSlug: null,
};

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
});

describe('forge_pm.runner_load', () => {
  it('rejects non-member', async () => {
    const tool = forgePmRunnerLoadTool(ctx);
    queue.push([{ orgId: 'org-1', memberRole: null, orgRole: null }]);
    await expect(tool.handler({ projectId: PROJECT_ID })).rejects.toThrow(/FORBIDDEN/);
  });

  // cm:edge contract -> packages/core/src/jobs/dispatch-gates.ts — `capacity` must report the uniform RUNNER_CAP_PER_RUNNER and NEVER a row's legacy `capabilities.maxConcurrent`: the dispatcher stopped reading that override in ISS-232 Phase 4, so surfacing it here would tell an operator this runner takes N jobs at once while dispatch still gives it one.
  it('returns runner list with capacity=1 + inFlight', async () => {
    const tool = forgePmRunnerLoadTool(ctx);
    const memberCheck = [{ orgId: 'org-1', memberRole: 'member', orgRole: null }];
    queue.push(
      memberCheck,
      [
        {
          id: 'r1',
          type: 'claude-code',
          host: 'device',
          status: 'online',
          lastSeenAt: new Date('2026-05-01T00:00:00Z'),
        },
        {
          id: 'r2',
          type: 'antigravity',
          host: 'remote',
          status: 'offline',
          lastSeenAt: null,
        },
      ],
      [{ runner_id: 'r1', n: 1 }],
    );

    const result = (await tool.handler({ projectId: PROJECT_ID })) as {
      runners: Array<{ id: string; capacity: number; inFlight: number }>;
    };
    expect(result.runners).toHaveLength(2);
    expect(result.runners[0]?.capacity).toBe(1);
    expect(result.runners[0]?.inFlight).toBe(1);
    expect(result.runners[1]?.capacity).toBe(1);
    expect(result.runners[1]?.inFlight).toBe(0);
  });
});
