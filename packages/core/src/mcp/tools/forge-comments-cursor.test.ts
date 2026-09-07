/**
 * ISS-956 — `forge_comments action=list` answers the cursor the REST route
 * mints, under the same field names.
 *
 * Split from `forge-comments.test.ts` rather than added to it: that file is at
 * its frozen size budget, and these cases need a reply row on the page, which
 * the shared mock chain there does not program.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePrincipal } from '../fake-principal.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    UPLOADS_MAX_BYTES: 10 * 1024 * 1024,
  },
}));

const selectLimit = vi.fn();
// cm:guard `.orderBy()` must be awaitable AND `.limit()`-able, and LAZILY so — the reply query in `listIssueCommentPage` awaits at `orderBy` with no `limit` after it while the root query calls `.limit()` on the same object. Resolve the rows eagerly and the root query's own `orderBy()` eats the first `mockResolvedValueOnce` it never reads (ISS-956).
const selectOrderByRows = vi.fn(async (): Promise<unknown[]> => []);
const selectOrderBy = vi.fn(() => ({
  limit: selectLimit,
  then: <R>(onOk: (rows: unknown[]) => R, onErr?: (e: unknown) => R) =>
    selectOrderByRows().then(onOk, onErr),
}));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  innerJoin: vi.fn(() => ({ where: selectWhere })),
  leftJoin: selectLeftJoin,
}));
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../pipeline/hooks.js', () => ({
  hooks: { emit: vi.fn().mockResolvedValue(undefined) },
}));

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
const REPLY_ID = '77777777-7777-4777-8777-777777777777';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN_ID = '99999999-9999-4999-8999-99999999aaaa';
const ORG_ID = '88888888-8888-4888-8888-888888888888';

const memberAccessRow = { orgId: ORG_ID, memberRole: 'member', orgRole: null };
const principal = makeFakePrincipal(TOKEN_ID, OWNER_ID);

const rootRow = {
  id: COMMENT_ID,
  issueId: ISSUE_ID,
  authorId: OWNER_ID,
  body: 'Hello',
  parentId: null,
  createdAt: new Date('2026-09-06T18:58:11.000Z'),
  updatedAt: new Date('2026-09-06T18:58:11.000Z'),
};

function tool() {
  return forgeCommentsTool({ principal, projectSlug: null });
}

function grantAccess() {
  selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
  selectLimit.mockResolvedValueOnce([memberAccessRow]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('forge_comments list — the cursor (ISS-956)', () => {
  it('answers nextCursor:null and hasMore:false on a thread that ends (AC 10)', async () => {
    grantAccess();
    selectLimit.mockResolvedValueOnce([rootRow]);

    const result = (await tool().handler({
      action: 'list',
      filters: { issue: ISSUE_ID },
    })) as { nextCursor: string | null; hasMore: boolean; returned: number };

    expect(result.nextCursor).toBeNull();
    expect(result.hasMore).toBe(false);
    expect(result.returned).toBe(1);
  });

  it('offers a nextCursor when a root remains past the page bound (AC 10)', async () => {
    grantAccess();
    const second = { ...rootRow, id: REPLY_ID, createdAt: new Date('2026-09-06T18:58:12.000Z') };
    selectLimit.mockResolvedValueOnce([rootRow, second]);

    const result = (await tool().handler({
      action: 'list',
      filters: { issue: ISSUE_ID },
      limit: 1,
    })) as { nextCursor: string | null; hasMore: boolean; returned: number };

    expect(result.nextCursor).toEqual(expect.any(String));
    expect(result.hasMore).toBe(true);
    expect(result.returned).toBe(1);
  });

  it('refuses a cursor it did not mint with BAD_REQUEST (AC 10)', async () => {
    grantAccess();

    await expect(
      tool().handler({ action: 'list', filters: { issue: ISSUE_ID }, cursor: 'not-a-cursor' }),
    ).rejects.toThrow(/BAD_REQUEST: cursor/);
  });

  // cm:guard `returned` must count the COMMENTS under `comments`, not the subtrees the size trim shed by — `limit` bounds top-level comments, so the two differ on any page carrying a reply, and a `returned` left at the subtree count states a length the array it names contradicts.
  it('reports `returned` as the comments it returned, replies included', async () => {
    grantAccess();
    selectLimit.mockResolvedValueOnce([rootRow]);
    selectOrderByRows.mockResolvedValueOnce([
      {
        ...rootRow,
        id: REPLY_ID,
        parentId: COMMENT_ID,
        createdAt: new Date('2026-09-06T18:58:12.000Z'),
      },
    ]);

    const result = (await tool().handler({
      action: 'list',
      filters: { issue: ISSUE_ID },
    })) as { comments: Array<{ documentId: string; parentId: string | null }>; returned: number };

    expect(result.comments).toHaveLength(2);
    expect(result.returned).toBe(2);
    expect(result.comments[1]?.parentId).toBe(COMMENT_ID);
  });
});
