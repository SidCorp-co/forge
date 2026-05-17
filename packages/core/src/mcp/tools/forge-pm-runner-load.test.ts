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
chain.where = () => chain;
chain.orderBy = () => chain;
chain.limit = () => chain;
chain.groupBy = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) =>
  Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => chain) },
}));

const { forgePmRunnerLoadTool } = await import('./forge-pm-runner-load.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'fake0001',
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
    queue.push([{ ownerId: 'other' }], []);
    await expect(tool.handler({ projectId: PROJECT_ID })).rejects.toThrow(/FORBIDDEN/);
  });

  it('returns runner list with capacity + inFlight', async () => {
    const tool = forgePmRunnerLoadTool(ctx);
    queue.push(
      [{ ownerId: OWNER_ID }], // assert
      [
        // runner rows
        {
          id: 'r1',
          type: 'claude-code',
          host: 'device',
          status: 'online',
          lastSeenAt: new Date('2026-05-01T00:00:00Z'),
          capabilities: { maxConcurrent: 3 },
        },
        {
          id: 'r2',
          type: 'antigravity',
          host: 'remote',
          status: 'offline',
          lastSeenAt: null,
          capabilities: null,
        },
      ],
      [{ n: 1 }], // r1 inFlight
      [{ n: 0 }], // r2 inFlight
    );

    const result = (await tool.handler({ projectId: PROJECT_ID })) as {
      runners: Array<{ id: string; capacity: number | null; inFlight: number }>;
    };
    expect(result.runners).toHaveLength(2);
    expect(result.runners[0]?.capacity).toBe(3);
    expect(result.runners[0]?.inFlight).toBe(1);
    expect(result.runners[1]?.capacity).toBeNull();
    expect(result.runners[1]?.inFlight).toBe(0);
  });
});
