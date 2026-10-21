/**
 * ISS-1421 r17 — judge-73 read a question with the id `q-j73` and got 500 INTERNAL_ERROR: the id
 * reached a comparison with a uuid column. Every route of the composed app is sent a malformed id
 * in each path and query parameter that names one, as a signed-in person and as a paired box, and
 * none may answer 500. r18 — judge-75 found the same crash in a body (`projectId` of a box's
 * question), so every body field that names an id is a uuid, or is listed here with why it is not.
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
type Def = {
  type?: string;
  shape?: Record<string, unknown>;
  innerType?: unknown;
  in?: unknown;
  out?: unknown;
  element?: unknown;
  options?: unknown[];
  left?: unknown;
  right?: unknown;
  format?: string;
  checks?: { _zod?: { def?: { format?: string } } }[];
  getter?: () => unknown;
};

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

/** A body field whose name says it holds an id, an array of them included. */
const BODY_NAMES_AN_ID = /^ids?$|Ids?$|_ids?$/;

/**
 * Body fields that name an id yet are not compared with a uuid column, each with why. A field
 * added to a body that names an id is a uuid, or joins this list with its reason.
 */
const NOT_A_UUID_COLUMN: Record<string, string> = {
  'PATCH /api/agent-sessions/:id claudeSessionId': "Claude Code's own session id, held as text",
  'POST /api/agent-sessions claudeSessionId': "Claude Code's own session id, held as text",
  'POST /api/agent-sessions/send claudeSessionId': "Claude Code's own session id, held as text",
  'POST /api/agent-sessions/prompt-built requestId': "the caller's own correlation id",
  'POST /api/agent-sessions/send pageContext.issueDisplayId': 'an issue key such as ISS-12',
  'POST /api/agent-sessions/start pageContext.issueDisplayId': 'an issue key such as ISS-12',
  'POST /api/devices/login/approve agent_id': "the CLI's own agent name",
  'POST /api/devices/login/init machine_id': "the box's own machine id",
  'POST /api/devices/pair machineId': "the box's own machine id",
  'POST /api/devices/me/questions options.id': "an option's key, chosen by the asker",
  'POST /api/devices/me/questions recommendedOptionId': "an option's key, chosen by the asker",
  'POST /api/devices/me/questions runId': 'a run id, held as text',
  'POST /api/devices/me/run-sessions/:sessionId/resume-choice runId': 'a run id, held as text',
  'POST /api/questions options.id': "an option's key, chosen by the asker",
  'POST /api/questions recommendedOptionId': "an option's key, chosen by the asker",
  'POST /api/questions/:id/answer optionId': "an option's key, chosen by the asker",
  'POST /api/knowledge-edges sourceMemoryId': 'a memory reference, held as text',
  'POST /api/knowledge/ingest documents.id': "the caller's own document id",
  'PATCH /api/issues/:id labels.labelId': "a label's id or its name, resolved before any read",
  'POST /api/projects/:id/issues labels.labelId':
    "a label's id or its name, resolved before any read",
  'POST /api/projects/:projectId/integrations/rocketchat/rooms userId': "Rocket.Chat's own user id",
  'POST /api/projects/:projectId/speaker-links externalId': "a chat provider's own user id",
  'POST /api/projects/:projectId/speaker-links/proposals externalId':
    "a chat provider's own user id",
  'PUT /api/app-config/:projectId chatProviderId':
    'a chat provider name, refused by name when no provider has it',
  'PUT /api/projects/:id/divergence-charter entries.id': "an entry's key inside the charter",
};

const WRAPS = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'catch']);

/** The schemas a node stands for once unwrapped: each branch of a union, an array's element. */
function nodesOf(schema: unknown, out: Def[] = [], seen = new Set<unknown>()): Def[] {
  if (seen.has(schema)) return out;
  seen.add(schema);
  const def = defOf(schema);
  if (WRAPS.has(def.type ?? '') && def.innerType) return nodesOf(def.innerType, out, seen);
  if (def.type === 'pipe')
    return nodesOf(defOf(def.in).type === 'transform' ? def.out : def.in, out, seen);
  if (def.type === 'lazy' && def.getter) return nodesOf(def.getter(), out, seen);
  if (def.type === 'union') for (const o of def.options ?? []) nodesOf(o, out, seen);
  else if (def.type === 'intersection')
    for (const p of [def.left, def.right]) nodesOf(p, out, seen);
  else if (def.type === 'array' && def.element) nodesOf(def.element, out, seen);
  else out.push(def);
  return out;
}

const isUuid = (def: Def) =>
  def.format === 'uuid' || (def.checks ?? []).some((c) => c._zod?.def?.format === 'uuid');

/** Every field of a body schema that names an id and takes a string that is not a uuid. */
function bodyIdsNotUuid(schema: unknown, at = '', seen = new Set<unknown>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const out: string[] = [];
  for (const node of nodesOf(schema)) {
    if (node.type !== 'object') continue;
    for (const [name, field] of Object.entries(node.shape ?? {})) {
      const path = at ? `${at}.${name}` : name;
      const leaves = nodesOf(field);
      if (BODY_NAMES_AN_ID.test(name) && leaves.some((l) => l.type === 'string' && !isUuid(l)))
        out.push(path);
      out.push(...bodyIdsNotUuid(field, path, seen));
    }
  }
  return [...new Set(out)];
}

describe('a malformed id in a body', () => {
  it('is declared a uuid wherever the field is compared with a uuid column', () => {
    const found = routes.flatMap((r) =>
      r.validators
        .filter((v) => v.target === 'json')
        .flatMap((v) => bodyIdsNotUuid(v.schema).map((f) => `${r.key} ${f}`)),
    );
    const unlisted = found.filter((f) => !(f in NOT_A_UUID_COLUMN));
    const stale = Object.keys(NOT_A_UUID_COLUMN).filter((k) => !found.includes(k));
    expect(unlisted, 'each line names an id a body takes as any string').toEqual([]);
    expect(stale, 'each line is listed for a field no body takes as a string any more').toEqual([]);
  });

  it("refuses judge-75's question 400, naming projectId, for a box", async () => {
    const res = await app.request('/api/devices/me/questions', {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: '00000000-0000-4000-8000-0000000000aa',
        projectId: 'q-j75',
        prompt: 'Which?',
        runId: 'run-1',
        answerShape: 'free_text',
        needed: 'A name.',
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe(
      'The field projectId is not a valid UUID.',
    );
  });
});

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
