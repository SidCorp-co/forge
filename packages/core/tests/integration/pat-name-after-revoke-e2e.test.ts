/**
 * `pat_user_name_uniq` against real Postgres — ISS-1184.
 *
 * The index is partial on `revoked_at is null`, which is what every caller
 * reading it means: one LIVE token per (user, name). Everything here is a
 * property of that index, and none of it can be asserted where `db` is mocked.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let schema: typeof import('../../src/db/schema.js');
let mintPat: typeof import('../../src/auth/pat.js').mintPat;
let rotatePat: typeof import('../../src/auth/pat.js').rotatePat;
let pairDevice: typeof import('../helpers/pair-device.js').pairDevice;
let issueDeviceCredential: typeof import('../../src/devices/credential.js').issueDeviceCredential;
let issueWorkspaceCredential: typeof import('../../src/devices/workspace-credential.js').issueWorkspaceCredential;
let workspaceTokenNameFor: typeof import('../../src/auth/pat-format.js').workspaceTokenNameFor;
let deviceTokenNameFor: typeof import('../../src/auth/pat-format.js').deviceTokenNameFor;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-abc';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  process.env.RATE_LIMIT_PAT_READ_MAX ??= '100000';
  process.env.RATE_LIMIT_PAT_WRITE_MAX ??= '100000';

  schema = await import('../../src/db/schema.js');
  ({ mintPat, rotatePat } = await import('../../src/auth/pat.js'));
  ({ issueDeviceCredential } = await import('../../src/devices/credential.js'));
  ({ issueWorkspaceCredential } = await import('../../src/devices/workspace-credential.js'));
  ({ workspaceTokenNameFor, deviceTokenNameFor } = await import('../../src/auth/pat-format.js'));
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  pairDevice = (await import('../helpers/pair-device.js')).pairDevice;
  ({ app } = await import('../../src/index.js'));
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function rowsNamed(userId: string) {
  return harness.db
    .select({
      id: schema.personalAccessTokens.id,
      name: schema.personalAccessTokens.name,
      revokedAt: schema.personalAccessTokens.revokedAt,
    })
    .from(schema.personalAccessTokens)
    .where(eq(schema.personalAccessTokens.userId, userId));
}

async function liveCount(userId: string, name: string): Promise<number> {
  const rows = await harness.db
    .select({ id: schema.personalAccessTokens.id })
    .from(schema.personalAccessTokens)
    .where(
      and(
        eq(schema.personalAccessTokens.userId, userId),
        eq(schema.personalAccessTokens.name, name),
        isNull(schema.personalAccessTokens.revokedAt),
      ),
    );
  return rows.length;
}

describe('a PAT name is unique among a user’s live tokens (ISS-1184)', () => {
  it('lets two requests for one checkout mint concurrently without either throwing', async () => {
    const user = await createTestUser(harness.db);
    const { device } = await pairDevice({ ownerId: user.id, name: 'box', platform: 'linux' });
    const projectId = '651c720d-8243-49ff-bf4c-f295ef98818f';
    const args = { deviceId: device.id, projectId, holderUserId: user.id };

    // The sweep meeting a `provision.request` for the same checkout. Without the
    // advisory lock both revoke before either inserts and the second insert is
    // refused by the partial index.
    const [a, b] = await Promise.all([
      issueWorkspaceCredential(args),
      issueWorkspaceCredential(args),
    ]);
    expect(a).toMatch(/^forge_pat_/);
    expect(b).toMatch(/^forge_pat_/);
    expect(a).not.toBe(b);

    expect(await liveCount(user.id, workspaceTokenNameFor(device.id, projectId))).toBe(1);
  });

  it('leaves the previous credential live when the mint inside it fails', async () => {
    const user = await createTestUser(harness.db);
    const { device } = await pairDevice({ ownerId: user.id, name: 'box', platform: 'linux' });
    // `project_ids` is a uuid[]; a projectId that is not a uuid makes the INSERT
    // fail for real, after the revoke in the same transaction has already run.
    const projectId = 'not-a-uuid';
    const name = workspaceTokenNameFor(device.id, projectId);
    await mintPat({ userId: user.id, name, deviceId: device.id });
    expect(await liveCount(user.id, name)).toBe(1);

    await expect(
      issueWorkspaceCredential({ deviceId: device.id, projectId, holderUserId: user.id }),
    ).rejects.toThrow();

    // Rolled back whole: a failed provision must not cost the checkout the
    // credential it already had.
    expect(await liveCount(user.id, name)).toBe(1);
  });

  it('supersedes a device credential without renaming the row it replaces', async () => {
    const user = await createTestUser(harness.db);
    const { device } = await pairDevice({ ownerId: user.id, name: 'box', platform: 'linux' });
    const name = deviceTokenNameFor(device.id);

    await issueDeviceCredential({ deviceId: device.id, holderUserId: user.id });

    const rows = await rowsNamed(user.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.name === name)).toBe(true);
    expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
  });

  it('rotates a token without renaming the row it replaces', async () => {
    const user = await createTestUser(harness.db);
    const minted = await mintPat({ userId: user.id, name: 'laptop' });

    const rotated = await rotatePat({ id: minted.row.id, userId: user.id });
    expect(rotated?.plaintext).toMatch(/^forge_pat_/);

    const rows = await rowsNamed(user.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.name === 'laptop')).toBe(true);
    expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
  });

  it('lets two concurrent rotations of one token both mint without either being refused', async () => {
    const user = await createTestUser(harness.db);
    const minted = await mintPat({ userId: user.id, name: 'laptop' });
    const input = { id: minted.row.id, userId: user.id };

    // Two requests rotating the same live token. Read outside the transaction,
    // both see the same live row; the first replacement takes the name and the
    // second insert is refused by the partial index.
    const [a, b] = await Promise.all([rotatePat(input), rotatePat(input)]);
    expect(a?.plaintext).toMatch(/^forge_pat_/);
    expect(b?.plaintext).toMatch(/^forge_pat_/);
    expect(a?.plaintext).not.toBe(b?.plaintext);

    expect(await liveCount(user.id, 'laptop')).toBe(1);
  });

  it('lets two concurrent device-credential issues both mint without either being refused', async () => {
    const user = await createTestUser(harness.db);
    const { device } = await pairDevice({ ownerId: user.id, name: 'box', platform: 'linux' });
    const name = deviceTokenNameFor(device.id);
    const args = { deviceId: device.id, holderUserId: user.id };

    // A re-pair meeting a login for the same box. Revoke and mint apart, both
    // revoke the one live row before either inserts under its name.
    const [a, b] = await Promise.all([issueDeviceCredential(args), issueDeviceCredential(args)]);
    expect(a).toMatch(/^forge_pat_/);
    expect(b).toMatch(/^forge_pat_/);
    expect(a).not.toBe(b);

    expect(await liveCount(user.id, name)).toBe(1);
    const rows = await rowsNamed(user.id);
    expect(rows.every((r) => r.name === name)).toBe(true);
  });

  it('lets a person create a token under a name they once revoked', async () => {
    const user = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now(), last_fresh_auth_at = now() WHERE id = ${user.id}`,
    );
    const jwt = await signUserToken(user.id);
    const create = () =>
      app.request('/api/pat', {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ci' }),
      });

    const first = await create();
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string; plaintext: string };
    expect(created.plaintext).toMatch(/^forge_pat_/);

    const revoked = await app.request(`/api/pat/${created.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(revoked.status).toBeLessThan(300);

    // The route's conflict check filters on `revoked_at is null`, so it lets
    // this through; the index has to agree or the INSERT is a 500.
    const second = await create();
    expect(second.status).toBe(201);
    expect(await liveCount(user.id, 'ci')).toBe(1);
  });
});
