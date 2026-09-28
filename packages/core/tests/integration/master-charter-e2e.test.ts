/**
 * A project's master charter against the mounted app and a real column
 * (ISS-1313).
 *
 * The unit file beside `master-charter.ts` drives `parseMasterCharterWrite`
 * with plain values; this one proves the rest of the record: the agency door
 * refuses an agent's write before anything is read or written, versions
 * accumulate rather than overwrite, two writers racing land two versions,
 * and the shapes the route refuses are shapes the database itself refuses
 * too.
 */

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

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let projectId: string;
let humanToken: string;
let agentToken: string;
let viewerToken: string;
let humanId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-abc';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  process.env.RATE_LIMIT_PAT_READ_MAX = '100000';
  process.env.RATE_LIMIT_PAT_WRITE_MAX = '100000';

  await truncateAll(harness.db);

  const human = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  humanId = human.id;
  const org = await seedOrg(harness.db, human.id);
  const project = await createTestProject(harness.db, human.id, { orgId: org.id });
  projectId = project.id;
  await createTestProjectMember(harness.db, { projectId, userId: human.id });

  const { signUserToken } = await import('../../src/auth/jwt.js');
  humanToken = await signUserToken(human.id);

  // A read-only project member — the route's own doc comment says the reads are open to
  // "anything holding access to the project", so a viewer is the floor to prove (criterion 9's
  // neighbour: an agent is refused on the write alone; a viewer must not be refused on the reads).
  const viewer = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  await createTestProjectMember(harness.db, { projectId, userId: viewer.id, role: 'viewer' });
  viewerToken = await signUserToken(viewer.id);

  // An agent credential: a PAT owned by an agent-kind user, granted every permission the
  // route's resource serves, so the refusal it meets is the agency door and nothing narrower.
  const agentUser = await createTestUser(harness.db, { kind: 'agent' });
  await createTestProjectMember(harness.db, { projectId, userId: agentUser.id });
  const { mintPat } = await import('../../src/auth/pat.js');
  agentToken = (
    await mintPat({
      userId: agentUser.id,
      name: 'charter-agent',
      permissions: ['projects:read', 'projects:write'],
    })
  ).plaintext;

  ({ app } = await import('../../src/index.js'));
});

afterAll(async () => {
  await harness.cleanup();
});

async function send(method: string, path: string, token: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json: json as Record<string, unknown> | null };
}

const path = (id: string) => `/api/projects/${id}/master-charter`;
const versionsPath = (id: string) => `/api/projects/${id}/master-charter/versions`;

describe('a project that has declared no charter (criterion 1)', () => {
  it('answers 200 with declared: false, not an error and not a 404', async () => {
    // Runs before any charter is written to `projectId` in this file — order within the file
    // matters for this one assertion.
    const res = await send('GET', path(projectId), humanToken);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ declared: false, version: null, goal: null, rules: [] });
  });
});

describe('the agency door (criteria 7, 8, 9)', () => {
  it('refuses a PUT arriving on an agent credential with 403 and MASTER_CHARTER_IS_A_PERSONS_WRITE', async () => {
    const res = await send('PUT', path(projectId), agentToken, {
      goal: 'an agent writing its own job description',
      rules: [],
    });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: 'MASTER_CHARTER_IS_A_PERSONS_WRITE' });
  });

  it('writes no row for the refused request, so the charter after it is the one from before (criterion 8)', async () => {
    const res = await send('GET', path(projectId), humanToken);
    expect(res.json).toMatchObject({ declared: false });
  });

  it("serves an agent credential's GET — the refusal is about writing alone (criterion 9)", async () => {
    const res = await send('GET', path(projectId), agentToken);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ declared: false });
  });
});

