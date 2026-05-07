import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

// Drizzle query-builder mock — each chain step returns the next mock so we
// can program per-call return values via `mockResolvedValueOnce` and assert
// on the call arguments. Mirrors the pattern used in tasks/routes.test.ts.
const selectLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));

const txUpdateWhere = vi.fn(async () => undefined);
const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
const txUpdate = vi.fn(() => ({ set: txUpdateSet }));
const txInsertValues = vi.fn(async () => undefined);
const txInsert = vi.fn(() => ({ values: txInsertValues }));
const txProxy = { update: txUpdate, insert: txInsert };
const transactionMock = vi.fn(async (cb: (tx: typeof txProxy) => Promise<unknown>) => cb(txProxy));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    transaction: (cb: (tx: typeof txProxy) => Promise<unknown>) => transactionMock(cb),
  },
}));

vi.mock('../../pipeline/hooks.js', () => ({
  hooks: { emit: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../ws/server.js', () => ({
  roomManager: { publish: vi.fn() },
}));

const { forgeIssuesTool } = await import('./forge-issues.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_SLUG = 'forge-dev';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

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

const baseIssueRow = {
  id: ISSUE_ID,
  projectId: PROJECT_ID,
  issSeq: 1,
  title: 'Test issue',
  description: null,
  status: 'open' as const,
  priority: 'medium' as const,
  category: null,
  assigneeId: null,
  createdById: OWNER_ID,
  parentIssueId: null,
  reopenCount: 0,
  source: 'manual' as const,
  externalId: null,
  plan: null,
  acceptanceCriteria: null,
  suggestedSolution: null,
  sessionContext: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('forge_issues tool', () => {
  it('rejects unknown action', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: PROJECT_SLUG });
    await expect(tool.handler({ action: 'wat' } as unknown as Record<string, unknown>)).rejects.toThrow();
  });

  it('list resolves projectId from slug header and enforces membership', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: PROJECT_SLUG });
    // 1. resolveProjectIdFromSlug → projects.id
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    // 2. assertDeviceOwnerIsMember → projects.ownerId (matches device.ownerId)
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // 3. issue list query
    selectLimit.mockResolvedValueOnce([baseIssueRow]);

    const result = (await tool.handler({ action: 'list' })) as {
      issues: Array<{ documentId: string }>;
    };
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.documentId).toBe(ISSUE_ID);
  });

  it('list throws BAD_REQUEST when no slug and no projectId', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: null });
    await expect(tool.handler({ action: 'list' })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('list throws NOT_FOUND when slug resolves to no project', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: 'unknown' });
    selectLimit.mockResolvedValueOnce([]); // no project for slug
    await expect(tool.handler({ action: 'list' })).rejects.toThrow(/NOT_FOUND/);
  });

  it('get throws BAD_REQUEST without documentId', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: PROJECT_SLUG });
    await expect(tool.handler({ action: 'get' })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('get returns serialized issue when device owner is member', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: PROJECT_SLUG });
    // 1. loadIssue → issues row
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // 2. assertDeviceOwnerIsMember → project owner row (owned by device.ownerId)
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);

    const result = (await tool.handler({ action: 'get', documentId: ISSUE_ID })) as {
      documentId: string;
      issueId: string;
      status: string;
    };
    expect(result.documentId).toBe(ISSUE_ID);
    expect(result.issueId).toBe('ISS-1');
    expect(result.status).toBe('open');
  });

  it('get throws FORBIDDEN when device owner is not a project member', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: PROJECT_SLUG });
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // project owned by someone else
    selectLimit.mockResolvedValueOnce([{ ownerId: 'someone-else' }]);
    // no project member row
    selectLimit.mockResolvedValueOnce([]);

    await expect(tool.handler({ action: 'get', documentId: ISSUE_ID })).rejects.toThrow(/FORBIDDEN/);
  });

  it('create requires data.title', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: PROJECT_SLUG });
    await expect(tool.handler({ action: 'create', data: {} })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('create persists plan + acceptanceCriteria on the new row', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: PROJECT_SLUG });
    // resolve slug → project
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    // membership check
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // insert returns row
    insertReturning.mockResolvedValueOnce([
      { ...baseIssueRow, plan: 'p1', acceptanceCriteria: 'ac1' },
    ]);

    const result = (await tool.handler({
      action: 'create',
      data: { title: 'New', plan: 'p1', acceptanceCriteria: 'ac1' },
    })) as { plan: string | null; acceptanceCriteria: string | null };

    expect(result.plan).toBe('p1');
    expect(result.acceptanceCriteria).toBe('ac1');
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New', plan: 'p1', acceptanceCriteria: 'ac1' }),
    );
  });

  it('update writes plan and bumps updatedAt', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: PROJECT_SLUG });
    // loadIssue
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // membership check
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // re-load fresh after update
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, plan: 'new plan' }]);

    const result = (await tool.handler({
      action: 'update',
      documentId: ISSUE_ID,
      data: { plan: 'new plan' },
    })) as { plan: string | null; status: string };

    expect(result.plan).toBe('new plan');
    expect(txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'new plan', updatedAt: expect.anything() }),
    );
  });

  it('update with manualHold journals an activity entry and emits issueUpdated', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: PROJECT_SLUG });
    // loadIssue (manualHold currently false)
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, manualHold: false }]);
    // membership check
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // re-load fresh after update
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, manualHold: true }]);

    const { hooks } = await import('../../pipeline/hooks.js');

    await tool.handler({
      action: 'update',
      documentId: ISSUE_ID,
      data: { manualHold: true },
    });

    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'issue.manualHold.set' }),
    );
    expect(hooks.emit).toHaveBeenCalledWith(
      'issueUpdated',
      expect.objectContaining({
        issueId: ISSUE_ID,
        fields: ['manualHold'],
        before: { manualHold: false },
        after: { manualHold: true },
      }),
    );
  });

  it('update with manualHold no-op (value matches) skips activity + hook', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: PROJECT_SLUG });
    // loadIssue (manualHold already true)
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, manualHold: true }]);
    // membership check
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // re-load fresh
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, manualHold: true }]);

    const { hooks } = await import('../../pipeline/hooks.js');

    await tool.handler({
      action: 'update',
      documentId: ISSUE_ID,
      data: { manualHold: true },
    });

    expect(txInsertValues).not.toHaveBeenCalled();
    expect(hooks.emit).not.toHaveBeenCalledWith(
      'issueUpdated',
      expect.objectContaining({ fields: ['manualHold'] }),
    );
  });

  it('update with status routes through state machine and rejects illegal transition', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: PROJECT_SLUG });
    // loadIssue (status=open)
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // membership check
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);

    // open → released is illegal
    await expect(
      tool.handler({
        action: 'update',
        documentId: ISSUE_ID,
        data: { status: 'released' },
      }),
    ).rejects.toThrow(/ILLEGAL_TRANSITION/);
  });

  it('transition open→confirmed updates status and emits hook', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: PROJECT_SLUG });
    // loadIssue (open)
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // membership
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // conditional UPDATE returning the new row
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, reopenCount: 0, updatedAt: new Date() },
    ]);
    // re-load fresh
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, status: 'confirmed' }]);

    const result = (await tool.handler({
      action: 'transition',
      documentId: ISSUE_ID,
      data: { status: 'confirmed' },
    })) as { status: string };

    expect(result.status).toBe('confirmed');
  });

  it('transition surfaces STALE_TRANSITION when conditional update returns no row', async () => {
    const tool = forgeIssuesTool({ device: fakeDevice, projectSlug: PROJECT_SLUG });
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    updateReturning.mockResolvedValueOnce([]);

    await expect(
      tool.handler({
        action: 'transition',
        documentId: ISSUE_ID,
        data: { status: 'confirmed' },
      }),
    ).rejects.toThrow(/STALE_TRANSITION/);
  });
});
