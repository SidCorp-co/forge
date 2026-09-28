import { randomUUID } from 'node:crypto';
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

/**
 * ISS-973 against the mounted app and a real column.
 *
 * The unit file beside `pat-rest-surface.ts` drives the predicate with a fake
 * context; this one proves the same three answers survive the round trip the
 * predicate cannot see — the column drizzle actually wrote, the row shape the
 * mint route accepts, and the refusal an operator reads off the wire.
 *
 * The row that matters most here is the one NOT minted through the new field:
 * `unmigrated` is written with a raw UPDATE setting `permissions = NULL`,
 * which is exactly the state every production token is in the instant the
 * migration runs, and the assertion on it is that nothing changed.
 *
 * ISS-1255 closed the door that made an unstated grant the whole menu. The
 * door now refuses a create that states no permissions and accepts `*` as
 * full access chosen on purpose; the two legacy shapes at rest, `NULL` and
 * `[]`, keep reaching everything, because a token already minted does not
 * change power. Both halves are asserted below, and the second is the one
 * that would go quiet if somebody decided to tidy the legacy reading away.
 */

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let userId: string;
let projectId: string;
let issueId: string;
let unmigrated: string;
let emptyGrant: string;
let statedFull: string;
let limitedUserId: string;
let issuesReadOnly: string;
let issuesWrite: string;
let schedulesRead: string;
let everythingElse: string;

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
  userId = user.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const org = await seedOrg(harness.db, user.id);
  const project = await createTestProject(harness.db, user.id, { orgId: org.id });
  projectId = project.id;
  await createTestProjectMember(harness.db, { projectId, userId: user.id });

  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 'grant probe', 'open', ${user.id})
  `);

  const { mintPat } = await import('../../src/auth/pat.js');

  const legacy = await mintPat({ userId: user.id, name: 'unmigrated' });
  unmigrated = legacy.plaintext;
  await harness.db.execute(
    sql`UPDATE personal_access_tokens SET permissions = NULL WHERE id = ${legacy.row.id}`,
  );

  emptyGrant = (await mintPat({ userId: user.id, name: 'empty', permissions: [] })).plaintext;
  statedFull = (await mintPat({ userId: user.id, name: 'stated-full', permissions: ['*'] }))
    .plaintext;
  issuesReadOnly = (
    await mintPat({ userId: user.id, name: 'issues-read', permissions: ['issues:read'] })
  ).plaintext;
  issuesWrite = (
    await mintPat({
      userId: user.id,
      name: 'issues-write',
      permissions: ['issues:read', 'issues:write'],
    })
  ).plaintext;

  const { PAT_PERMISSION_NAMES } = await import('../../src/auth/pat-permissions.js');
  schedulesRead = (
    await mintPat({ userId: user.id, name: 'schedules-read', permissions: ['schedules:read'] })
  ).plaintext;
  everythingElse = (
    await mintPat({
      userId: user.id,
      name: 'all-but-schedules-read',
      permissions: PAT_PERMISSION_NAMES.filter((n) => n !== 'schedules:read'),
    })
  ).plaintext;

  // A second holder, filled to the per-user cap with rows written straight to
  // the table, so the create door's limit check is live for them and nothing
  // this file mints for the first user counts against it.
  const limited = await createTestUser(harness.db);
  limitedUserId = limited.id;
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id = ${limited.id}`,
  );
  const { env } = await import('../../src/config/env.js');
  for (let n = 0; n < env.PAT_MAX_PER_USER; n += 1) {
    await harness.db.execute(sql`
      INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix, scopes)
      VALUES (${limited.id}, ${`filler-${n}`}, 'not-a-hash', ${`forge_pat_f${n}`}, ARRAY['read'])
    `);
  }

  ({ app } = await import('../../src/index.js'));
});

afterAll(async () => {
  await harness.cleanup();
});

/**
 * A browser-shaped credential for `/api/pat`, which no PAT may reach.
 *
 * `requireFreshAuth(5)` reads `users.last_fresh_auth_at` rather than anything
 * in the token, so the stamp is the whole of "recently re-authenticated".
 */