describe('declaring and revising a charter (criteria 2-6)', () => {
  it('a first write returns version 1 with exactly the goal and rules sent (criterion 2)', async () => {
    const res = await send('PUT', path(projectId), humanToken, {
      goal: 'keep the backlog draining',
      rules: ['unblock stuck work first', 'never merge for a human'],
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      declared: true,
      created: true,
      version: 1,
      goal: 'keep the backlog draining',
      rules: ['unblock stuck work first', 'never merge for a human'],
    });
  });

  it('a second write with different content returns version 2, and the current read is version 2 (criterion 3)', async () => {
    const write = await send('PUT', path(projectId), humanToken, {
      goal: 'keep the backlog draining, judge before merge',
      rules: ['unblock stuck work first'],
    });
    expect(write.json).toMatchObject({ version: 2, created: true });

    const read = await send('GET', path(projectId), humanToken);
    expect(read.json).toMatchObject({
      version: 2,
      goal: 'keep the backlog draining, judge before merge',
    });
  });

  it('a write identical to the current version returns that version and reports no new version (criterion 4)', async () => {
    const res = await send('PUT', path(projectId), humanToken, {
      goal: 'keep the backlog draining, judge before merge',
      rules: ['unblock stuck work first'],
    });
    expect(res.json).toMatchObject({ version: 2, created: false });
  });

  it('lists every version ever written, newest first, each with its writer and when (criterion 5)', async () => {
    const res = await send('GET', versionsPath(projectId), humanToken);
    expect(res.status).toBe(200);
    const versions = res.json?.versions as Array<Record<string, unknown>>;
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    for (const v of versions) {
      expect(v.declaredBy).toBeTruthy();
      expect(v.declaredAt).toBeTruthy();
    }
  });

  it("an earlier version's goal and rules are still readable in full (criterion 6)", async () => {
    const res = await send('GET', versionsPath(projectId), humanToken);
    const versions = res.json?.versions as Array<Record<string, unknown>>;
    const v1 = versions.find((v) => v.version === 1);
    expect(v1).toMatchObject({
      goal: 'keep the backlog draining',
      rules: ['unblock stuck work first', 'never merge for a human'],
    });
  });
});

