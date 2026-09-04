/**
 * `POST /issues/:id/comments` records the token's owner and nothing else.
 *
 * A person in a browser and an agent holding that person's PAT arrive through
 * the same door, and Forge no longer asks the caller to declare which one it
 * is: `comments.is_ai` was that question, and the answer disagreed with the
 * token on 3,172 of 23,414 rows. Agent identity comes back when an agent has
 * one of its own, not as a self-reported boolean.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorAgency } from '../issues/actor-agency.js';

const insertReturning = vi.fn(async () => [
  { id: 'c1', issueId: 'iss-1', authorId: 'u1', authorDeviceId: null, body: 'b', parentId: null },
]);
const insertValues = vi.fn((_row: Record<string, unknown>) => ({ returning: insertReturning }));

vi.mock('../db/client.js', () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValues })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: 'iss-1', projectId: 'proj-1' }],
        }),
      }),
    })),
  },
}));
vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: async () => ({ role: 'admin' }),
  assertProjectRole: () => undefined,
  projectRoleAtLeast: () => true,
}));
vi.mock('./mentions.js', () => ({ parseMentions: () => [], resolveMentions: async () => [] }));
vi.mock('../pipeline/hooks.js', () => ({ hooks: { emit: vi.fn(async () => undefined) } }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

const { registerIssueCommentRoutes } = await import('./routes.js');

function appWith(agency: ActorAgency | undefined) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('userId' as never, 'u1' as never);
    if (agency) c.set('agency' as never, agency as never);
    await next();
  });
  registerIssueCommentRoutes(app as never);
  return app;
}

async function post(agency: ActorAgency | undefined) {
  insertValues.mockClear();
  const res = await appWith(agency).request('/1f0a4c8e-3b7d-4a2e-9c51-6d8e2f4a7b30/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'hello' }),
  });
  return { res, values: insertValues.mock.calls[0]?.[0] as Record<string, unknown> | undefined };
}

const WRITTEN_COLUMNS = ['issueId', 'authorId', 'body', 'format', 'template', 'parentId'];

beforeEach(() => vi.clearAllMocks());

describe('comment create — authorship follows the token', () => {
  it.each(['agent', 'human', undefined] as const)(
    'records the token owner and declares no agency (%s)',
    async (agency) => {
      const { values } = await post(agency);

      expect(values?.authorId).toBe('u1');
      // cm:guard the KEY SET, not just the absence of `isAi` — the defect this replaces was a column the writer filled in about itself, and a differently-named one (`actorAgency`, `writtenByBot`) would be the same defect. A new column here is a deliberate change to what a comment asserts, so it must break this list first.
      expect(Object.keys(values ?? {}).sort()).toEqual([...WRITTEN_COLUMNS].sort());
    },
  );
});
