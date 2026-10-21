/**
 * ISS-1421 r17 — judge-73 read a question with the id `q-j73` and got 500 INTERNAL_ERROR: the id
 * reached a comparison with a uuid column. Every route of the composed app is sent a malformed id
 * in each path and query parameter that names one, as a signed-in person and as a paired box, and
 * none may answer 500.
 * Against real Postgres, through the real app and its own error handler.
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
type Def = { type?: string; shape?: Record<string, unknown>; innerType?: unknown; in?: unknown };

const MALFORMED = 'not-a-uuid';
/** A parameter whose name says it holds an id. */
const NAMES_AN_ID = /^id$|Id$|_id$|Uuid$/;

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
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
  const { readRoutes } = (await import('../../src/api-reference/document/registry.js')) as Registry;
  routes = readRoutes(app as never);

  const owner = await createTestUser(harness.db);
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

const defOf = (schema: unknown): Def => (schema as { _zod: { def: Def } })._zod.def;

const OPTIONAL = new Set(['optional', 'default', 'prefault', 'catch']);

/** The declared query parameters of a route that name an id, and whether each must be sent. */
function idQueries(entry: Entry): { name: string; required: boolean }[] {
  const seen = new Map<string, boolean>();
  for (const v of entry.validators.filter((d) => d.target === 'query')) {
    let def = defOf(v.schema);
    while (def.innerType || (def.type === 'pipe' && def.in)) def = defOf(def.innerType ?? def.in);
    for (const [name, field] of Object.entries(def.shape ?? {})) {
      if (!NAMES_AN_ID.test(name)) continue;
      seen.set(name, (seen.get(name) ?? false) || !OPTIONAL.has(defOf(field).type ?? ''));
    }
  }
  return [...seen].map(([name, required]) => ({ name, required }));
}

/** The value a well-formed id parameter takes: the project's own id where it names a project. */
function wellFormed(path: string, name: string, at: number): string {
  const projectish =
    /^projectId$/.test(name) || (name === 'id' && /\/projects\/$/.test(path.slice(0, at)));
  return projectish ? projectId : '00000000-0000-4000-8000-000000000000';
}

/**
 * Each request a route is sent: one per id parameter of its path or query, that one malformed and
 * every other well formed, a required id query included, so the malformed one is what is judged.
 */
function probes(entry: Entry): string[] {
  const ids = [...entry.path.matchAll(/:([A-Za-z0-9_]+)(\{[^}]*\})?\??/g)].filter((m) =>
    NAMES_AN_ID.test(m[1] ?? ''),
  );
  const pathWith = (malformed: string | null) =>
    entry.path.replace(
      /:([A-Za-z0-9_]+)(\{[^}]*\})?\??/g,
      (whole, name: string, _r, at: number) => {
        if (!NAMES_AN_ID.test(name)) return 'x';
        return whole === malformed ? MALFORMED : wellFormed(entry.path, name, at);
      },
    );
  const queries = idQueries(entry);
  const queryWith = (malformed: string | null) => {
    const sent = queries
      .filter((q) => q.name === malformed || q.required)
      .map((q) => `${q.name}=${q.name === malformed ? MALFORMED : wellFormed('', q.name, 0)}`);
    return sent.length > 0 ? `?${sent.join('&')}` : '';
  };
  const out = ids.map((m) => `${pathWith(m[0])}${queryWith(null)}`);
  for (const q of queries) out.push(`${pathWith(null)}${queryWith(q.name)}`);
  return out;
}

async function answer(method: string, url: string, token: string) {
  const reads = method === 'GET' || method === 'HEAD';
  const res = await app.request(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(reads ? {} : { 'content-type': 'application/json' }),
    },
    ...(reads ? {} : { body: '{}' }),
  });
  if (res.status < 400) {
    await res.body?.cancel();
    return { status: res.status, text: '' };
  }
  return { status: res.status, text: await res.text() };
}

describe('a malformed id on every route', () => {
  it('is never answered 500, for a person or for a paired box', async () => {
    const crashed: string[] = [];
    let sent = 0;
    for (const entry of routes) {
      if (!entry.path.startsWith('/api/')) continue;
      for (const url of probes(entry)) {
        const token = url.startsWith('/api/devices/me') ? deviceToken : personToken;
        const { status, text } = await answer(entry.method, url, token);
        sent++;
        if (status >= 500) crashed.push(`${entry.method} ${url} ${status}: ${text.slice(0, 160)}`);
      }
    }
    // Not vacuous: several hundred routes name an id in their path or query.
    expect(sent).toBeGreaterThan(300);
    expect(crashed, 'each line is a route a malformed id crashes').toEqual([]);
  }, 600_000);

  it('sends a required id query well formed beside a malformed path id', () => {
    const picker = routes.find(
      (r) => r.key === 'GET /api/projects/:projectId/integrations/github/repositories',
    );
    if (!picker) throw new Error('the repository picker is not served any more');
    expect(probes(picker)).toContain(
      `/api/projects/${MALFORMED}/integrations/github/repositories?connectionId=00000000-0000-4000-8000-000000000000`,
    );
  });

  it("refuses judge-73's question read 400, naming the parameter", async () => {
    const res = await answer(
      'GET',
      `/api/devices/me/questions/q-j73?runId=${MALFORMED}`,
      deviceToken,
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text).message).toMatch(/\b(?:questionId|runId)\b/);
  });
});
