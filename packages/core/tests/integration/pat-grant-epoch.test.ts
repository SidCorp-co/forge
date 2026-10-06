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
let namedRead: string;
let oldScoped: string;
let oldBound: string;

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
  process.env.PAT_MAX_PER_USER = '1000';

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
  namedRead = (
    await mintPat({ userId: user.id, name: 'issues-read', permissions: ['issues:read'] })
  ).plaintext;
  oldScoped = (
    await mintPat({
      userId: user.id,
      name: 'old-scoped',
      permissions: ['*'],
      projectIds: [projectId],
    })
  ).plaintext;
  oldBound = (
    await mintPat({
      userId: user.id,
      name: 'old-bound',
      permissions: ['*'],
      boundProjectId: projectId,
    })
  ).plaintext;

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
    ['issues:read', () => namedRead],
  ] as const)('an epoch-1 %s token is refused on every prefix added since', async (_l, token) => {
    const added = await addedPrefixes();
    expect(added.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const prefix of added) {
      const [method, path] = probeFor(prefix);
      const res = await send(method, path, token(), method === 'POST' ? {} : undefined);
      if (res.status !== 403 || codeOf(res) !== 'PAT_GRANT_PREDATES_ROUTE') {
        wrong.push(`${method} ${path} -> ${res.status} ${codeOf(res)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it.each([
    ['NULL', () => unmigrated],
    ['[]', () => emptyGrant],
    ['*', () => statedFull],
    ['issues:read', () => namedRead],
  ] as const)('an epoch-1 %s token still reaches what it reached before', async (_l, token) => {
    const res = await send('GET', `/api/issues/${issueId}`, token());
    expect(res.status, res.text).toBe(200);
  });

  it('an epoch-1 full grant still reaches every resource it held, and a named one only its own', async () => {
    for (const token of [unmigrated, emptyGrant, statedFull]) {
      const res = await send('GET', `/api/projects/${projectId}`, token);
      expect(res.status, res.text).toBe(200);
    }
    const named = await send('GET', `/api/projects/${projectId}`, namedRead);
    expect(codeOf(named)).toBe('PAT_PERMISSION_REQUIRED');
  });
});

/** Every prefix that joined the menu after epoch 1, read off the declaration. */
async function addedPrefixes(reach?: 'project' | 'account'): Promise<string[]> {
  const { PAT_PERMISSION_RESOURCES } = await import('../../src/auth/pat-permissions.js');
  return Object.values(PAT_PERMISSION_RESOURCES)
    .filter((r) => reach === undefined || r.reach === reach)
    .flatMap((r) =>
      Object.entries(r.prefixes as Record<string, number>)
        .filter(([, epoch]) => reach !== undefined || epoch > 1)
        .map(([prefix]) => prefix),
    );
}

const ZERO = '00000000-0000-4000-8000-000000000000';

/**
 * A served route under a prefix, which reaches the token door. The two
 * invitation lookups by their own token are public, so their token-gated
 * siblings stand in; `/api/me` and `/api/devices` serve nothing at `/:id`.
 */
function probeFor(prefix: string): readonly ['GET' | 'POST', string] {
  if (prefix === '/api/invitations') return ['GET', `${prefix}/pending`];
  if (prefix === '/api/org-invitations') return ['POST', `${prefix}/${ZERO}/accept`];
  if (prefix === '/api/me') return ['GET', `${prefix}/devices`];
  if (prefix === '/api/devices') return ['GET', `${prefix}/${ZERO}/runners`];
  return ['GET', `${prefix}/${ZERO}`];
}

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

  it('a project-scoped token is refused on every account route, whatever it holds and whenever minted', async () => {
    const scoped = {
      'epoch-1 projectIds *': oldScoped,
      'epoch-1 boundProjectId *': oldBound,
      'projectIds *': await mint({
        name: 'now-scoped-full',
        permissions: ['*'],
        projectIds: [projectId],
      }),
      'boundProjectId *': await mint({
        name: 'now-bound-full',
        permissions: ['*'],
        boundProjectId: projectId,
      }),
      'projectIds named': await mint({
        name: 'now-scoped-named',
        permissions: ['issues:read', 'runners:read'],
        projectIds: [projectId],
      }),
      'empty project list *': await mint({
        name: 'now-scoped-none',
        permissions: ['*'],
        projectIds: [],
      }),
    };
    const account = await addedPrefixes('account');
    expect(account.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const [label, token] of Object.entries(scoped)) {
      for (const prefix of account) {
        const [method, path] = probeFor(prefix);
        const res = await send(method, path, token, method === 'POST' ? {} : undefined);
        if (res.status !== 403 || codeOf(res) !== 'PAT_ACCOUNT_ROUTE') {
          wrong.push(`${label}: ${method} ${path} -> ${res.status} ${codeOf(res)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('refuses minting a project-scoped token an account permission, and writes no row', async () => {
    const res = await send('POST', '/api/pat', await sessionToken(), {
      name: 'scoped-with-orgs',
      permissions: ['issues:read', 'orgs:read'],
      projectIds: [projectId],
    });
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe('PAT_ACCOUNT_PERMISSION_ON_SCOPED_TOKEN');
    expect(res.text).toContain('orgs:read is an account permission,');
    expect(res.text).toContain('Drop it,');
    const rows = await harness.db.execute(
      sql`SELECT id FROM personal_access_tokens WHERE name = 'scoped-with-orgs'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('names several account permissions in the plural on a token bound to a project', async () => {
    const res = await send('POST', '/api/pat', await sessionToken(), {
      name: 'bound-with-two',
      permissions: ['orgs:read', 'devices:read'],
      boundProjectId: projectId,
    });
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe('PAT_ACCOUNT_PERMISSION_ON_SCOPED_TOKEN');
    expect(res.text).toContain('orgs:read, devices:read are account permissions,');
    expect(res.text).toContain('Drop them,');
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

describe('an unknown invitation is named as the invitation, not the caller credential (ISS-1373)', () => {
  it.each(['/api/invitations', '/api/org-invitations'])(
    '%s answers INVITATION_NOT_FOUND to a caller holding a valid token',
    async (prefix) => {
      const minted = await send('POST', '/api/pat', await sessionToken(), {
        name: `invitation-probe${prefix.replaceAll('/', '-')}`,
        permissions: ['*'],
      });
      expect(minted.status, minted.text).toBe(201);
      const token = minted.json?.plaintext as string;
      for (const [method, path] of [
        ['GET', `${prefix}/no-such-invitation`],
        ['POST', `${prefix}/no-such-invitation/accept`],
      ] as const) {
        const res = await send(method, path, token);
        expect(res.status, `${method} ${path}: ${res.text}`).toBe(404);
        expect(codeOf(res), path).toBe('INVITATION_NOT_FOUND');
      }
    },
  );
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
