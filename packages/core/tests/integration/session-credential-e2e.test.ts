/**
 * ISS-17 — the token an Agent-mode session answers a person under: minted FOR the asker, cut to
 * what the box's holder may do on the project, found by the session, and revoked when it ends.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let sc: typeof import('../../src/agent-sessions/session-credential.js');
let pat: typeof import('../../src/auth/pat.js');
let credential: typeof import('../../src/devices/credential.js');
let schema: typeof import('../../src/db/schema.js');

let ownerId: string;
let projectId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  sc = await import('../../src/agent-sessions/session-credential.js');
  pat = await import('../../src/auth/pat.js');
  credential = await import('../../src/devices/credential.js');
  schema = await import('../../src/db/schema.js');
}, 120_000);

afterAll(async () => {
  await harness?.cleanup?.();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
});

async function personWith(role: 'viewer' | 'member' | 'admin' | null): Promise<string> {
  const id = (await createTestUser(harness.db)).id;
  if (role) await createTestProjectMember(harness.db, { userId: id, projectId, role });
  return id;
}

/** A box paired by `holder`. */
async function boxHeldBy(holder: string): Promise<string> {
  const device = await createTestDevice(harness.db, holder);
  await credential.issueDeviceCredential({ deviceId: device.id, holderUserId: holder });
  return device.id;
}

describe('resolveSessionAuthority', () => {
  it('acts as the asker with read and write where the box holder may write', async () => {
    const asker = await personWith('member');
    const deviceId = await boxHeldBy(await personWith('member'));
    const got = await sc.resolveSessionAuthority({
      asker: { userId: asker, viaTokenId: null },
      projectId,
      deviceId,
    });
    if (!got.ok) throw new Error(got.refusal.message);
    expect(got.value.authority.userId).toBe(asker);
    expect(got.value.authority.scopes).toEqual(['read', 'write']);
    expect(got.value.menu).toContain('issues:write');
  });

  it('cuts the token to reads where the box holder may only read', async () => {
    const asker = await personWith('admin');
    const deviceId = await boxHeldBy(await personWith('viewer'));
    const got = await sc.resolveSessionAuthority({
      asker: { userId: asker, viaTokenId: null },
      projectId,
      deviceId,
    });
    if (!got.ok) throw new Error(got.refusal.message);
    expect(got.value.authority.scopes).toEqual(['read']);
    expect(got.value.menu.every((p) => p.endsWith(':read'))).toBe(true);
  });

  it('refuses by name a box whose holder holds no role on the project', async () => {
    const asker = await personWith('member');
    const deviceId = await boxHeldBy(await personWith(null));
    const got = await sc.resolveSessionAuthority({
      asker: { userId: asker, viaTokenId: null },
      projectId,
      deviceId,
    });
    expect(got).toMatchObject({ ok: false, refusal: { code: 'TURN_DEVICE_NO_ROLE' } });
  });

  it('refuses by name an asker who holds no role on the project', async () => {
    const asker = await personWith(null);
    const deviceId = await boxHeldBy(await personWith('member'));
    const got = await sc.resolveSessionAuthority({
      asker: { userId: asker, viaTokenId: null },
      projectId,
      deviceId,
    });
    expect(got).toMatchObject({ ok: false, refusal: { code: 'TURN_NO_ROLE' } });
  });

  it('refuses by name an asker whose token is fenced away from the project', async () => {
    const asker = await personWith('member');
    const elsewhere = randomUUID();
    const fenced = await pat.mintPat({
      userId: asker,
      name: 'fenced',
      permissions: ['*'],
      projectIds: [elsewhere],
    });
    const deviceId = await boxHeldBy(await personWith('member'));
    const got = await sc.resolveSessionAuthority({
      asker: { userId: asker, viaTokenId: fenced.row.id },
      projectId,
      deviceId,
    });
    expect(got).toMatchObject({ ok: false, refusal: { code: 'TURN_TOKEN_FENCED' } });
  });
});

describe('the session token', () => {
  it('is minted for the asker, fenced to the project and the box, and revoked by the session', async () => {
    const asker = await personWith('member');
    const deviceId = await boxHeldBy(await personWith('member'));
    const got = await sc.resolveSessionAuthority({
      asker: { userId: asker, viaTokenId: null },
      projectId,
      deviceId,
    });
    if (!got.ok) throw new Error(got.refusal.message);
    const sessionId = randomUUID();
    const token = await sc.mintSessionCredential({ sessionId, deviceId, value: got.value });

    const verified = await pat.verifyPat(token);
    expect(verified?.row).toMatchObject({
      userId: asker,
      deviceId,
      boundProjectId: projectId,
      projectIds: [projectId],
      name: `turn:${sessionId}`,
    });
    expect(verified?.row.expiresAt).not.toBeNull();

    await sc.revokeSessionCredential(sessionId);
    expect(await pat.verifyPat(token)).toBeNull();
    const [row] = await harness.db
      .select({ revokedAt: schema.personalAccessTokens.revokedAt })
      .from(schema.personalAccessTokens)
      .where(eq(schema.personalAccessTokens.name, `turn:${sessionId}`));
    expect(row?.revokedAt).not.toBeNull();
  });
});

describe('the box an Agent-mode turn is handed to', () => {
  it('is only one whose runner declared it carries the asker’s token', async () => {
    const { pickConversationAgentDevice, noConversationAgentDeviceReason } = sc;
    const old = await createTestDevice(harness.db, ownerId);
    await bindTestRunner(harness.db, { projectId, deviceId: old.id });
    await harness.db.execute(sql`UPDATE runners SET last_seen_at = now()`);

    expect(await pickConversationAgentDevice(projectId)).toBeNull();
    expect(await noConversationAgentDeviceReason(projectId)).toBe('runner-outdated');

    const current = await createTestDevice(harness.db, ownerId);
    await bindTestRunner(harness.db, { projectId, deviceId: current.id });
    await harness.db.execute(sql`UPDATE runners SET last_seen_at = now()`);
    await harness.db.execute(
      sql`UPDATE devices SET capabilities = '{"turnCredential": true}'::jsonb WHERE id = ${current.id}`,
    );
    expect(await pickConversationAgentDevice(projectId)).toBe(current.id);
  });
});
