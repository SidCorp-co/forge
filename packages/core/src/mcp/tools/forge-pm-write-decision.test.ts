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
chain.values = () => chain;
chain.returning = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) =>
  Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
  },
}));

const indexMemorySpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../memory/indexer.js', () => ({
  indexMemory: indexMemorySpy,
}));

const { forgePmWriteDecisionTool } = await import('./forge-pm-write-decision.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const DECISION_ID = '22222222-2222-4222-8222-222222222222';
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

function pushPmActorOk() {
  queue.push([{ ownerId: OWNER_ID }]);
  queue.push([{ capabilities: { pm: true } }]);
}

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
});

describe('forge_pm.write_decision', () => {
  it('rejects unknown cause', async () => {
    const tool = forgePmWriteDecisionTool(fakeDevice);
    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        cause: 'mystery',
        summary: 'x',
      }),
    ).rejects.toThrow();
  });

  it('inserts decision + queues memory indexer', async () => {
    const tool = forgePmWriteDecisionTool(fakeDevice);
    pushPmActorOk();
    queue.push([{ id: DECISION_ID }]); // decision insert

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      cause: 'job-failed',
      summary: 'Recovered failed code job by re-running',
      actions: [{ kind: 'dispatch', jobId: 'j1' }],
    })) as { decisionId: string; indexed: 'queued' };

    expect(result.decisionId).toBe(DECISION_ID);
    expect(result.indexed).toBe('queued');

    // queueMicrotask schedules; flush microtasks
    await new Promise<void>((r) => queueMicrotask(() => r()));

    expect(indexMemorySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        source: 'decision',
        sourceRef: DECISION_ID,
      }),
    );
  });

  it('rejects non-pm-actor', async () => {
    const tool = forgePmWriteDecisionTool(fakeDevice);
    queue.push([{ ownerId: OWNER_ID }]);
    queue.push([{ capabilities: {} }]); // pm flag missing
    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        cause: 'tick',
        summary: 'tick',
      }),
    ).rejects.toThrow(/capabilities\.pm/);
  });
});
