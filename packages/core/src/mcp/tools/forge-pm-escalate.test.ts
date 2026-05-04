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

const hooksEmitSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../pipeline/hooks.js', () => ({
  hooks: { emit: hooksEmitSpy },
}));

const { forgePmEscalateTool } = await import('./forge-pm-escalate.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const DECISION_ID = '22222222-2222-4222-8222-222222222222';
const NOTIFICATION_ID = '33333333-3333-4333-8333-333333333333';
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

const validInput = {
  projectId: PROJECT_ID,
  decisionId: DECISION_ID,
  severity: 'high' as const,
  summary: 'Need decision',
  question: 'Approve plan?',
  options: [
    { id: 'a', label: 'Approve' },
    { id: 'b', label: 'Reject' },
  ],
  expiresAt: '2026-06-01T00:00:00.000Z',
};

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
});

describe('forge_pm.escalate', () => {
  it('rejects when decision not found in project', async () => {
    const tool = forgePmEscalateTool(fakeDevice);
    pushPmActorOk();
    queue.push([]); // decision lookup
    await expect(tool.handler(validInput)).rejects.toThrow(/NOT_FOUND/);
  });

  it('happy path inserts notification + emits hook', async () => {
    const tool = forgePmEscalateTool(fakeDevice);
    pushPmActorOk();
    queue.push([{ id: DECISION_ID, projectId: PROJECT_ID }]); // decision
    queue.push([{ ownerId: OWNER_ID }]); // project
    queue.push([{ id: NOTIFICATION_ID }]); // notification insert

    const result = (await tool.handler(validInput)) as {
      notificationId: string;
      expiresAt: string;
    };

    expect(result.notificationId).toBe(NOTIFICATION_ID);
    expect(result.expiresAt).toBe(validInput.expiresAt);
    expect(hooksEmitSpy).toHaveBeenCalledWith(
      'notificationCreated',
      expect.objectContaining({
        notificationId: NOTIFICATION_ID,
        type: 'pm_escalation',
        userId: OWNER_ID,
      }),
    );
  });

  it('rejects validation: empty options', async () => {
    const tool = forgePmEscalateTool(fakeDevice);
    await expect(tool.handler({ ...validInput, options: [] })).rejects.toThrow();
  });
});
