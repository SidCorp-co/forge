import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePrincipal } from '../fake-principal.fixture.js';

/**
 * ISS-958: a typed record of any block count is ONE write, and the cap that
 * bounds it is readable off the tool schema before a client uploads anything.
 *
 * Its own file rather than more of `forge-comments-body.test.ts`, which owns
 * ISS-898's format gate; the mock surface is the same narrow one.
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
// cm:guard `.orderBy()` must be awaitable AND `.limit()`-able, and LAZILY so — the reply query in `listIssueCommentPage` awaits at `orderBy` with no `limit` after it while the root query calls `.limit()` on the same object (ISS-956)
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
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  innerJoin: selectInnerJoin,
  leftJoin: selectLeftJoin,
}));
const insertReturning = vi.fn();
const insertValues = vi.fn((_row: Record<string, unknown>) => ({ returning: insertReturning }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
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
const { COMMENT_BODY_MAX_CHARS } = await import('../../comments/body-input.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '88888888-8888-4888-8888-888888888888';

const memberAccessRow = { orgId: ORG_ID, memberRole: 'member', orgRole: null };
const fakePrincipal = makeFakePrincipal(DEVICE_ID, OWNER_ID);

const tool = () => forgeCommentsTool({ principal: fakePrincipal, projectSlug: null });

function authzHits() {
  selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
  selectLimit.mockResolvedValueOnce([memberAccessRow]);
}

/**
 * The record shape ISS-958 measured: one `<forge-case>` per acceptance
 * criterion, each carrying the criterion's text, the commit, the evidence list
 * and a 400-character reason — ~1,400 characters a block, ~48,000 for 34.
 */
function verdictRecord(caseCount: number): string {
  const cases = Array.from({ length: caseCount }, (_, i) => {
    const n = i + 1;
    const criterion = `Criterion ${n}: ${'c'.repeat(500)}`;
    const evidence = `commit 60e8d635 · evidence ${'e'.repeat(450)}`;
    const reason = 'r'.repeat(400);
    return `<forge-case id="AC-${n}" verdict="pass">${criterion} — ${evidence} — ${reason}</forge-case>`;
  }).join('');
  return `<forge-qa-report verdict="pass" env="local">${cases}</forge-qa-report>`;
}

beforeEach(() => vi.clearAllMocks());

describe('forge_comments body cap (ISS-958)', () => {
  it('publishes the cap on data.body so a client reads it without importing core', () => {
    const schema = tool().inputSchema as {
      properties: { data: { properties: { body: { maxLength?: number } } } };
    };

    expect(schema.properties.data.properties.body.maxLength).toBe(64_000);
    expect(COMMENT_BODY_MAX_CHARS).toBe(64_000);
  });

  it('accepts a 60,000-character body in one write', async () => {
    authzHits();
    const body = 'x'.repeat(60_000);
    insertReturning.mockResolvedValueOnce([
      {
        id: '55555555-5555-4555-8555-555555555555',
        issueId: ISSUE_ID,
        authorId: OWNER_ID,
        body,
        format: 'markdown',
        template: null,
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const result = (await tool().handler({
      action: 'create',
      data: { issue: ISSUE_ID, body },
    })) as { documentId: string };

    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0]?.[0].body).toBe(body);
    expect(result.documentId).toBe('55555555-5555-4555-8555-555555555555');
  });

  it('lands a 34-block verdict record whole, with every block parsed back', async () => {
    authzHits();
    const body = verdictRecord(34);
    expect(body.length).toBeGreaterThan(45_000);
    let stored = '';
    insertValues.mockImplementationOnce((row) => {
      stored = row.body as string;
      return { returning: insertReturning };
    });
    insertReturning.mockImplementationOnce(async () => [
      {
        id: '55555555-5555-4555-8555-555555555555',
        issueId: ISSUE_ID,
        authorId: OWNER_ID,
        body: stored,
        format: 'html',
        template: 'forge-qa-report',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const result = (await tool().handler({
      action: 'create',
      data: { issue: ISSUE_ID, body, format: 'html' },
    })) as { template: string; slots: { cases: unknown[] } };

    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(stored).toBe(body);
    expect(result.template).toBe('forge-qa-report');
    expect(result.slots.cases).toHaveLength(34);

    authzHits();
    selectLimit.mockResolvedValueOnce([
      {
        id: '55555555-5555-4555-8555-555555555555',
        issueId: ISSUE_ID,
        authorId: OWNER_ID,
        body: stored,
        format: 'html',
        template: 'forge-qa-report',
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const envelope = (await tool().handler({
      action: 'list',
      filters: { issue: ISSUE_ID },
    })) as { comments: Array<{ body: string; slots: { cases: unknown[] } }> };

    expect(envelope.comments).toHaveLength(1);
    // cm:why the read projection FRAMES a body as untrusted data (ISS-532), so byte-identity is asserted on what reached the INSERT above; here the assertion is that the whole record survives the round trip inside that frame rather than being split, trimmed or truncated
    expect(envelope.comments[0]?.body).toContain(body);
    expect(envelope.comments[0]?.slots.cases).toHaveLength(34);
  });

  it('refuses one character over the cap, naming the cap, and writes nothing', async () => {
    await expect(
      tool().handler({
        action: 'create',
        data: { issue: ISSUE_ID, body: 'x'.repeat(64_001) },
      }),
    ).rejects.toThrow(/64000/);
    expect(insertValues).not.toHaveBeenCalled();
  });
});
