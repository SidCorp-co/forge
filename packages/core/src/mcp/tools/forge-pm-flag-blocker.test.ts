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
chain.set = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) =>
  Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
  },
}));

const applyStatusTransitionSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../issues/apply-transition.js', () => ({
  applyStatusTransition: applyStatusTransitionSpy,
}));

const hooksEmitSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../pipeline/hooks.js', () => ({
  hooks: { emit: hooksEmitSpy },
}));

const { forgePmFlagBlockerTool } = await import('./forge-pm-flag-blocker.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const COMMENT_ID = '33333333-3333-4333-8333-333333333333';
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
  applyStatusTransitionSpy.mockResolvedValue(undefined);
});

describe('forge_pm.flag_blocker', () => {
  it('low severity: posts comment, does NOT transition', async () => {
    const tool = forgePmFlagBlockerTool(fakeDevice);
    pushPmActorOk();
    queue.push([{ id: ISSUE_ID, projectId: PROJECT_ID, status: 'in_progress', reopenCount: 0 }]);
    queue.push([{ id: COMMENT_ID, issueId: ISSUE_ID, body: '...', parentId: null }]);

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      severity: 'low',
      reason: 'flaky test',
    })) as { commentId: string; transitioned: boolean };

    expect(result.commentId).toBe(COMMENT_ID);
    expect(result.transitioned).toBe(false);
    expect(applyStatusTransitionSpy).not.toHaveBeenCalled();
    expect(hooksEmitSpy).toHaveBeenCalledWith(
      'commentCreated',
      expect.objectContaining({ commentId: COMMENT_ID }),
    );
  });

  it('high severity: posts comment AND transitions to on_hold', async () => {
    const tool = forgePmFlagBlockerTool(fakeDevice);
    pushPmActorOk();
    queue.push([{ id: ISSUE_ID, projectId: PROJECT_ID, status: 'in_progress', reopenCount: 0 }]);
    queue.push([{ id: COMMENT_ID, issueId: ISSUE_ID, body: '...', parentId: null }]);

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      severity: 'high',
      reason: 'data loss risk',
    })) as { commentId: string; transitioned: boolean };

    expect(result.transitioned).toBe(true);
    expect(applyStatusTransitionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: ISSUE_ID }),
      'on_hold',
      fakeDevice,
    );
  });

  it('high severity on already-on_hold issue is idempotent', async () => {
    const tool = forgePmFlagBlockerTool(fakeDevice);
    pushPmActorOk();
    queue.push([{ id: ISSUE_ID, projectId: PROJECT_ID, status: 'on_hold', reopenCount: 0 }]);
    queue.push([{ id: COMMENT_ID, issueId: ISSUE_ID, body: '...', parentId: null }]);

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      severity: 'high',
      reason: 'still blocked',
    })) as { commentId: string; transitioned: boolean };

    expect(result.transitioned).toBe(false);
    expect(applyStatusTransitionSpy).not.toHaveBeenCalled();
  });

  it('high severity on closed issue: transitioned=false with blockedReason', async () => {
    const tool = forgePmFlagBlockerTool(fakeDevice);
    pushPmActorOk();
    queue.push([{ id: ISSUE_ID, projectId: PROJECT_ID, status: 'closed', reopenCount: 0 }]);
    queue.push([{ id: COMMENT_ID, issueId: ISSUE_ID, body: '...', parentId: null }]);

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      severity: 'high',
      reason: 'oops',
    })) as { transitioned: boolean; blockedReason?: string };

    expect(result.transitioned).toBe(false);
    expect(result.blockedReason).toBe('cannot_hold_closed_issue');
    expect(applyStatusTransitionSpy).not.toHaveBeenCalled();
  });
});
