/**
 * ISS-1421 r20 — what judge-82 found at beta 9b0aebc, each sent again through the real app, its
 * own error handler and real Postgres: a stray field a route's own hook swallowed (the git
 * credential helper, POST /api/orgs), zod's raw text (questions), details saying what the message
 * did not (the merge mark, POST /api/orgs), a nested field named by its parent (archive), a nested
 * stray dropped (update packets), and GitHub's manifest callback naming `query`.
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
type Flattened = { formErrors: string[]; fieldErrors: Record<string, string[]> };
type Answer = { status: number; code?: string; message?: string; details?: Flattened; raw: string };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
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
  const owner = await createTestUser(harness.db, { email: 'round-twenty@test.forge.local' });
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
  deviceToken = (await pairDevice({ ownerId: owner.id, name: 'box', platform: 'linux' })).plaintext;
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

async function send(
  method: string,
  url: string,
  body?: unknown,
  token = personToken,
): Promise<Answer> {
  const res = await app.request(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await res.text();
  let parsed: Omit<Answer, 'status' | 'raw'> = {};
  try {
    parsed = JSON.parse(raw);
  } catch {}
  return { status: res.status, ...parsed, raw };
}

/** Every sentence the details hold, which the message must say too (criterion 193). */
function detailSentences(details: Flattened | undefined): string[] {
  if (!details) return [];
  return [...(details.formErrors ?? []), ...Object.values(details.fieldErrors ?? {}).flat()];
}

const LIBRARY_WORDS = /✖|→ at|Invalid input|Too small|Unrecognized key|NaN/;

describe('a stray field past a route hook (criteria 162, 203)', () => {
  it("is named by the git credential helper, which said 'host and path are required'", async () => {
    const got = await send(
      'POST',
      '/api/devices/me/git-credential',
      { protocol: 'https', host: 'github.com', path: 'j82/none', colour: 'red' },
      deviceToken,
    );
    expect(got.status, got.raw).toBe(400);
    expect(got.message).toBe('The field colour is not one this call takes.');
  });

  it('is named by POST /api/orgs, and no organization is created', async () => {
    const got = await send('POST', '/api/orgs', {
      name: 'Round Twenty',
      slug: 'round-twenty-org',
      colour: 'red',
    });
    expect(got.status, got.raw).toBe(400);
    expect(got.message).toMatch(/The field colour is not one this call takes\./);
    const rows = await harness.db.execute(
      sql`SELECT 1 FROM organizations WHERE slug = 'round-twenty-org'`,
    );
    expect([...rows]).toHaveLength(0);
  });
});

describe("a refusal's details say what its message says (criteria 193, 205)", () => {
  it('on POST /api/orgs sent a colour alone', async () => {
    const got = await send('POST', '/api/orgs', { colour: 'red' });
    expect(got.status).toBe(400);
    expect(detailSentences(got.details).length, got.raw).toBeGreaterThan(0);
    for (const said of detailSentences(got.details))
      expect(got.message, `details say "${said}"`).toContain(said);
  });

  it('on the merge mark sent a target that is not text', async () => {
    const got = await send('POST', '/api/issues/00000000-0000-4000-8000-000000000000/merge', {
      target: 123,
    });
    expect(got.status, got.raw).toBe(400);
    expect(got.message).toBe(
      'Name the branch the work merged into as `target`, in at most 200 characters.',
    );
    expect(detailSentences(got.details)).toEqual([got.message]);
  });

  it('on the merge mark sent a field it does not take', async () => {
    const got = await send('POST', '/api/issues/00000000-0000-4000-8000-000000000000/merge', {
      target: 'main',
      colour: 'red',
    });
    expect(got.status).toBe(400);
    expect(got.message).toMatch(/`colour`/);
    expect(detailSentences(got.details)).toEqual([got.message]);
  });
});

describe('questions refuse in sentences (criterion 204)', () => {
  it('POST /api/questions with nothing in it', async () => {
    const got = await send('POST', '/api/questions', {});
    expect(got.status, got.raw).toBe(400);
    expect(got.message).toMatch(/^The field issueId is required\./);
    expect(got.raw).not.toMatch(LIBRARY_WORDS);
  });

  it('GET /api/questions asking for no rows', async () => {
    const got = await send('GET', `/api/questions?projectId=${projectId}&limit=0`);
    expect(got.status, got.raw).toBe(400);
    expect(got.message).toMatch(/^The field limit /);
    expect(got.raw).not.toMatch(LIBRARY_WORDS);
  });
});

describe('a field inside a body object (criteria 206, 207)', () => {
  it('is named by its whole path where the archive filter refuses it', async () => {
    const got = await send('POST', `/api/projects/${projectId}/issues/archive`, {
      filter: { seqBelow: 'abc' },
    });
    expect(got.status, got.raw).toBe(400);
    expect(got.message).toContain('The field filter.seqBelow takes a number, not "abc".');
    expect(got.message).not.toMatch(/The field filter takes/);
  });

  it('is refused by name where the object does not take it, and nothing is written', async () => {
    const before = await harness.db.execute(sql`SELECT count(*)::int AS n FROM update_packets`);
    const got = await send('POST', '/api/update-packets', {
      change: 'c',
      story: 's',
      intentClass: 'procedure',
      appliesTo: 'all',
      provenance: { commit: 'abc1234', colour: 'red' },
    });
    expect(got.status, got.raw).toBe(400);
    expect(got.message).toBe('The field provenance.colour is not one this call takes.');
    const after = await harness.db.execute(sql`SELECT count(*)::int AS n FROM update_packets`);
    expect([...after]).toEqual([...before]);
  });
});

describe("GitHub's manifest callback (criterion 213)", () => {
  it('names each parameter the redirect left out', async () => {
    const got = await send('GET', '/api/integrations/github/manifest-callback');
    expect(got.status, got.raw).toBe(400);
    expect(got.message).toBe('The field code is required. The field state is required.');
    const half = await send('GET', '/api/integrations/github/manifest-callback?code=x');
    expect(half.message).toBe('The field state is required.');
  });
});
