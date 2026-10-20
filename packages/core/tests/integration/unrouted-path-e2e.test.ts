import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { pairDevice } from '../helpers/pair-device.js';

/**
 * ISS-1305: a path no route serves is answered 404 naming the path, whoever asks and whatever they
 * hold, against the whole mounted app with every door a real caller goes through.
 *
 * The unit app beside `devices/pool-routes.ts` mounts the routes alone, so a removed route reads
 * 404 there however core's gates answer a caller holding a token. This is the half that sends the
 * credential through them.
 *
 * What the 404 must not buy is a way past the fence: a route that IS served and sits outside the
 * token surface still refuses a token with `PAT_NOT_PERMITTED`, which is the last block here.
 */

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let credentials: ReadonlyArray<readonly [string, string | null]>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  process.env.RATE_LIMIT_PAT_READ_MAX = '100000';
  process.env.RATE_LIMIT_PAT_WRITE_MAX = '100000';

  await truncateAll(harness.db);

  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const org = await seedOrg(harness.db, user.id);
  const project = await createTestProject(harness.db, user.id, { orgId: org.id });
  await createTestProjectMember(harness.db, { projectId: project.id, userId: user.id });

  const { mintPat } = await import('../../src/auth/pat.js');
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const unscoped = (await mintPat({ userId: user.id, name: 'unscoped' })).plaintext;
  const bound = (await mintPat({ userId: user.id, name: 'bound', boundProjectId: project.id }))
    .plaintext;
  const { plaintext: device } = await pairDevice({
    ownerId: user.id,
    name: 'iss-1305-box',
    platform: 'linux',
  });

  credentials = [
    ['no credential', null],
    ['a bearer that is not a token', 'not-a-token'],
    ['a session', await signUserToken(user.id)],
    ['a personal access token', unscoped],
    ['a project-bound token', bound],
    ['a device credential', device],
  ];

  ({ app } = await import('../../src/index.js'));
});

afterAll(async () => {
  await harness.cleanup();
});

async function send(method: string, path: string, token: string | null) {
  return app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
  });
}

const UNSERVED: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/api/devices/me/pool/claim'],
  ['GET', '/api/devices/me/pool/claim'],
  ['POST', '/api/devices/me/no-such-route-iss1305'],
  ['GET', '/api/devices/me/no-such-route-iss1305'],
  ['POST', '/api/devices/me/run-sessions/cccccccc-cccc-4ccc-8ccc-cccccccccccc/not-a-verb'],
  ['GET', '/api/issues/00000000-0000-4000-8000-000000000000/no-such-route-iss1305'],
  ['DELETE', '/api/no-such-prefix-iss1305'],
  ['GET', '/api/pat/no-such-route-iss1305'],
  ['GET', '/api/orgs/no-such-route-iss1305'],
  ['POST', '/api/admin/no-such-route-iss1305'],
];

describe('a path no route serves', () => {
  it.each(UNSERVED)('%s %s is a 404 naming the path, for every caller', async (method, path) => {
    const answers: string[] = [];
    for (const [who, token] of credentials) {
      const res = await send(method, path, token);
      const body = (await res.json()) as { code?: string; message?: string };
      answers.push(`${who}: ${res.status} ${body.code}`);
      expect(body.message ?? '', who).toContain(path);
    }
    expect(answers).toEqual(credentials.map(([who]) => `${who}: 404 ROUTE_ABSENT`));
  });

  it('a HEAD request to a served GET route is answered by that route', async () => {
    for (const [who, token] of credentials) {
      const res = await send('HEAD', '/api/version', token);
      expect([who, res.status]).toEqual([who, 200]);
    }
  });

  it('a method a served path does not serve is the same 404', async () => {
    for (const [who, token] of credentials) {
      const res = await send('DELETE', '/api/health', token);
      expect([who, res.status]).toEqual([who, 404]);
    }
  });

  it('under every prefix the app mounts, for every caller', async () => {
    const prefixes = new Set<string>();
    for (const route of app.routes) {
      const prefix = /^\/api\/[^/:*]+/.exec(route.path)?.[0];
      if (prefix) prefixes.add(prefix);
    }
    expect(prefixes.size).toBeGreaterThan(30);
    const not404: string[] = [];
    for (const prefix of prefixes) {
      for (const method of ['GET', 'POST']) {
        const path = `${prefix}/a/b/c/no-such-route-iss1305`;
        for (const [who, token] of credentials) {
          const res = await send(method, path, token);
          if (res.status !== 404) not404.push(`${method} ${path} as ${who}: ${res.status}`);
        }
      }
    }
    expect(not404).toEqual([]);
  });
});

describe('the fence is kept', () => {
  it('a token is still refused PAT_NOT_PERMITTED on a route that is served outside its surface', async () => {
    for (const [who, token] of credentials.slice(3, 5)) {
      const res = await send('GET', '/api/pat', token);
      const body = (await res.json()) as { code?: string };
      expect([who, res.status, body.code]).toEqual([who, 403, 'PAT_NOT_PERMITTED']);
    }
  });

  it('no credential on a served guarded route is still 401', async () => {
    const res = await send('GET', '/api/projects', null);
    expect(res.status).toBe(401);
  });
});
