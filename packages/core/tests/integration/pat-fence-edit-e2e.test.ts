import { eq, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
let schema: typeof import('../../src/db/schema.js');
let fenceSchema: typeof import('../../src/db/schema-pat-fence-changes.js');
let mintPat: typeof import('../../src/auth/pat.js').mintPat;
let rotatePat: typeof import('../../src/auth/pat.js').rotatePat;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let PAT_GRANT_EPOCH: number;

let owner: string;
let stranger: string;
let projectA: string;
let projectB: string;
let projectC: string;
let session: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-abc';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  process.env.RATE_LIMIT_PAT_READ_MAX ??= '100000';
  process.env.RATE_LIMIT_PAT_WRITE_MAX ??= '100000';

  schema = await import('../../src/db/schema.js');
  fenceSchema = await import('../../src/db/schema-pat-fence-changes.js');
  ({ mintPat, rotatePat } = await import('../../src/auth/pat.js'));
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ PAT_GRANT_EPOCH } = await import('../../src/auth/pat-permissions.js'));
  ({ app } = await import('../../src/index.js'));
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const verified = { emailVerifiedAt: new Date() };
  owner = (await createTestUser(harness.db, verified)).id;
  stranger = (await createTestUser(harness.db, verified)).id;
  const ownersOrg = await seedOrg(harness.db, stranger);
  const strangersOrg = await seedOrg(harness.db, stranger);
  projectA = (await createTestProject(harness.db, stranger, { orgId: ownersOrg.id })).id;
  projectB = (await createTestProject(harness.db, stranger, { orgId: ownersOrg.id })).id;
  projectC = (await createTestProject(harness.db, stranger, { orgId: strangersOrg.id })).id;
  await createTestProjectMember(harness.db, { projectId: projectA, userId: owner });
  await createTestProjectMember(harness.db, { projectId: projectB, userId: owner });
  session = await freshSession(owner);
});

async function freshSession(userId: string): Promise<string> {
  await harness.db.execute(sql`UPDATE users SET last_fresh_auth_at = now() WHERE id = ${userId}`);
  return signUserToken(userId);
}

async function mint(
  name: string,
  over: Partial<Parameters<typeof mintPat>[0]> = {},
  userId = owner,
) {
  return mintPat({
    userId,
    name,
    permissions: ['projects:read'],
    grantEpoch: PAT_GRANT_EPOCH,
    boundProjectId: projectA,
    ...over,
  });
}

