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

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let userId: string;
let orgId: string;
let projectId: string;
let issueId: string;
let unmigrated: string;
let emptyGrant: string;
let statedFull: string;

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
  orgId = org.id;
  const project = await createTestProject(harness.db, user.id, { orgId: org.id });
  projectId = project.id;
  await createTestProjectMember(harness.db, { projectId, userId: user.id });

  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 'epoch probe', 'open', ${user.id})
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
  await mintPat({ userId: user.id, name: 'issues-read', permissions: ['issues:read'] });

  ({ app } = await import('../../src/index.js'));
});

afterAll(async () => {
  await harness.cleanup();
});

async function sessionToken(): Promise<string> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  await harness.db.execute(sql`UPDATE users SET last_fresh_auth_at = now() WHERE id = ${userId}`);
  return signUserToken(userId);
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
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

const codeOf = (r: { json: Record<string, unknown> | null }) =>
  ((r.json?.error as Record<string, unknown> | undefined)?.code ?? r.json?.code) as
    | string
    | undefined;

/**
 * ISS-1373 — the menu grew to every feature mount, and every token already
 * issued keeps exactly the reach it had.
 *
 * The tokens minted in `beforeAll` go through `mintPat` with no epoch, which
 * writes 1: they stand in for every row that existed before this change. The
 * ones minted below through `POST /api/pat` carry the epoch the menu stands at.
 */
describe('a token minted before the menu grew keeps its reach (ISS-1373)', () => {
  it('writes epoch 1 on every row that did not state one', async () => {
    const rows = await harness.db.execute(
      sql`SELECT name, grant_epoch FROM personal_access_tokens
          WHERE name IN ('unmigrated', 'empty', 'stated-full', 'issues-read')`,
    );
    expect(rows.map((r) => (r as { grant_epoch: number }).grant_epoch)).toEqual([1, 1, 1, 1]);
  });

  it.each([
    ['NULL', () => unmigrated],
    ['[]', () => emptyGrant],
    ['*', () => statedFull],
  ] as const)('an epoch-1 %s token is refused on a route added since', async (_l, token) => {
    for (const path of ['/api/notifications', `/api/runners?projectId=${projectId}`]) {
      const res = await send('GET', path, token());
      expect(res.status, path).toBe(403);
      expect(codeOf(res), path).toBe('PAT_GRANT_PREDATES_ROUTE');
    }
  });

  it('an epoch-1 * token still reaches what it reached before', async () => {
    const res = await send('GET', `/api/issues/${issueId}`, statedFull);
    expect(res.status).toBe(200);
  });
});