describe('malformed writes leave no row (criteria 10-13, 36-38)', () => {
  it('refuses an empty goal with 400 naming the field and the shape (criterion 10)', async () => {
    const before = await send('GET', path(projectId), humanToken);
    const res = await send('PUT', path(projectId), humanToken, { goal: '   ', rules: [] });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ details: { field: 'goal' } });

    const after = await send('GET', path(projectId), humanToken);
    expect(after.json?.version).toBe(before.json?.version);
  });

  it('refuses rules sent as a string rather than a one-rule list (criterion 11)', async () => {
    const res = await send('PUT', path(projectId), humanToken, { goal: 'g', rules: 'one rule' });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ details: { field: 'rules' } });
  });

  it("refuses a blank rule naming that rule's position rather than dropping it (criterion 12)", async () => {
    const res = await send('PUT', path(projectId), humanToken, {
      goal: 'g',
      rules: ['fine', '  '],
    });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ details: { field: 'rules[1]' } });
  });

  it('refuses a goal past the 4000-character limit (criterion 13)', async () => {
    const res = await send('PUT', path(projectId), humanToken, {
      goal: 'g'.repeat(4001),
      rules: [],
    });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ details: { field: 'goal' } });
  });

  it('refuses more than 50 rules (criterion 37)', async () => {
    const rules = Array.from({ length: 51 }, (_, i) => `rule ${i}`);
    const res = await send('PUT', path(projectId), humanToken, { goal: 'g', rules });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ details: { field: 'rules' } });
  });

  it('refuses a rule past the 2000-character limit (criterion 38)', async () => {
    const res = await send('PUT', path(projectId), humanToken, {
      goal: 'g',
      rules: ['r'.repeat(2001)],
    });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ details: { field: 'rules[0]' } });
  });

  it('leaves no new row in project_master_charters for any of the refusals above (criterion 36)', async () => {
    const rows = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text as count FROM project_master_charters WHERE project_id = ${projectId}`,
    );
    // Exactly the two good writes from the section above landed; every malformed write in this
    // section landed nothing on top of them.
    expect(Number(rows[0]?.count)).toBe(2);
  });
});

describe('two writers racing (criterion 33)', () => {
  it('produce two versions with different numbers, both present, neither losing the other', async () => {
    const [a, b] = await Promise.all([
      send('PUT', path(projectId), humanToken, { goal: 'race A', rules: ['a'] }),
      send('PUT', path(projectId), humanToken, { goal: 'race B', rules: ['b'] }),
    ]);
    const versionsOf = (r: { json: Record<string, unknown> | null }) => r.json?.version;
    expect(versionsOf(a)).not.toBe(versionsOf(b));

    const list = await send('GET', versionsPath(projectId), humanToken);
    const versions = list.json?.versions as Array<Record<string, unknown>>;
    const goals = versions.map((v) => v.goal);
    expect(goals).toContain('race A');
    expect(goals).toContain('race B');
  });
});

describe('the database refuses what the route refuses (criterion 14, 39)', () => {
  it('refuses an INSERT whose goal is blank', async () => {
    await expect(
      harness.db.execute(sql`
        INSERT INTO project_master_charters (project_id, version, goal, rules, declared_by)
        SELECT ${projectId}, 9999, '   ', '[]'::jsonb, declared_by FROM project_master_charters LIMIT 1
      `),
    ).rejects.toThrow();
  });

  it('refuses an INSERT whose rules is not an array of non-blank strings', async () => {
    await expect(
      harness.db.execute(sql`
        INSERT INTO project_master_charters (project_id, version, goal, rules, declared_by)
        SELECT ${projectId}, 9998, 'a fine goal', '["ok", ""]'::jsonb, declared_by
        FROM project_master_charters LIMIT 1
      `),
    ).rejects.toThrow();

    await expect(
      harness.db.execute(sql`
        INSERT INTO project_master_charters (project_id, version, goal, rules, declared_by)
        SELECT ${projectId}, 9997, 'a fine goal', '"not an array"'::jsonb, declared_by
        FROM project_master_charters LIMIT 1
      `),
    ).rejects.toThrow();
  });
});

describe('a malformed body naming a field neither goal nor rules (still refused)', () => {
  it('refuses an extra field rather than storing it silently', async () => {
    const res = await send('PUT', path(projectId), humanToken, {
      goal: 'fine',
      rules: [],
      extra: 'nope',
    });
    expect(res.status).toBe(400);
  });
});

describe('an invalid project id', () => {
  it('is refused rather than reaching the service with a garbage uuid', async () => {
    const res = await send('GET', '/api/projects/not-a-uuid/master-charter', humanToken);
    expect(res.status).toBe(400);
  });
});

describe('a read-only project member (the route serves both reads to anything with access)', () => {
  it('reads the current charter', async () => {
    const res = await send('GET', path(projectId), viewerToken);
    expect(res.status).toBe(200);
  });

  it('reads the version history', async () => {
    const res = await send('GET', versionsPath(projectId), viewerToken);
    expect(res.status).toBe(200);
  });

  it('is still refused on the write, same as an agent — reads and writes are gated separately', async () => {
    const res = await send('PUT', path(projectId), viewerToken, {
      goal: 'a viewer trying to write',
      rules: [],
    });
    expect(res.status).toBe(403);
  });
});

describe('the version history is not truncated past a fixed count', () => {
  it('version 1 is still retrievable after 201 versions exist', async () => {
    const maxRows = await harness.db.execute<{ max: number | null }>(
      sql`SELECT max(version)::int as max FROM project_master_charters WHERE project_id = ${projectId}`,
    );
    const start = (maxRows[0]?.max ?? 0) + 1;
    const rows = Array.from({ length: 200 }, (_, i) => ({
      version: start + i,
      goal: `goal ${start + i}`,
    }));
    for (const batch of [rows.slice(0, 100), rows.slice(100)]) {
      const values = batch
        .map((r) => sql`(${projectId}, ${r.version}, ${r.goal}, '[]'::jsonb, ${humanId})`)
        .reduce((acc, v) => sql`${acc}, ${v}`);
      await harness.db.execute(sql`
        INSERT INTO project_master_charters (project_id, version, goal, rules, declared_by)
        VALUES ${values}
      `);
    }

    const res = await send('GET', versionsPath(projectId), humanToken);
    expect(res.status).toBe(200);
    const versions = (res.json?.versions as Array<Record<string, unknown>> | undefined) ?? [];
    expect(versions.length).toBeGreaterThanOrEqual(start + 199);
    expect(versions.some((v) => v.version === 1)).toBe(true);
  });
});
