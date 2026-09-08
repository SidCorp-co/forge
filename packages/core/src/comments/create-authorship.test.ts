/**
 * `POST /issues/:id/comments` records what the TOKEN said, and nothing the
 * caller claims about itself.
 *
 * A person in a browser and an agent arrive through the same door, and Forge
 * does not ask which: `comments.is_ai` was that question, and the answer
 * disagreed with the token on 3,172 of 23,414 rows.
 *
 * ISS-969 adds `author_agency`, which is the shape that defect makes suspicious
 * and is nevertheless the opposite of it. `is_ai` was a request FIELD a client
 * filled in about itself; this is `restActor(c).agency`, resolved from the
 * authenticated principal in the one place a principal is built
 * (`middleware/require-pat.ts`, from the token owner's `users.kind`) and never
 * readable off the request body. The test below is what holds that line: a
 * client that sends `authorAgency` must not be able to move it.
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
        // cm:guard the stage read `insertComment` does (ISS-969) — the issue's status joined to the project's stored policy. Without this link the create path resolves at `where().limit()` and every case here fails on a row that is not the one it asked for.
        innerJoin: () => ({
          where: () => ({
            limit: async () => [{ stage: 'open', agentConfig: null }],
          }),
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

const WRITTEN_COLUMNS = [
  'issueId',
  'authorId',
  'authorDeviceId',
  'authorAgency',
  'body',
  'format',
  'template',
  'stage',
  'parentId',
];

beforeEach(() => vi.clearAllMocks());

describe('comment create — authorship follows the token', () => {
  it.each(['agent', 'human', undefined] as const)(
    'records the token owner and writes exactly the columns the door decides (%s)',
    async (agency) => {
      const { values } = await post(agency);

      expect(values?.authorId).toBe('u1');
      // cm:guard the KEY SET, not just the absence of `isAi` — the defect this replaces was a column the writer filled in about itself, and a differently-named one (`writtenByBot`) would be the same defect. A new column here is a deliberate change to what a comment asserts, so it must break this list first.
      expect(Object.keys(values ?? {}).sort()).toEqual([...WRITTEN_COLUMNS].sort());
    },
  );

  it('takes the agency from the authenticated principal, not the caller', async () => {
    expect((await post('agent')).values?.authorAgency).toBe('agent');
    expect((await post('human')).values?.authorAgency).toBe('human');
    // cm:guard absent reads `human`, which is `restActor`'s own default and the safe direction: an unauthenticated-as-agent caller must not fall into the population a mandate refuses, and `actorAgency`'s guard states the same for the transition gates.
    expect((await post(undefined)).values?.authorAgency).toBe('human');
  });

  // cm:guard THE `is_ai` line. That column was a request field a client filled in about itself; this one must be unreachable from the body, or ISS-969 has re-created the defect it was careful to describe as the opposite of.
  it('ignores an `authorAgency` a client puts in the request body', async () => {
    insertValues.mockClear();
    const res = await appWith('human').request('/1f0a4c8e-3b7d-4a2e-9c51-6d8e2f4a7b30/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hello', authorAgency: 'agent' }),
    });
    expect(res.status).toBe(400);
    expect(insertValues).not.toHaveBeenCalled();
  });
});
