/**
 * `POST /issues/:id/comments` stamps `is_ai` from the caller's agency.
 *
 * The MCP tool labels every write `isAi: true` because that path is automated
 * by construction. This route is not: a person in a browser and an agent
 * holding a job PAT arrive through the same door, so the value has to come
 * from the principal.
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
  return { res, values: insertValues.mock.calls[0]?.[0] as { isAi?: boolean } | undefined };
}

beforeEach(() => vi.clearAllMocks());

describe('comment create — is_ai comes from agency', () => {
  it('an agent-agency caller writes isAi: true', async () => {
    const { values } = await post('agent');
    expect(
      values?.isAi,
      'forge-runner api posted a comment that landed is_ai=false with a NULL device id — the exact tuple the comments.is_ai guard calls a human',
    ).toBe(true);
  });

  it('a human-agency caller writes isAi: false', async () => {
    const { values } = await post('human');
    expect(values?.isAi).toBe(false);
  });

  it('an absent agency is not treated as an agent', async () => {
    const { values } = await post(undefined);
    expect(values?.isAi).toBe(false);
  });
});
