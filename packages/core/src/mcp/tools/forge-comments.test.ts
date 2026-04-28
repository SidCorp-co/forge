import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, innerJoin: selectInnerJoin }));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const deleteWhere = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    delete: vi.fn(() => ({ where: deleteWhere })),
  },
}));

vi.mock('../../pipeline/hooks.js', () => ({
  hooks: { emit: vi.fn().mockResolvedValue(undefined) },
}));

const { forgeCommentsTool } = await import('./forge-comments.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const COMMENT_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER_ID = '66666666-6666-4666-8666-666666666666';
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

const baseCommentRow = {
  id: COMMENT_ID,
  issueId: ISSUE_ID,
  authorId: OWNER_ID,
  body: 'Hello',
  parentId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('forge_comments tool', () => {
  it('rejects unknown action', async () => {
    const tool = forgeCommentsTool({ device: fakeDevice, projectSlug: null });
    await expect(
      tool.handler({ action: 'edit' } as unknown as Record<string, unknown>),
    ).rejects.toThrow();
  });

  it('list requires filters.issue', async () => {
    const tool = forgeCommentsTool({ device: fakeDevice, projectSlug: null });
    await expect(tool.handler({ action: 'list' })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('list returns comments when device owner is member', async () => {
    const tool = forgeCommentsTool({ device: fakeDevice, projectSlug: null });
    // 1. loadIssueProjectId
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    // 2. assertDeviceOwnerIsMember → project owned by device owner
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // 3. comment list query
    selectLimit.mockResolvedValueOnce([baseCommentRow]);

    const result = (await tool.handler({
      action: 'list',
      filters: { issue: ISSUE_ID },
    })) as { comments: Array<{ documentId: string; body: string }> };

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.documentId).toBe(COMMENT_ID);
    expect(result.comments[0]?.body).toBe('Hello');
  });

  it('list throws NOT_FOUND when issue is missing', async () => {
    const tool = forgeCommentsTool({ device: fakeDevice, projectSlug: null });
    selectLimit.mockResolvedValueOnce([]); // no issue
    await expect(
      tool.handler({ action: 'list', filters: { issue: ISSUE_ID } }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  it('create requires data.issue + data.body', async () => {
    const tool = forgeCommentsTool({ device: fakeDevice, projectSlug: null });
    await expect(tool.handler({ action: 'create', data: { body: 'hi' } })).rejects.toThrow(
      /BAD_REQUEST/,
    );
    await expect(tool.handler({ action: 'create', data: { issue: ISSUE_ID } })).rejects.toThrow(
      /BAD_REQUEST/,
    );
  });

  it('create attributes authorId to device.ownerId and emits commentCreated hook', async () => {
    const tool = forgeCommentsTool({ device: fakeDevice, projectSlug: null });
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]); // loadIssueProjectId
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]); // membership
    insertReturning.mockResolvedValueOnce([baseCommentRow]); // insert

    const result = (await tool.handler({
      action: 'create',
      data: { issue: ISSUE_ID, body: 'Hello' },
    })) as { documentId: string; authorId: string };

    expect(result.documentId).toBe(COMMENT_ID);
    expect(result.authorId).toBe(OWNER_ID);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: ISSUE_ID, authorId: OWNER_ID, body: 'Hello' }),
    );
  });

  it('delete by author succeeds', async () => {
    const tool = forgeCommentsTool({ device: fakeDevice, projectSlug: null });
    // loadCommentForAccess (joins comments + issues)
    selectLimit.mockResolvedValueOnce([
      { id: COMMENT_ID, issueId: ISSUE_ID, authorId: OWNER_ID, projectId: PROJECT_ID },
    ]);
    // membership check (author path uses assertDeviceOwnerIsMember)
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    deleteWhere.mockResolvedValueOnce(undefined);

    const result = (await tool.handler({
      action: 'delete',
      documentId: COMMENT_ID,
    })) as { status: string };

    expect(result.status).toBe('deleted');
    expect(deleteWhere).toHaveBeenCalled();
  });

  it('delete by non-author non-owner throws FORBIDDEN', async () => {
    const tool = forgeCommentsTool({ device: fakeDevice, projectSlug: null });
    selectLimit.mockResolvedValueOnce([
      { id: COMMENT_ID, issueId: ISSUE_ID, authorId: OTHER_USER_ID, projectId: PROJECT_ID },
    ]);
    // assertCommentDeletePermission: project owned by someone else
    selectLimit.mockResolvedValueOnce([{ ownerId: 'somebody-else' }]);
    // membership row exists but role is 'member' (not owner)
    selectLimit.mockResolvedValueOnce([{ role: 'member' }]);

    await expect(
      tool.handler({ action: 'delete', documentId: COMMENT_ID }),
    ).rejects.toThrow(/FORBIDDEN/);
  });
});
