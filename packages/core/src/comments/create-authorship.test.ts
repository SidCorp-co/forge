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
 * filled in about itself; this is `restEstablishedAgency(c)`, resolved from the
 * authenticated principal in the one place a principal is built
 * (`middleware/require-pat.ts`) and never readable off the request body. The
 * test below is what holds that line: a client that sends `authorAgency` must
 * not be able to move it.
 *
 * ISS-1003 made the stored value three-valued: the cases here are the three
 * real credentials rather than three values of one variable.
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

/** The three credentials a comment door really meets, as the middleware sets them. */
type Credential = 'session' | 'agent-token' | 'person-token';

const CREDENTIALS: Record<Credential, { principal: string; agency: ActorAgency | null }> = {
  session: { principal: 'user', agency: null },
  'agent-token': { principal: 'pat', agency: 'agent' },
  'person-token': { principal: 'pat', agency: null },
};

function appWith(credential: Credential) {
  const { principal, agency } = CREDENTIALS[credential];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('userId' as never, 'u1' as never);
    c.set('principal' as never, principal as never);
    c.set('agency' as never, agency as never);
    await next();
  });
  registerIssueCommentRoutes(app as never);
  return app;
}

async function post(credential: Credential) {
  insertValues.mockClear();
  const res = await appWith(credential).request('/1f0a4c8e-3b7d-4a2e-9c51-6d8e2f4a7b30/comments', {
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
  'stage',
  'parentId',
];

beforeEach(() => vi.clearAllMocks());

describe('comment create — authorship follows the token', () => {
  it.each(['session', 'agent-token', 'person-token'] as const)(
    'records the token owner and writes exactly the columns the door decides (%s)',
    async (credential) => {
      const { values } = await post(credential);

      expect(values?.authorId).toBe('u1');
      expect(Object.keys(values ?? {}).sort()).toEqual([...WRITTEN_COLUMNS].sort());
    },
  );

  it('takes the agency from the authenticated principal, not the caller', async () => {
    expect((await post('agent-token')).values?.authorAgency).toBe('agent');
    expect((await post('session')).values?.authorAgency).toBe('human');
  });

  it('claims nothing about a person-owned token, which establishes nobody', async () => {
    expect((await post('person-token')).values?.authorAgency).toBeNull();
  });

  it('ignores an `authorAgency` a client puts in the request body', async () => {
    insertValues.mockClear();
    const res = await appWith('session').request('/1f0a4c8e-3b7d-4a2e-9c51-6d8e2f4a7b30/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hello', authorAgency: 'agent' }),
    });
    expect(res.status).toBe(400);
    expect(insertValues).not.toHaveBeenCalled();
  });
});