async function sessionToken(who: string = userId): Promise<string> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  await harness.db.execute(sql`UPDATE users SET last_fresh_auth_at = now() WHERE id = ${who}`);
  return signUserToken(who);
}

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
  return {
    status: res.status,
    text,
    json: json as Record<string, unknown> | null,
    accepted: res.headers.get('X-Accepted-Forge-Permissions'),
  };
}

const codeOf = (r: { json: Record<string, unknown> | null }) =>
  ((r.json?.error as Record<string, unknown> | undefined)?.code ?? r.json?.code) as
    | string
    | undefined;

describe('the migration leaves every existing row ungranted, and ungranted is the whole menu', () => {
  it('leaves the column NULL on a row it did not write', async () => {
    const rows = await harness.db.execute(
      sql`SELECT permissions FROM personal_access_tokens WHERE name = 'unmigrated'`,
    );
    expect((rows[0] as { permissions: unknown } | undefined)?.permissions).toBeNull();
  });

  it.each([
    ['issues', () => `/api/issues/${issueId}`],
    ['schedules', () => `/api/schedules?projectId=${projectId}`],
    ['knowledge', () => `/api/knowledge?projectId=${projectId}`],
  ] as const)('an unmigrated token is not refused on %s', async (_label, path) => {
    const res = await send('GET', path(), unmigrated);
    expect(codeOf(res)).not.toBe('PAT_PERMISSION_REQUIRED');
    expect(codeOf(res)).not.toBe('PAT_NOT_PERMITTED');
  });

  it('an empty grant array is the whole menu too', async () => {
    const res = await send('GET', `/api/schedules?projectId=${projectId}`, emptyGrant);
    expect(codeOf(res)).not.toBe('PAT_PERMISSION_REQUIRED');
  });
});

describe('a granted token reaches its groups and is refused outside them', () => {
  it('reaches the group it holds', async () => {
    const res = await send('GET', `/api/issues/${issueId}`, issuesReadOnly);
    expect(codeOf(res)).not.toBe('PAT_PERMISSION_REQUIRED');
    expect(res.status).toBe(200);
  });

  it('is refused outside it, 403, naming the permission the path wanted', async () => {
    const res = await send('GET', `/api/schedules?projectId=${projectId}`, issuesReadOnly);
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('PAT_PERMISSION_REQUIRED');
    expect(res.text).toContain('schedules:read');
  });

  it('is refused writing a resource it holds only the read of', async () => {
    const res = await send('POST', '/api/issues', issuesReadOnly, {
      projectId,
      title: 'grant probe',
    });
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('PAT_PERMISSION_REQUIRED');
    expect(res.text).toContain('issues:write');
  });

  it('writes once the write group is held', async () => {
    const res = await send('POST', '/api/issues', issuesWrite, {
      projectId,
      title: 'grant probe',
    });
    expect(codeOf(res)).not.toBe('PAT_PERMISSION_REQUIRED');
  });

  it('still answers PAT_NOT_PERMITTED off the surface, whatever it holds', async () => {
    const res = await send('GET', '/api/pat', issuesReadOnly);
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('PAT_NOT_PERMITTED');
  });
});

describe('a rotation is a new secret for the same grant', () => {
  it('carries the permission names onto the new row', async () => {
    const { mintPat, rotatePat } = await import('../../src/auth/pat.js');
    const original = await mintPat({
      userId,
      name: 'rotate-me',
      permissions: ['knowledge:read'],
    });
    const rotated = await rotatePat({ id: original.row.id, userId, expiresAt: null });
    expect(rotated?.row.permissions).toEqual(['knowledge:read']);
  });
});

