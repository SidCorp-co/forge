/**
 * ISS-925: every router under `/api/projects` gates only the routes it serves. A `use('*', gate)` on
 * one of them (the project guides', and eighteen others') ran on every `/api/projects/*` request that
 * reached it, so an unauthenticated project route answered only if mounted ahead of all of them, and
 * four routes held no gate of their own and rode on those. On the real app: a route mounted after
 * every router answers with no session; the guide read and the routes that rode on another's gate
 * refuse one; and each keeps the verified-email gate it was held to. Against real Postgres.
 *
 * @direct-test-of packages/core/src/guides/routes.ts
 * @direct-test-of packages/core/src/middleware/gated-routes.ts
 * @direct-test-of packages/core/src/requirements/routes.ts
 * @direct-test-of packages/core/src/support/routes.ts
 * @direct-test-of packages/core/src/route-registry.ts
 */

import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeWorld, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';

let app: Hono;
let projectId = '';
let unverified = '';

beforeAll(async () => {
  testEnv();
  ({ app } = (await import('../../src/index.js')) as unknown as { app: Hono });
  // mounted after every router the registry mounts, before the first request builds the matcher
  app.post('/api/projects/:id/zz-open-door', (c) => c.json({ reached: c.req.param('id') }));
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const owner = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  unverified = await signUserToken((await createTestUser({ verified: false })).id);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const call = (method: string, path: string, token?: string) =>
  app.request(path, {
    method,
    headers: {
      'X-Forge-Lifecycle': '10',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

/** The routes that held no gate of their own and answered only behind another router's `use('*')`. */
const RODE_ON_ANOTHER = [
  ['GET', 'requirement-areas'],
  ['PUT', 'requirement-areas'],
  ['POST', 'requirement-areas/propose'],
  ['GET', 'agent-roles'],
] as const;

describe('routers under /api/projects gate their own routes alone', () => {
  it('lets an unauthenticated project route mounted after every router answer with no session', async () => {
    const res = await call('POST', `/api/projects/${projectId}/zz-open-door`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: projectId });
  });

  it('still refuses a guide read and a gated router’s own route with no session', async () => {
    for (const path of ['guides/feedback', 'forecast', 'issues/standing', 'members']) {
      const res = await call('GET', `/api/projects/${projectId}/${path}`);
      expect(res.status, path).toBe(401);
    }
    expect((await call('GET', '/api/projects')).status).toBe(401);
  });

  it('refuses each route that rode on another router’s gate, now its own, with no session', async () => {
    for (const [method, path] of RODE_ON_ANOTHER) {
      const res = await call(method, `/api/projects/${projectId}/${path}`);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('holds those routes and the support doors to the verified email they were held to', async () => {
    for (const [method, path] of [...RODE_ON_ANOTHER, ['GET', 'support/rooms'] as const]) {
      const res = await call(method, `/api/projects/${projectId}/${path}`, unverified);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json(), `${method} ${path}`).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    }
  });
});
