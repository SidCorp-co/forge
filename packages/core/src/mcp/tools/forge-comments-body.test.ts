import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePrincipal } from '../fake-principal.fixture.js';

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
// cm:guard `.orderBy()` must be awaitable AND `.limit()`-able, and LAZILY so — the reply query in `listIssueCommentPage` awaits at `orderBy` with no `limit` after it while the root query calls `.limit()` on the same object. Resolve eagerly and the root query's own `orderBy()` eats a `mockResolvedValueOnce` it never reads (ISS-956).
const selectOrderByRows = vi.fn(async (): Promise<unknown[]> => []);
const selectOrderBy = vi.fn(() => ({
  limit: selectLimit,
  then: <R>(onOk: (rows: unknown[]) => R, onErr?: (e: unknown) => R) =>
    selectOrderByRows().then(onOk, onErr),
}));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
// cm:guard `insertComment`'s stage read used to join `projects` and be told apart by that join; since the body mandate was removed (2026-09-14) it is a plain `from(issues).where().limit()` and is INDISTINGUISHABLE from an auth lookup by chain shape, so every create case below must queue a third `selectLimit` for it — one short and the insert resolves against an auth row.
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

const fakePrincipal = makeFakePrincipal(DEVICE_ID, OWNER_ID);

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('forge_comments html bodies', () => {
  const tool = () =>
    forgeCommentsTool({
      principal: fakePrincipal,
      projectSlug: null,
    });

  it('create with format=html stores the normalized body', async () => {
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    selectLimit.mockResolvedValueOnce([{ stage: 'open' }]);
    insertReturning.mockResolvedValueOnce([
      { ...baseCommentRow, body: '<p>looks right</p>', format: 'html' },
    ]);

    const result = (await tool().handler({
      action: 'create',
      data: { issue: ISSUE_ID, body: '<p>looks right</p>', format: 'html' },
    })) as { text: string };

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ format: 'html' }));
    expect(result.text).toContain('looks right');
  });

  // cm:guard component markup is refused by NAME at the MCP door too, and writes nothing: `forge-plugin` skills reach this door over the wire and still carry the vocabulary removed on 2026-09-14, so a silent unwrap here would flatten a skill's structured record into prose behind a success.
  it('create refuses component markup, naming it, and writes nothing', async () => {
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);

    await expect(
      tool().handler({
        action: 'create',
        data: {
          issue: ISSUE_ID,
          body: '<forge-review sha="60e8d635" verdict="approve"></forge-review>',
          format: 'html',
        },
      }),
    ).rejects.toThrow(/BAD_REQUEST: BODY_INVALID.*forge-review.*removed on 2026-09-14/s);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('create reports what the sanitizer removed instead of refusing plain markup', async () => {
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    selectLimit.mockResolvedValueOnce([{ stage: 'open' }]);
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

  it('update replaces the body', async () => {
    selectLimit.mockResolvedValueOnce([
      { id: COMMENT_ID, issueId: ISSUE_ID, authorId: OWNER_ID, projectId: PROJECT_ID },
    ]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // cm:guard the EDIT door reads no stage: `stage` records when a comment was WRITTEN and an edit does not move it, and the mandate that used to read it here went with the component vocabulary (2026-09-14). A row queued for it leaks into the next case, which then resolves its auth lookup against a stage row.
    selectLimit.mockResolvedValueOnce([{ issueId: ISSUE_ID, authorDeviceId: null }]);
    updateReturning.mockResolvedValueOnce([
      { ...baseCommentRow, body: '<p>corrected</p>', format: 'html' },
    ]);

    await tool().handler({
      action: 'update',
      documentId: COMMENT_ID,
      data: { body: '<p>corrected</p>', format: 'html' },
    });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ body: '<p>corrected</p>', format: 'html' }),
    );
  });

  it('update requires documentId and data.body', async () => {
    await expect(tool().handler({ action: 'update', data: { body: 'x' } })).rejects.toThrow(
      /BAD_REQUEST: documentId/,
    );
    await expect(tool().handler({ action: 'update', documentId: COMMENT_ID })).rejects.toThrow(
      /BAD_REQUEST: data.body/,
    );
  });

  it('leaves a markdown row alone — no text projection', async () => {
    selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    selectLimit.mockResolvedValueOnce([{ ...baseCommentRow, body: '**Triage** - m' }]);

    const envelope = (await tool().handler({
      action: 'list',
      filters: { issue: ISSUE_ID },
    })) as { comments: Array<{ format: string; text: null }> };

    const [only] = envelope.comments;
    expect(only?.format).toBe('markdown');
    expect(only?.text).toBeNull();
  });
});
