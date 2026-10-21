/**
 * ISS-1421 r19 — judge-79 sent `GET /api/projects/:id/knowledge?colour=red` and got 200 with the
 * key dropped, `?limit=%20` was read as 0, and a refusal's details said "received NaN" where its
 * message quoted the value. Every GET route that declares a query is sent a stray key, as the
 * project's admin and as its paired box, and none may take it. Against real Postgres, through the
 * real app and its own error handler.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';
import { pairDevice } from '../helpers/pair-device.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Registry = typeof import('../../src/api-reference/document/registry.js');
type Entry = ReturnType<Registry['readRoutes']>[number];

/** The redirects a third party shapes, which take any key (the unit gate names why). */
const TAKES_ANY = new Set([
  'GET /api/integrations/github/installed',
  'GET /api/integrations/github/manifest-callback',
]);

const ADMIN_EMAIL = 'stray-query-admin@test.forge.local';

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let routes: Entry[];
let personToken: string;
let deviceToken: string;
let projectId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
  process.env.NODE_ENV = 'test';
  // The admin pages refuse anyone else before their query is read; the caller is a platform admin.
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
  const { readRoutes } = (await import('../../src/api-reference/document/registry.js')) as Registry;
  routes = readRoutes(app as never);

  const owner = await createTestUser(harness.db, { email: ADMIN_EMAIL });
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  const project = await createTestProject(harness.db, owner.id);
  projectId = project.id;
  await createTestProjectMember(harness.db, {
    userId: owner.id,
    projectId: project.id,
    role: 'admin',
  });
  const { signUserToken } = await import('../../src/auth/jwt.js');
  personToken = await signUserToken(owner.id);
  const box = await pairDevice({ ownerId: owner.id, name: 'box', platform: 'linux' });
  deviceToken = box.plaintext;
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

type Answer = { status: number; code?: string; message?: string; details?: unknown; raw: string };

async function get(url: string, token = personToken): Promise<Answer> {
  const res = await app.request(url, { headers: { authorization: `Bearer ${token}` } });
  const raw = await res.text();
  let body: { code?: string; message?: string; details?: unknown } = {};
  try {
    body = JSON.parse(raw);
  } catch {}
  return { status: res.status, ...body, raw };
}

/** The first value a path parameter's declared enum takes, so its own check passes. */
function enumValue(entry: Entry, name: string): string | null {
  for (const v of entry.validators.filter((d) => d.target === 'param')) {
    const shape = (v.schema as { _zod: { def: { shape?: Record<string, unknown> } } })._zod.def
      .shape;
    const field = shape?.[name] as { options?: unknown[] } | undefined;
    if (field?.options?.length) return String(field.options[0]);
  }
  return null;
}

/** A path to the route: the project's id where a parameter names a project, a uuid elsewhere. */
function pathOf(entry: Entry): string {
  return entry.path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?\??/g, (_w, name: string, _r, at) => {
    const listed = enumValue(entry, name);
    if (listed) return listed;
    return name === 'projectId' || (name === 'id' && /\/projects\/$/.test(entry.path.slice(0, at)))
      ? projectId
      : '00000000-0000-4000-8000-000000000000';
  });
}

describe('a query key the route does not take', () => {
  it("is refused 400 by name on judge-79's knowledge list, naming what the list takes", async () => {
    const got = await get(`/api/projects/${projectId}/knowledge?colour=red`);
    expect(got.status, got.raw).toBe(400);
    expect(got.code).toBe('UNKNOWN_QUERY_PARAMETER');
    expect(got.message).toMatch(/^The field colour is not one this call takes\. It takes .+\.$/);
    expect(got.details).toMatchObject({ unknownParameters: ['colour'] });
    const known = await get(`/api/projects/${projectId}/knowledge`);
    expect(known.status).toBe(200);
  });

  it('is refused 400 by name on every GET route that declares a query, for a person or a paired box', async () => {
    const answered: string[] = [];
    let sent = 0;
    for (const entry of routes) {
      if (entry.method !== 'GET' || TAKES_ANY.has(entry.key)) continue;
      if (!entry.validators.some((v) => v.target === 'query')) continue;
      const box = entry.path.startsWith('/api/devices/me');
      const got = await get(`${pathOf(entry)}?colour=red`, box ? deviceToken : personToken);
      sent++;
      // A gate refusing before the query is read would hide a route that takes the key: none may.
      if (got.status !== 400 || got.code !== 'UNKNOWN_QUERY_PARAMETER')
        answered.push(`${entry.key} ${got.status} ${got.code}`);
    }
    // Not vacuous: over a hundred GET routes declare a query.
    expect(sent).toBeGreaterThan(90);
    expect(answered, 'each route answered a stray key with something but its refusal').toEqual([]);
  }, 600_000);
});

describe('a number query parameter', () => {
  it('sent as a space is refused as empty, quoting what was sent', async () => {
    const got = await get(`/api/projects/${projectId}/activity?limit=%20`);
    expect(got.status).toBe(400);
    expect(got.message).toBe(
      'The field limit is empty: " " holds no number. Send a number, or leave the field out.',
    );
  });

  it('sent a word carries the words of the message in its details, never NaN', async () => {
    const got = await get(`/api/projects/${projectId}/activity?limit=abc`);
    expect(got.status).toBe(400);
    expect(got.message).toBe('The field limit takes a number, not "abc".');
    expect(got.details).toMatchObject({
      fieldErrors: { limit: ['The field limit takes a number, not "abc".'] },
    });
    expect(got.raw).not.toMatch(/NaN|Invalid input/);
  });
});
