import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    UPLOADS_MAX_BYTES: 10 * 1024 * 1024,
  },
}));

const storagePut = vi.fn(async (key: string, _bytes: Buffer, _mime: string) => ({
  path: `local:${key}`,
  size: _bytes.byteLength,
}));
vi.mock('../../storage/index.js', () => ({
  getStorage: () => ({
    put: storagePut,
    get: vi.fn(),
    delete: vi.fn(),
  }),
  isEnoent: () => false,
}));

const selectLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
// lib/authz.ts effectiveProjectRole chains TWO leftJoins before where().limit(1).
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  innerJoin: selectInnerJoin,
  leftJoin: selectLeftJoin,
}));
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

// Keep the real create-path helper (persistCommentAttachment) but stub the
// read-side join so `list` doesn't need a programmed query chain for it.
const listCommentAttachmentsForIssueMock = vi.fn(
  async (..._args: unknown[]) => new Map<string, unknown[]>(),
);
vi.mock('../../comments/attachment-service.js', async (importActual) => {
  const actual = await importActual<typeof import('../../comments/attachment-service.js')>();
  return {
    ...actual,
    listCommentAttachmentsForIssue: (...args: unknown[]) =>
      listCommentAttachmentsForIssueMock(...args),
  };
});

const { forgeCommentsTool } = await import('./forge-comments.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const COMMENT_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER_ID = '66666666-6666-4666-8666-666666666666';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '88888888-8888-4888-8888-888888888888';

// effectiveProjectRole (lib/authz.ts) result rows — ONE org-aware select.
const memberAccessRow = { orgId: ORG_ID, memberRole: 'member', orgRole: null };
const adminAccessRow = { orgId: ORG_ID, memberRole: 'admin', orgRole: null };

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
    const tool = forgeCommentsTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    await expect(
      tool.handler({ action: 'edit' } as unknown as Record<string, unknown>),
    ).rejects.toThrow();
  });

  it('list requires filters.issue', async () => {
    const tool = forgeCommentsTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    await expect(tool.handler({ action: 'list' })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('list returns comments when device owner is member', async () => {
    const tool = forgeCommentsTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    // 1. loadIssueProjectId
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    // 2. assertDeviceOwnerIsMember → project owned by device owner
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // 3. comment list query
    selectLimit.mockResolvedValueOnce([baseCommentRow]);

    const result = (await tool.handler({
      action: 'list',
      filters: { issue: ISSUE_ID },
    })) as { comments: Array<{ documentId: string; body: string }> };

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.documentId).toBe(COMMENT_ID);
    // ISS-532: comment body is framed as untrusted DATA on the agent-facing
    // MCP surface — the original text is preserved inside the frame.
    expect(result.comments[0]?.body).toContain('Hello');
    expect(result.comments[0]?.body).toContain('UNTRUSTED_DATA source="comment.body"');
    // Default empty attachment join → attachments present as []
    expect((result.comments[0] as unknown as { attachments: unknown[] }).attachments).toEqual([]);
  });

  it('list attaches each comment its attachments[] from the join', async () => {
    const tool = forgeCommentsTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    selectLimit.mockResolvedValueOnce([baseCommentRow]);
    const att = {
      id: 'att-1',
      name: 'shot.png',
      mime: 'image/png',
      size: 123,
      url: '/api/comments/attachments/att-1',
      createdAt: new Date(),
    };
    listCommentAttachmentsForIssueMock.mockResolvedValueOnce(new Map([[COMMENT_ID, [att]]]));

    const result = (await tool.handler({
      action: 'list',
      filters: { issue: ISSUE_ID },
    })) as { comments: Array<{ attachments: Array<{ id: string; url: string }> }> };

    expect(result.comments[0]?.attachments).toHaveLength(1);
    expect(result.comments[0]?.attachments[0]?.id).toBe('att-1');
    expect(result.comments[0]?.attachments[0]?.url).toBe('/api/comments/attachments/att-1');
  });

  it('list returns truncated:true and keeps newest when response exceeds 38K chars (ISS-562)', async () => {
    const tool = forgeCommentsTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // 50 fat comments (~9KB bodies each) → ~450KB raw, far exceeds 38K cap
    const fatRows = Array.from({ length: 50 }, (_, i) => ({
      ...baseCommentRow,
      id: `5555555${i}-5555-4555-8555-555555555555`.slice(0, 36),
      body: 'x'.repeat(9_000),
      createdAt: new Date(Date.now() + i * 1000),
    }));
    selectLimit.mockResolvedValueOnce(fatRows);

    const result = (await tool.handler({
      action: 'list',
      filters: { issue: ISSUE_ID },
    })) as {
      comments: unknown[];
      truncated: boolean;
      returned: number;
      requested: number;
      notice: string;
    };

    expect(result.truncated).toBe(true);
    expect(result.returned).toBeLessThan(50);
    expect(result.requested).toBe(50);
    expect(result.notice).toMatch(/truncated/i);
    // Total serialized response must stay under a safe threshold
    expect(JSON.stringify(result).length).toBeLessThan(50_000);
  });

  it('list throws NOT_FOUND when issue is missing', async () => {
    const tool = forgeCommentsTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    selectLimit.mockResolvedValueOnce([]); // no issue
    await expect(tool.handler({ action: 'list', filters: { issue: ISSUE_ID } })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });

  it('create requires data.issue + data.body', async () => {
    const tool = forgeCommentsTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    await expect(tool.handler({ action: 'create', data: { body: 'hi' } })).rejects.toThrow(
      /BAD_REQUEST/,
    );
    await expect(tool.handler({ action: 'create', data: { issue: ISSUE_ID } })).rejects.toThrow(
      /BAD_REQUEST/,
    );
  });

  it('create attributes authorId to device.ownerId and emits commentCreated hook', async () => {
    const tool = forgeCommentsTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]); // loadIssueProjectId
    selectLimit.mockResolvedValueOnce([memberAccessRow]); // membership
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
    const tool = forgeCommentsTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    // loadCommentForAccess (joins comments + issues)
    selectLimit.mockResolvedValueOnce([
      { id: COMMENT_ID, issueId: ISSUE_ID, authorId: OWNER_ID, projectId: PROJECT_ID },
    ]);
    // membership check (author path uses assertDeviceOwnerIsMember)
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    deleteWhere.mockResolvedValueOnce(undefined);

    const result = (await tool.handler({
      action: 'delete',
      documentId: COMMENT_ID,
    })) as { status: string };

    expect(result.status).toBe('deleted');
    expect(deleteWhere).toHaveBeenCalled();
  });

  it('delete by non-author non-admin throws FORBIDDEN', async () => {
    const tool = forgeCommentsTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    selectLimit.mockResolvedValueOnce([
      { id: COMMENT_ID, issueId: ISSUE_ID, authorId: OTHER_USER_ID, projectId: PROJECT_ID },
    ]);
    // assertPrincipalIsMember (device path) → effective-role lookup
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // assertCommentDeletePermission: effective role is member, below admin
    selectLimit.mockResolvedValueOnce([memberAccessRow]);

    await expect(tool.handler({ action: 'delete', documentId: COMMENT_ID })).rejects.toThrow(
      /FORBIDDEN: only the comment author or a project admin can delete/,
    );
  });

  it('delete by non-author project admin succeeds', async () => {
    const tool = forgeCommentsTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    selectLimit.mockResolvedValueOnce([
      { id: COMMENT_ID, issueId: ISSUE_ID, authorId: OTHER_USER_ID, projectId: PROJECT_ID },
    ]);
    // assertPrincipalIsMember (device path) → effective-role lookup
    selectLimit.mockResolvedValueOnce([adminAccessRow]);
    // assertCommentDeletePermission: effective project admin passes
    selectLimit.mockResolvedValueOnce([adminAccessRow]);
    deleteWhere.mockResolvedValueOnce(undefined);

    const result = (await tool.handler({
      action: 'delete',
      documentId: COMMENT_ID,
    })) as { status: string };

    expect(result.status).toBe('deleted');
    expect(deleteWhere).toHaveBeenCalled();
  });

  // ISS-150 cross-tenant regression — the documentId-resolved delete path
  // must enforce the PAT projectIds allowlist before the project-role check.
  // Without the allowlist check, a PAT scoped to project A used by a user
  // who is the owner of project B could destroy comments in project B.
  describe('PAT projectIds allowlist (cross-tenant) — delete', () => {
    const ALLOWED_PROJECT = '77777777-7777-4777-8777-777777777777';

    function makePatTool(projectIds: string[] | null) {
      return forgeCommentsTool({
        principal: {
          kind: 'pat',
          userId: OWNER_ID,
          tokenId: '55555555-5555-4555-8555-555555555555',
          scopes: ['read', 'write'],
          projectIds,
          boundProjectId: null,
        },
        device: fakeDevice,
        projectSlug: null,
      });
    }

    it("delete returns NOT_FOUND when comment's project is outside PAT allowlist (even when PAT user owns the project)", async () => {
      const tool = makePatTool([ALLOWED_PROJECT]);
      // loadCommentForAccess — comment lives in PROJECT_ID (outside the allowlist),
      // authored by a different user so the non-author branch would normally apply.
      selectLimit.mockResolvedValueOnce([
        { id: COMMENT_ID, issueId: ISSUE_ID, authorId: OTHER_USER_ID, projectId: PROJECT_ID },
      ]);
      // No further DB calls should be made: assertPrincipalIsMember rejects on
      // the allowlist miss before any role lookup.
      await expect(tool.handler({ action: 'delete', documentId: COMMENT_ID })).rejects.toThrow(
        /NOT_FOUND/,
      );
      expect(deleteWhere).not.toHaveBeenCalled();
    });

    it("delete succeeds when comment's project is inside the PAT allowlist and user is project admin", async () => {
      const tool = makePatTool([PROJECT_ID]);
      // loadCommentForAccess — non-author branch.
      selectLimit.mockResolvedValueOnce([
        { id: COMMENT_ID, issueId: ISSUE_ID, authorId: OTHER_USER_ID, projectId: PROJECT_ID },
      ]);
      // assertPrincipalIsMember (PAT path) → effective-role lookup
      selectLimit.mockResolvedValueOnce([adminAccessRow]);
      // assertCommentDeletePermission still runs: effective project admin passes.
      selectLimit.mockResolvedValueOnce([adminAccessRow]);
      deleteWhere.mockResolvedValueOnce(undefined);

      const result = (await tool.handler({
        action: 'delete',
        documentId: COMMENT_ID,
      })) as { status: string };

      expect(result.status).toBe('deleted');
      expect(deleteWhere).toHaveBeenCalled();
    });
  });

  describe('create with attachments', () => {
    // Each persistCommentAttachment() does 1 insert (attachment row). The
    // create handler does 1 insert for the comment first.
    // We pre-load insertReturning per call.

    function makeAttachmentRow(index: number) {
      return {
        id: `aaaa${index}aaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
        commentId: COMMENT_ID,
        name: `screenshot-${index}.png`,
        mime: 'image/png',
        size: 4,
        createdAt: new Date(),
      };
    }

    // 1x1 transparent PNG-ish bytes (not real PNG, but bytes are fine)
    const TINY_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const TINY_B64 = TINY_BYTES.toString('base64');

    it('persists a single attachment and returns its url', async () => {
      const tool = forgeCommentsTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: null,
      });
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]); // loadIssueProjectId
      selectLimit.mockResolvedValueOnce([memberAccessRow]); // membership
      insertReturning.mockResolvedValueOnce([baseCommentRow]); // comment insert
      insertReturning.mockResolvedValueOnce([makeAttachmentRow(0)]); // attachment insert

      const result = (await tool.handler({
        action: 'create',
        data: {
          issue: ISSUE_ID,
          body: 'with screenshot',
          attachments: [{ name: 'screenshot-0.png', mime: 'image/png', dataBase64: TINY_B64 }],
        },
      })) as {
        documentId: string;
        attachments: Array<{ id: string; url: string; mime: string; size: number }>;
        attachmentErrors?: unknown;
      };

      expect(result.documentId).toBe(COMMENT_ID);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.url).toMatch(/^\/api\/comments\/attachments\//);
      expect(result.attachmentErrors).toBeUndefined();
      // Storage key uses `comments/<commentId>/<ts>-<safeName>` (AC #5).
      expect(storagePut).toHaveBeenCalledTimes(1);
      const putKey = storagePut.mock.calls[0]?.[0] ?? '';
      expect(putKey).toMatch(new RegExp(`^comments/${COMMENT_ID}/\\d+-screenshot-0\\.png$`));
    });

    it('persists 5 attachments in one call', async () => {
      const tool = forgeCommentsTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: null,
      });
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      insertReturning.mockResolvedValueOnce([baseCommentRow]);
      for (let i = 0; i < 5; i++) insertReturning.mockResolvedValueOnce([makeAttachmentRow(i)]);

      const result = (await tool.handler({
        action: 'create',
        data: {
          issue: ISSUE_ID,
          body: 'five screenshots',
          attachments: Array.from({ length: 5 }, (_, i) => ({
            name: `screenshot-${i}.png`,
            mime: 'image/png',
            dataBase64: TINY_B64,
          })),
        },
      })) as { attachments: unknown[] };

      expect(result.attachments).toHaveLength(5);
      expect(storagePut).toHaveBeenCalledTimes(5);
    });

    it('records uploaderDeviceId on the attachment insert', async () => {
      const tool = forgeCommentsTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: null,
      });
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      insertReturning.mockResolvedValueOnce([baseCommentRow]);
      insertReturning.mockResolvedValueOnce([makeAttachmentRow(0)]);

      await tool.handler({
        action: 'create',
        data: {
          issue: ISSUE_ID,
          body: 'audit',
          attachments: [{ name: 'a.png', mime: 'image/png', dataBase64: TINY_B64 }],
        },
      });

      // First insertValues call is for the comment row, second is the attachment.
      expect(insertValues).toHaveBeenCalledTimes(2);
      expect(insertValues).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          commentId: COMMENT_ID,
          uploaderId: OWNER_ID,
          uploaderDeviceId: DEVICE_ID,
          mime: 'image/png',
        }),
      );
    });

    it('rejects PAYLOAD_TOO_LARGE when total exceeds UPLOADS_MAX_BYTES', async () => {
      const tool = forgeCommentsTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: null,
      });
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);

      // 4MB each x 3 = 12MB > 10MB limit, no single entry over limit.
      const fourMb = Buffer.alloc(4 * 1024 * 1024, 7);
      const b64 = fourMb.toString('base64');

      await expect(
        tool.handler({
          action: 'create',
          data: {
            issue: ISSUE_ID,
            body: 'too big',
            attachments: [
              { name: 'a.png', mime: 'image/png', dataBase64: b64 },
              { name: 'b.png', mime: 'image/png', dataBase64: b64 },
              { name: 'c.png', mime: 'image/png', dataBase64: b64 },
            ],
          },
        }),
      ).rejects.toThrow(/PAYLOAD_TOO_LARGE: total=\d+ per=\[0:\d+,1:\d+,2:\d+\] limit=\d+/);
      // Comment was NOT inserted.
      expect(insertReturning).not.toHaveBeenCalled();
    });

    it('rejects PAYLOAD_TOO_LARGE when a single entry exceeds the cap', async () => {
      const tool = forgeCommentsTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: null,
      });
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);

      const elevenMb = Buffer.alloc(11 * 1024 * 1024, 7);
      const b64 = elevenMb.toString('base64');

      await expect(
        tool.handler({
          action: 'create',
          data: {
            issue: ISSUE_ID,
            body: 'too big',
            attachments: [{ name: 'a.png', mime: 'image/png', dataBase64: b64 }],
          },
        }),
      ).rejects.toThrow(/PAYLOAD_TOO_LARGE/);
    });

    it('returns MIME_NOT_ALLOWED in attachmentErrors and keeps the comment', async () => {
      const tool = forgeCommentsTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: null,
      });
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      insertReturning.mockResolvedValueOnce([baseCommentRow]);

      const result = (await tool.handler({
        action: 'create',
        data: {
          issue: ISSUE_ID,
          body: 'bad mime',
          attachments: [
            { name: 'bad.exe', mime: 'application/x-msdownload', dataBase64: TINY_B64 },
          ],
        },
      })) as {
        documentId: string;
        attachments: unknown[];
        attachmentErrors: Array<{ code: string; index: number }>;
      };

      expect(result.documentId).toBe(COMMENT_ID);
      expect(result.attachments).toEqual([]);
      expect(result.attachmentErrors).toHaveLength(1);
      expect(result.attachmentErrors[0]?.code).toBe('MIME_NOT_ALLOWED');
    });

    it('rejects invalid base64 with BAD_REQUEST before inserting the comment', async () => {
      const tool = forgeCommentsTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: null,
      });
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);

      await expect(
        tool.handler({
          action: 'create',
          data: {
            issue: ISSUE_ID,
            body: 'bad b64',
            attachments: [{ name: 'a.png', mime: 'image/png', dataBase64: 'not!base64!!' }],
          },
        }),
      ).rejects.toThrow(/BAD_REQUEST: data\.attachments\[0\]\.dataBase64 is not valid base64/);
      expect(insertReturning).not.toHaveBeenCalled();
    });
  });
});
