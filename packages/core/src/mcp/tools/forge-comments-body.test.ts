import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The MCP half of ISS-898's body gate: `format` reaching the write door, a
 * refusal keeping its named message on the way back out, and `slots`/`text`
 * reaching a downstream reader so it can read a field instead of matching a
 * string prefix.
 *
 * Its own file rather than more of `forge-comments.test.ts`, which is frozen at
 * its current size — and its mock surface is narrower: only the two selects the
 * authz path needs, plus insert and update.
 */

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    UPLOADS_MAX_BYTES: 10 * 1024 * 1024,
  },
}));

const selectLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  innerJoin: selectInnerJoin,
  leftJoin: selectLeftJoin,
}));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: vi.fn() })),
  },
}));

vi.mock('../../pipeline/hooks.js', () => ({
  hooks: { emit: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../comments/attachment-service.js', async (importActual) => {
  const actual = await importActual<typeof import('../../comments/attachment-service.js')>();
  return { ...actual, listCommentAttachmentsForIssue: async () => new Map() };
});

const { forgeCommentsTool } = await import('./forge-comments.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const COMMENT_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '88888888-8888-4888-8888-888888888888';

const memberAccessRow = { orgId: ORG_ID, memberRole: 'member', orgRole: null };

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  machineId: null,
  gitCredentialRef: null,
  maxConcurrent: 1,
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
  format: 'markdown' as const,
  template: null,
  parentId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const REVIEW_BODY =
  '<forge-review sha="60e8d635" verdict="approve">' +
  '<forge-finding file="a.ts" line="42" severity="bug">boom</forge-finding>' +
  '<forge-summary>ran the suite</forge-summary>' +
  '</forge-review>';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('forge_comments component bodies (ISS-898)', () => {
  const tool = () =>
    forgeCommentsTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });

  it('create with format=html stores the normalized body and its template', async () => {
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    insertReturning.mockResolvedValueOnce([
      {
        ...baseCommentRow,
        body: REVIEW_BODY,
        format: 'html',
        template: 'forge-review',
      },
    ]);

    const result = (await tool().handler({
      action: 'create',
      data: { issue: ISSUE_ID, body: REVIEW_BODY, format: 'html' },
    })) as { template: string; slots: Record<string, unknown>; text: string };

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'html', template: 'forge-review' }),
    );
    expect(result.template).toBe('forge-review');
    expect(result.slots).toMatchObject({ sha: '60e8d635', verdict: 'approve' });
    expect(result.text).toContain('Review 60e8d635: APPROVE');
  });

  it('create refuses an invalid component body naming the attribute, and writes nothing', async () => {
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);

    await expect(
      tool().handler({
        action: 'create',
        data: {
          issue: ISSUE_ID,
          body: REVIEW_BODY.replace('verdict="approve"', 'verdict="approved"'),
          format: 'html',
        },
      }),
    ).rejects.toThrow(/BAD_REQUEST: BODY_INVALID.*forge-review@verdict/s);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('create reports what the sanitizer removed instead of refusing plain markup', async () => {
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    insertReturning.mockResolvedValueOnce([{ ...baseCommentRow, format: 'html' }]);

    const result = (await tool().handler({
      action: 'create',
      data: { issue: ISSUE_ID, body: '<p>hi</p><script>alert(1)</script>', format: 'html' },
    })) as { warnings: string[] };

    expect(result.warnings).toContain('removed `<script>` and its content');
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ body: '<p>hi</p>', format: 'html' }),
    );
  });

  it('update replaces the body — the only way to place a forge-artifact after the upload', async () => {
    const artifact = '<forge-artifact id="ebcb91c1-1b5f-4fa4-92af-49362d5692de" />';
    selectLimit.mockResolvedValueOnce([
      { id: COMMENT_ID, issueId: ISSUE_ID, authorId: OWNER_ID, projectId: PROJECT_ID },
    ]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    updateReturning.mockResolvedValueOnce([
      { ...baseCommentRow, body: artifact, format: 'html', template: 'forge-artifact' },
    ]);

    const result = (await tool().handler({
      action: 'update',
      documentId: COMMENT_ID,
      data: { body: artifact, format: 'html' },
    })) as { template: string };

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'html', template: 'forge-artifact' }),
    );
    expect(result.template).toBe('forge-artifact');
  });

  it('update requires documentId and data.body', async () => {
    await expect(tool().handler({ action: 'update', data: { body: 'x' } })).rejects.toThrow(
      /BAD_REQUEST: documentId/,
    );
    await expect(tool().handler({ action: 'update', documentId: COMMENT_ID })).rejects.toThrow(
      /BAD_REQUEST: data.body/,
    );
  });

  it('leaves a markdown row alone — no template, no slots, no text projection', async () => {
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    selectLimit.mockResolvedValueOnce([{ ...baseCommentRow, body: '**Triage** - m' }]);

    const envelope = (await tool().handler({
      action: 'list',
      filters: { issue: ISSUE_ID },
    })) as { comments: Array<{ format: string; template: null; slots: null; text: null }> };

    const [only] = envelope.comments;
    expect(only?.format).toBe('markdown');
    expect(only?.template).toBeNull();
    expect(only?.slots).toBeNull();
    expect(only?.text).toBeNull();
  });
});
