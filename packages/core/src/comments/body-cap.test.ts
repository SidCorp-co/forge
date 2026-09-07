import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ISS-958 at the two REST doors: a typed record of any block count is one
 * `POST`, and a body over the declared cap is refused there with the cap named
 * — the same number the MCP tool publishes, because both read one export.
 */

const insertReturning = vi.fn(async () => [
  { id: 'c1', issueId: 'iss-1', authorId: 'u1', body: 'b', format: 'markdown', parentId: null },
]);
const insertValues = vi.fn((_row: Record<string, unknown>) => ({ returning: insertReturning }));
const updateCommentBody = vi.fn(async (_id: string, input: { body: string }) => ({
  row: { id: 'c1', issueId: 'iss-1', authorId: 'u1', body: input.body },
  warnings: [] as string[],
}));

vi.mock('../db/client.js', () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValues })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: async () => [{ id: 'iss-1', projectId: 'p1' }] }),
        innerJoin: () => ({
          where: () => ({
            limit: async () => [
              { id: 'c1', issueId: 'iss-1', authorId: 'u1', body: 'b', projectId: 'p1' },
            ],
          }),
        }),
      }),
    })),
  },
}));
vi.mock('./service.js', async (importActual) => {
  const actual = await importActual<typeof import('./service.js')>();
  return { ...actual, updateCommentBody };
});
vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: async () => ({ role: 'admin' }),
  assertProjectRole: () => undefined,
  projectRoleAtLeast: () => true,
}));
vi.mock('./mentions.js', () => ({ parseMentions: () => [], resolveMentions: async () => [] }));
vi.mock('../pipeline/hooks.js', () => ({ hooks: { emit: vi.fn(async () => undefined) } }));
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../logger.js', () => ({ logger: silentLogger, getLogger: () => silentLogger }));
vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test', UPLOADS_MAX_BYTES: 5_000_000 } }));
vi.mock('../middleware/auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: () => async (_c: unknown, next: () => Promise<void>) => await next(),
    assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => await next(),
  };
});

const { registerIssueCommentRoutes, commentRoutes } = await import('./routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { COMMENT_BODY_MAX_CHARS } = await import('./body-input.js');

const ISSUE_ID = '1f0a4c8e-3b7d-4a2e-9c51-6d8e2f4a7b30';
const COMMENT_ID = '2f0a4c8e-3b7d-4a2e-9c51-6d8e2f4a7b31';

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('userId' as never, 'u1' as never);
    await next();
  });
  registerIssueCommentRoutes(a as never);
  a.route('/comments', commentRoutes as never);
  // cm:guard the real `errorHandler`, not Hono's default — the cap lives in the HTTPException's `cause.details`, so a bare app renders only 'Invalid input' and the assertion that the refusal NAMES the cap cannot fail
  a.onError(errorHandler as never);
  return a;
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => vi.clearAllMocks());

describe('comment body cap at the REST doors (ISS-958)', () => {
  it.each([
    ['at the cap', COMMENT_BODY_MAX_CHARS, 201],
    ['under the cap', 60_000, 201],
    ['one over the cap', COMMENT_BODY_MAX_CHARS + 1, 400],
  ])('POST /issues/:id/comments — %s', async (_name, length, status) => {
    const res = await app().request(`/${ISSUE_ID}/comments`, json({ body: 'x'.repeat(length) }));

    expect(res.status).toBe(status);
    if (status === 400) {
      expect(await res.text()).toContain(String(COMMENT_BODY_MAX_CHARS));
      expect(insertValues).not.toHaveBeenCalled();
    } else {
      expect(insertValues.mock.calls[0]?.[0].body).toHaveLength(length);
    }
  });

  it.each([
    ['under the cap', 60_000, 200],
    ['one over the cap', COMMENT_BODY_MAX_CHARS + 1, 400],
  ])('PATCH /comments/:id — %s', async (_name, length, status) => {
    const res = await app().request(`/comments/${COMMENT_ID}`, {
      ...json({ body: 'x'.repeat(length) }),
      method: 'PATCH',
    });

    expect(res.status).toBe(status);
    if (status === 400) {
      expect(await res.text()).toContain(String(COMMENT_BODY_MAX_CHARS));
      expect(updateCommentBody).not.toHaveBeenCalled();
    } else {
      expect(updateCommentBody.mock.calls[0]?.[1].body).toHaveLength(length);
    }
  });

  // cm:guard the cap is ONE literal in `src` — the defect ISS-958 found was the number written twice (the REST validator and the MCP tool), which is what lets the number a client reads off the tool schema drift from the number the doors enforce; a second occurrence here is that defect returning
  it('writes the cap literal exactly once outside the tests', () => {
    const root = resolve(import.meta.dirname, '..');
    const carriers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
          if (/\b64[_,]?000\b/.test(readFileSync(full, 'utf8'))) {
            carriers.push(full.slice(root.length + 1));
          }
        }
      }
    };
    walk(root);

    expect(carriers).toEqual(['comments/body-input.ts']);
  });
});