function call(method: string, path: string, bearer: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const putFence = (id: string, body: unknown, bearer = session) =>
  call('PUT', `/api/pat/${id}/fence`, bearer, body);

async function tokenRow(id: string) {
  const [row] = await harness.db
    .select()
    .from(schema.personalAccessTokens)
    .where(eq(schema.personalAccessTokens.id, id));
  return row;
}

async function changeRows(tokenId: string) {
  return harness.db
    .select()
    .from(fenceSchema.patFenceChanges)
    .where(eq(fenceSchema.patFenceChanges.tokenId, tokenId));
}

async function refusalOf(res: Response) {
  const body = (await res.json()) as {
    error: { code: string; refusals: { code: string; path: string }[] };
  };
  return body.error;
}

describe('a person edits their token fence through a session (ISS-92)', () => {
  it('widens a box token to one more project, keeps the secret, and writes who and why', async () => {
    const { row, plaintext } = await mint('box');
    expect((await call('GET', `/api/projects/${projectB}`, plaintext)).status).not.toBe(200);

    const res = await putFence(row.id, {
      projectIds: [projectA, projectB],
      reason: 'box now builds B',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: { projectIds: string[]; boundProjectId: string | null; prefix: string };
      change: { changedBy: string; reason: string; previous: unknown; fence: unknown };
    };
    expect(body.token.projectIds).toEqual([projectA, projectB]);
    expect(body.token.boundProjectId).toBeNull();
    expect(body.change).toMatchObject({
      changedBy: owner,
      reason: 'box now builds B',
      previous: { projectIds: null, boundProjectId: projectA },
      fence: { projectIds: [projectA, projectB], boundProjectId: null },
    });

    const after = await tokenRow(row.id);
    expect(after?.tokenHash).toBe(row.tokenHash);
    expect(after?.tokenPrefix).toBe(row.tokenPrefix);
    expect((await call('GET', `/api/projects/${projectB}`, plaintext)).status).toBe(200);

    const [audit] = await changeRows(row.id);
    expect(audit).toMatchObject({ changedBy: owner, reason: 'box now builds B' });
  });

  it('narrows on the very next request', async () => {
    const { row, plaintext } = await mint('box', {
      boundProjectId: null,
      projectIds: [projectA, projectB],
    });
    expect((await call('GET', `/api/projects/${projectB}`, plaintext)).status).toBe(200);
    expect(
      (await putFence(row.id, { boundProjectId: projectA, reason: 'B handed off' })).status,
    ).toBe(200);
    expect((await call('GET', `/api/projects/${projectB}`, plaintext)).status).not.toBe(200);
    expect((await call('GET', `/api/projects/${projectA}`, plaintext)).status).toBe(200);
  });

  it('lists every change of the token, newest first, to its owner alone', async () => {
    const { row } = await mint('box');
    await putFence(row.id, { projectIds: [projectA, projectB], reason: 'first' });
    await putFence(row.id, { boundProjectId: projectB, reason: 'second' });
    const res = await call('GET', `/api/pat/${row.id}/fence-changes`, session);
    expect(res.status).toBe(200);
    const { changes } = (await res.json()) as { changes: { reason: string }[] };
    expect(changes.map((c) => c.reason)).toEqual(['second', 'first']);
    const other = await freshSession(stranger);
    expect((await call('GET', `/api/pat/${row.id}/fence-changes`, other)).status).toBe(404);
  });

  it('carries the edited fence through a rotation', async () => {
    const { row } = await mint('box');
    await putFence(row.id, { boundProjectId: projectB, reason: 'moved to B' });
    const rotated = await rotatePat({ id: row.id, userId: owner });
    expect(rotated?.row.boundProjectId).toBe(projectB);
  });
});

describe('every refusal writes nothing', () => {
  async function expectUntouched(id: string, before: Awaited<ReturnType<typeof tokenRow>>) {
    const after = await tokenRow(id);
    expect(after?.projectIds ?? null).toEqual(before?.projectIds ?? null);
    expect(after?.boundProjectId ?? null).toBe(before?.boundProjectId ?? null);
    expect(await changeRows(id)).toHaveLength(0);
  }

  it('refuses the token itself, so a token never widens itself', async () => {
    const { row, plaintext } = await mint('box', { permissions: ['*'] });
    const res = await putFence(
      row.id,
      { projectIds: [projectA, projectB], reason: 'widen me' },
      plaintext,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('PAT_NOT_PERMITTED');
    await expectUntouched(row.id, row);
  });

  it('refuses a project the owner is not a member of, PAT_FENCE_PROJECT_NOT_REACHABLE', async () => {
    const { row } = await mint('box');
    const res = await putFence(row.id, { projectIds: [projectA, projectC], reason: 'reach C' });
    expect(res.status).toBe(422);
    const error = await refusalOf(res);
    expect(error.code).toBe('PAT_FENCE_PROJECT_NOT_REACHABLE');
    expect(error.refusals[0]?.path).toBe('/projectIds/1');
    await expectUntouched(row.id, row);
  });

  it('refuses a revoked token, PAT_FENCE_TOKEN_REVOKED', async () => {
    const { row } = await mint('box');
    expect((await call('DELETE', `/api/pat/${row.id}`, session)).status).toBe(200);
    const res = await putFence(row.id, { projectIds: [projectA, projectB], reason: 'revive' });
    expect(res.status).toBe(422);
    expect((await refusalOf(res)).code).toBe('PAT_FENCE_TOKEN_REVOKED');
    await expectUntouched(row.id, row);
  });

  it('refuses an expired token, PAT_FENCE_TOKEN_EXPIRED', async () => {
    const { row } = await mint('box', { expiresAt: new Date(Date.now() - 60_000) });
    const res = await putFence(row.id, { boundProjectId: projectB, reason: 'late' });
    expect((await refusalOf(res)).code).toBe('PAT_FENCE_TOKEN_EXPIRED');
    await expectUntouched(row.id, row);
  });

  it('answers someone else’s token 404, leaving it as it was', async () => {
    const { row } = await mint('theirs', {}, stranger);
    const res = await putFence(row.id, { projectIds: [projectA, projectB], reason: 'take it' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
    await expectUntouched(row.id, row);
  });

  it('refuses a token core minted, PAT_FENCE_CORE_MINTED', async () => {
    const { row } = await mint(`workspace:box:${projectA}`);
    const res = await putFence(row.id, { projectIds: [projectA, projectB], reason: 'wider' });
    expect((await refusalOf(res)).code).toBe('PAT_FENCE_CORE_MINTED');
    await expectUntouched(row.id, row);
  });

  it('refuses fencing a token holding account permissions, PAT_FENCE_ACCOUNT_PERMISSION', async () => {
    const { row } = await mint('acct', { boundProjectId: null, permissions: ['account:read'] });
    const res = await putFence(row.id, { boundProjectId: projectA, reason: 'fence it' });
    expect((await refusalOf(res)).code).toBe('PAT_FENCE_ACCOUNT_PERMISSION');
    await expectUntouched(row.id, row);
  });

  it('refuses an edit that changes nothing, PAT_FENCE_UNCHANGED', async () => {
    const { row } = await mint('box');
    const res = await putFence(row.id, { boundProjectId: projectA, reason: 'same' });
    expect((await refusalOf(res)).code).toBe('PAT_FENCE_UNCHANGED');
    await expectUntouched(row.id, row);
  });

  it('refuses a session that is not fresh, FRESH_AUTH_REQUIRED', async () => {
    const { row } = await mint('box');
    await harness.db.execute(
      sql`UPDATE users SET last_fresh_auth_at = now() - interval '10 minutes' WHERE id = ${owner}`,
    );
    const res = await putFence(
      row.id,
      { boundProjectId: projectB, reason: 'stale' },
      await signUserToken(owner),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('FRESH_AUTH_REQUIRED');
    await expectUntouched(row.id, row);
  });

  it('refuses a body naming both fences or no reason, 400 with the shape', async () => {
    const { row } = await mint('box');
    for (const bad of [
      { projectIds: [projectB], boundProjectId: projectB, reason: 'both' },
      { boundProjectId: projectB },
    ]) {
      const res = await putFence(row.id, bad);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain('exactly one');
    }
    await expectUntouched(row.id, row);
  });
});

async function refusedBy(query: ReturnType<typeof sql>): Promise<string> {
  try {
    await harness.db.execute(query);
  } catch (err) {
    return String((err as { cause?: unknown }).cause ?? err);
  }
  return 'not refused';
}

describe('the audit row', () => {
  it('is insert-only, and goes only with its token', async () => {
    const { row } = await mint('box');
    await putFence(row.id, { boundProjectId: projectB, reason: 'moved' });
    expect(
      await refusedBy(
        sql`UPDATE pat_fence_changes SET reason = 'rewritten' WHERE token_id = ${row.id}`,
      ),
    ).toMatch(/PAT_FENCE_CHANGE_IMMUTABLE/);
    expect(await refusedBy(sql`DELETE FROM pat_fence_changes WHERE token_id = ${row.id}`)).toMatch(
      /PAT_FENCE_CHANGE_IMMUTABLE/,
    );
    await harness.db.execute(sql`DELETE FROM personal_access_tokens WHERE id = ${row.id}`);
    expect(await changeRows(row.id)).toHaveLength(0);
  });
});