describe('a token minted now reaches every feature mount it is granted (ISS-1373)', () => {
  async function mint(body: Record<string, unknown>) {
    const res = await send('POST', '/api/pat', await sessionToken(), body);
    expect(res.status, res.text).toBe(201);
    return res.json?.plaintext as string;
  }

  it('stamps the current epoch on a token a person mints', async () => {
    await mint({ name: 'epoch-probe', permissions: ['*'] });
    const rows = await harness.db.execute(
      sql`SELECT grant_epoch FROM personal_access_tokens WHERE name = 'epoch-probe'`,
    );
    const { PAT_GRANT_EPOCH } = await import('../../src/auth/pat-permissions.js');
    expect((rows[0] as { grant_epoch: number }).grant_epoch).toBe(PAT_GRANT_EPOCH);
  });

  it('an account-wide * token reaches an account route', async () => {
    const token = await mint({ name: 'now-full', permissions: ['*'] });
    const res = await send('GET', '/api/notifications', token);
    expect(res.status, res.text).toBe(200);
  });

  it('a project-scoped * token reaches a project route for its project', async () => {
    const token = await mint({ name: 'now-scoped', permissions: ['*'], projectIds: [projectId] });
    const res = await send('GET', `/api/runners?projectId=${projectId}`, token);
    expect(res.status, res.text).toBe(200);
  });

  it('a project-scoped token is refused on an account route, whatever it holds', async () => {
    const token = await mint({
      name: 'scoped-on-account',
      permissions: ['*'],
      projectIds: [projectId],
    });
    const res = await send('GET', '/api/notifications', token);
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('PAT_ACCOUNT_ROUTE');
  });

  it('refuses minting a project-scoped token an account permission, and writes no row', async () => {
    const res = await send('POST', '/api/pat', await sessionToken(), {
      name: 'scoped-with-orgs',
      permissions: ['issues:read', 'orgs:read'],
      projectIds: [projectId],
    });
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe('PAT_ACCOUNT_PERMISSION_ON_SCOPED_TOKEN');
    expect(res.text).toContain('orgs:read');
    const rows = await harness.db.execute(
      sql`SELECT id FROM personal_access_tokens WHERE name = 'scoped-with-orgs'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('names the account-only permissions on the menu', async () => {
    const res = await send('GET', '/api/pat', await sessionToken());
    const menu = res.json?.menu as { permissions: string[]; accountOnly: string[] } | undefined;
    const { PAT_ACCOUNT_ONLY_PERMISSIONS } = await import('../../src/auth/pat-permissions.js');
    expect(menu?.accountOnly).toEqual([...PAT_ACCOUNT_ONLY_PERMISSIONS]);
    expect(menu?.permissions).toContain('runners:read');
    expect(menu?.accountOnly).toContain('orgs:write');
    expect(menu?.accountOnly).not.toContain('runners:read');
  });

  it('refuses a path kept out of the grammar with that entry reason', async () => {
    const token = await mint({ name: 'excluded-probe', permissions: ['*'] });
    const res = await send('GET', '/api/pat', token);
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('PAT_NOT_PERMITTED');
    expect(res.text).toContain('could widen its own grant');
  });

  it('admits a user token on /api/agent-sessions, which read every token as a device', async () => {
    const token = await mint({ name: 'sessions-read', permissions: ['pipeline:read'] });
    const res = await send('GET', `/api/agent-sessions?projectId=${projectId}`, token);
    expect(res.status, res.text).toBe(200);
  });

  it('still resolves a device credential on /api/agent-sessions as the device', async () => {
    const { pairDevice } = await import('../helpers/pair-device.js');
    const { plaintext } = await pairDevice({
      ownerId: userId,
      name: 'sessions-box',
      platform: 'linux',
    });
    const res = await send('GET', '/api/agent-sessions', plaintext);
    expect(res.status, res.text).toBe(200);
  });
});

describe('a credential minted from another is no wider than its parent (ISS-1373)', () => {
  async function epochOf(where: ReturnType<typeof sql>) {
    const rows = await harness.db.execute(
      sql`SELECT grant_epoch FROM personal_access_tokens WHERE ${where} AND revoked_at IS NULL`,
    );
    return (rows[0] as { grant_epoch: number } | undefined)?.grant_epoch;
  }

  async function pairingCodeFrom(token: string) {
    const res = await send('POST', `/api/projects/${projectId}/devices/pairing-codes`, token, {});
    expect(res.status, res.text).toBe(201);
    return res.json?.code as string;
  }

  async function redeemAndCheckout(code: string, label: string) {
    const { redeemPairingCode } = await import('../../src/devices/pair.js');
    const { issueWorkspaceCredential } = await import('../../src/devices/workspace-credential.js');
    const { device } = await redeemPairingCode({ code, name: label, platform: 'linux' });
    await issueWorkspaceCredential({ deviceId: device.id, projectId, holderUserId: userId });
    return device.id;
  }

  it('a box paired on an epoch-1 token, and its checkout credential, carry epoch 1', async () => {
    const deviceId = await redeemAndCheckout(await pairingCodeFrom(statedFull), 'old-token-box');
    const { deviceTokenNameFor, workspaceTokenNameFor } = await import(
      '../../src/auth/pat-format.js'
    );
    expect(await epochOf(sql`name = ${deviceTokenNameFor(deviceId)}`)).toBe(1);
    expect(await epochOf(sql`name = ${workspaceTokenNameFor(deviceId, projectId)}`)).toBe(1);
  });

  it('a box paired on a session, and its checkout credential, carry the current epoch', async () => {
    const deviceId = await redeemAndCheckout(
      await pairingCodeFrom(await sessionToken()),
      'session-box',
    );
    const { deviceTokenNameFor, workspaceTokenNameFor } = await import(
      '../../src/auth/pat-format.js'
    );
    const { PAT_GRANT_EPOCH } = await import('../../src/auth/pat-permissions.js');
    expect(await epochOf(sql`name = ${deviceTokenNameFor(deviceId)}`)).toBe(PAT_GRANT_EPOCH);
    expect(await epochOf(sql`name = ${workspaceTokenNameFor(deviceId, projectId)}`)).toBe(
      PAT_GRANT_EPOCH,
    );
  });
});

describe('a route minting a * credential needs a session or a * token (ISS-1373)', () => {
  async function mint(name: string, permissions: string[]) {
    const res = await send('POST', '/api/pat', await sessionToken(), { name, permissions });
    expect(res.status, res.text).toBe(201);
    return res.json?.plaintext as string;
  }

  const routes = () =>
    [
      ['POST', `/api/orgs/${orgId}/agents`, { handle: 'probe-agent', projectIds: [projectId] }],
      ['POST', `/api/orgs/${orgId}/agents/${randomUUID()}/tokens`, {}],
      ['POST', '/api/devices/login/approve', { pairing_code: 'ABCD-EFGH' }],
    ] as const;

  it('refuses a named grant on each of the three', async () => {
    const named = await mint('named-minter', ['orgs:write', 'devices:write']);
    for (const [method, path, body] of routes()) {
      const res = await send(method, path, named, body);
      expect(res.status, path).toBe(403);
      expect(codeOf(res), path).toBe('PAT_MINT_NEEDS_FULL_GRANT');
    }
  });

  it('lets a * token past the guard on each of the three', async () => {
    const full = await mint('full-minter', ['*']);
    for (const [method, path, body] of routes()) {
      const res = await send(method, path, full, body);
      expect(codeOf(res), `${path}: ${res.text}`).not.toBe('PAT_MINT_NEEDS_FULL_GRANT');
      expect(codeOf(res), path).not.toBe('PAT_NOT_PERMITTED');
    }
  });
});