describe('the mint route offers the menu and refuses anything off it', () => {
  it('mints a token carrying exactly the names it was given', async () => {
    const res = await send('POST', '/api/pat', await sessionToken(), {
      name: 'minted-with-grants',
      permissions: ['issues:read', 'schedules:write'],
    });
    expect(res.status).toBe(201);
    expect(res.json?.permissions).toEqual(['issues:read', 'schedules:write']);

    const rows = await harness.db.execute(
      sql`SELECT permissions FROM personal_access_tokens WHERE name = 'minted-with-grants'`,
    );
    expect((rows[0] as { permissions: string[] }).permissions).toEqual([
      'issues:read',
      'schedules:write',
    ]);
  });

  it('refuses a name that is not on the menu, rather than dropping it', async () => {
    const res = await send('POST', '/api/pat', await sessionToken(), {
      name: 'invented-group',
      permissions: ['everything:read'],
    });
    expect(res.status).toBe(400);
    const rows = await harness.db.execute(
      sql`SELECT id FROM personal_access_tokens WHERE name = 'invented-group'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("reports each token's grants back on the list", async () => {
    const res = await send('GET', '/api/pat', await sessionToken());
    expect(res.status).toBe(200);
    const tokens = res.json?.tokens as { name: string; permissions: string[] | null }[];
    const byName = new Map(tokens.map((t) => [t.name, t.permissions]));
    expect(byName.get('issues-read')).toEqual(['issues:read']);
    expect(byName.get('unmigrated')).toBeNull();
    expect(byName.get('empty')).toEqual([]);
  });
});

/**
 * ISS-1255 — the create door states what a token may reach, or refuses.
 *
 * The first four cases are the shapes a caller can send. The last two decide
 * WHICH refusal a bad body gets: what is wrong with the body is answered
 * before what is wrong with the account, or a caller who left the field out
 * learns about a name collision instead.
 */
describe('a create states what the token may reach, or it is refused (ISS-1255)', () => {
  const rowsNamed = (name: string) =>
    harness.db.execute(sql`SELECT id FROM personal_access_tokens WHERE name = ${name}`);

  it('refuses a body that states no permissions, and writes no row', async () => {
    const res = await send('POST', '/api/pat', await sessionToken(), { name: 'no-grants-given' });
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe('PAT_PERMISSIONS_REQUIRED');
    expect(await rowsNamed('no-grants-given')).toHaveLength(0);
  });

  it('tells the caller both shapes it may send', async () => {
    const res = await send('POST', '/api/pat', await sessionToken(), { name: 'told-what-to-send' });
    expect(res.text).toContain('permissions');
    expect(res.text).toContain('["*"]');
    expect(res.text).toContain('issues:read');
  });

  it('refuses an explicit null the same way, rather than as a malformed body', async () => {
    const res = await send('POST', '/api/pat', await sessionToken(), {
      name: 'null-grant',
      permissions: null,
    });
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe('PAT_PERMISSIONS_REQUIRED');
    expect(await rowsNamed('null-grant')).toHaveLength(0);
  });

  it('refuses an empty list the same way, an empty choice being no choice', async () => {
    const res = await send('POST', '/api/pat', await sessionToken(), {
      name: 'empty-list-sent',
      permissions: [],
    });
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe('PAT_PERMISSIONS_REQUIRED');
    expect(await rowsNamed('empty-list-sent')).toHaveLength(0);
  });

  it('refuses full access mixed with a named permission, and writes no row', async () => {
    const res = await send('POST', '/api/pat', await sessionToken(), {
      name: 'full-and-named',
      permissions: ['*', 'issues:read'],
    });
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe('PAT_PERMISSIONS_FULL_NOT_COMBINABLE');
    expect(await rowsNamed('full-and-named')).toHaveLength(0);
  });

  it('answers the missing grant before the duplicate name', async () => {
    const res = await send('POST', '/api/pat', await sessionToken(), { name: 'issues-read' });
    expect(codeOf(res)).toBe('PAT_PERMISSIONS_REQUIRED');
  });

  it('answers the missing grant before the per-user limit', async () => {
    const res = await send('POST', '/api/pat', await sessionToken(limitedUserId), {
      name: 'at-the-cap',
    });
    expect(codeOf(res)).toBe('PAT_PERMISSIONS_REQUIRED');
  });
});

describe('full access is a value the minter picks (ISS-1255)', () => {
  it('mints it, and the column says it was chosen rather than left out', async () => {
    const res = await send('POST', '/api/pat', await sessionToken(), {
      name: 'minted-full-on-purpose',
      permissions: ['*'],
    });
    expect(res.status).toBe(201);
    expect(res.json?.permissions).toEqual(['*']);
    const rows = await harness.db.execute(
      sql`SELECT permissions FROM personal_access_tokens WHERE name = 'minted-full-on-purpose'`,
    );
    expect((rows[0] as { permissions: string[] }).permissions).toEqual(['*']);
  });

  it.each([
    ['issues', () => `/api/issues/${issueId}`],
    ['schedules', () => `/api/schedules?projectId=${projectId}`],
    ['knowledge', () => `/api/knowledge?projectId=${projectId}`],
  ] as const)('a stated-full token is not refused on %s', async (_label, path) => {
    const res = await send('GET', path(), statedFull);
    expect(codeOf(res)).not.toBe('PAT_PERMISSION_REQUIRED');
    expect(codeOf(res)).not.toBe('PAT_NOT_PERMITTED');
  });

  it('is told apart from a legacy row on the listing', async () => {
    const res = await send('GET', '/api/pat', await sessionToken());
    const tokens = res.json?.tokens as { name: string; grant: string }[];
    const byName = new Map(tokens.map((t) => [t.name, t.grant]));
    expect(byName.get('stated-full')).toBe('full');
    expect(byName.get('unmigrated')).toBe('legacy');
    expect(byName.get('empty')).toBe('legacy');
    expect(byName.get('issues-read')).toBe('named');
  });

  it('carries the menu the door accepts, so a form cannot offer a name it refuses', async () => {
    const res = await send('GET', '/api/pat', await sessionToken());
    const { PAT_PERMISSION_NAMES } = await import('../../src/auth/pat-permissions.js');
    const menu = res.json?.menu as { permissions: string[]; full: string } | undefined;
    expect(menu?.permissions).toEqual([...PAT_PERMISSION_NAMES]);
    expect(menu?.full).toBe('*');
  });
});

/**
 * ISS-974 — the loop the header exists to close, walked end to end.
 *
 * The unit files prove the header is set and derived from one resolution. What
 * only a real token and a real column can show is that the name it carries is
 * the name that FIXES the refusal: read the 403's header, mint a token holding
 * exactly that, and the same request answers. The negative half matters as
 * much — a token holding all thirteen OTHER names is still refused, so the
 * header names the permission that is necessary and not merely one that is
 * sufficient alongside others.
 */
describe('the header names the grant that fixes the refusal', () => {
  const path = () => `/api/schedules?projectId=${projectId}`;

  it('spells the header the way the middleware exports it', async () => {
    const { PAT_ACCEPTED_PERMISSIONS_HEADER } = await import(
      '../../src/middleware/pat-rest-surface.js'
    );
    expect(PAT_ACCEPTED_PERMISSIONS_HEADER).toBe('X-Accepted-Forge-Permissions');
  });

  it('names what a narrowed token lacks, on the refusal itself', async () => {
    const res = await send('GET', path(), issuesReadOnly);
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('PAT_PERMISSION_REQUIRED');
    expect(res.accepted).toBe('schedules:read');
  });

  it('admits the same request once a token holds exactly that name', async () => {
    const res = await send('GET', path(), schedulesRead);
    expect(res.status).toBe(200);
    expect(res.accepted).toBe('schedules:read');
  });

  it('still refuses a token granted every other name on the menu', async () => {
    const res = await send('GET', path(), everythingElse);
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('PAT_PERMISSION_REQUIRED');
    expect(res.accepted).toBe('schedules:read');
  });

  it('says nothing at all on a path no permission covers', async () => {
    const res = await send('GET', '/api/pat', issuesReadOnly);
    expect(codeOf(res)).toBe('PAT_NOT_PERMITTED');
    expect(res.accepted).toBeNull();
  });
});
