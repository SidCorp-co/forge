/**
 * ISS-977 — a chat-channel speaker resolves to a Forge user, or is refused.
 *
 * Walked over the real HTTP surface against a real Postgres, because the claim
 * is about authorization and a unit test of the handler cannot say whether the
 * row is unique, whose it is, or that the propose step wrote nothing. The one
 * thing stubbed is the Rocket.Chat server's own directory: this environment has
 * no inbound Rocket.Chat fixture at all, so `users.info` is the seam.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

type Profile = { externalId: string; username: string | null; email: string | null };

/** externalId -> what the Rocket.Chat directory reports, per server URL. */
const directory = new Map<string, Profile>();

function key(serverUrl: string, externalId: string): string {
  return `${serverUrl}|${externalId}`;
}

vi.mock('../../src/integrations/rocketchat/rest-client.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    fetchUserProfile: async (
      auth: { serverUrl: string },
      externalId: string,
    ): Promise<Profile | null> => directory.get(key(auth.serverUrl, externalId)) ?? null,
  };
});

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const RC_A = 'https://chat-a.example.com';
const RC_B = 'https://chat-b.example.com';
const NS_A = 'chat-a.example.com';
const NS_B = 'chat-b.example.com';

let harness: TestDatabase;
let server: TestServer;
let mods: {
  createConnection: typeof import('../../src/integrations/store.js').createConnection;
  createBinding: typeof import('../../src/integrations/store.js').createBinding;
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  resolveSpeaker: typeof import('../../src/assistant/identity/speaker-link.js').resolveSpeaker;
};

let ctx: {
  projectA: string;
  projectB: string;
  alice: { id: string; email: string };
  bob: { id: string; email: string };
  outsider: { id: string; email: string };
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const [store, jwt, link] = await Promise.all([
    import('../../src/integrations/store.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/assistant/identity/speaker-link.js'),
  ]);
  mods = {
    createConnection: store.createConnection,
    createBinding: store.createBinding,
    signUserToken: jwt.signUserToken,
    resolveSpeaker: link.resolveSpeaker,
  };
  server = await startTestServer();
}, 90_000);

afterAll(async () => {
  if (server) await server.close();
  if (harness) await harness.cleanup();
});

async function bindRocketChat(projectId: string, ownerId: string, serverUrl: string) {
  const connection = await mods.createConnection({
    ownerType: 'user',
    ownerId,
    provider: 'rocketchat',
    config: { serverUrl },
    secrets: { authToken: 'bot-token', userId: 'bot-id' },
  });
  await mods.createBinding({
    connectionId: connection.id,
    projectId,
    provider: 'rocketchat',
    environment: 'prod',
    config: { rids: ['room-1'] },
  });
}

beforeEach(async () => {
  await truncateAll(harness.db);
  directory.clear();
  const verified = { emailVerifiedAt: new Date() };
  const alice = await createTestUser(harness.db, {
    ...verified,
    email: `alice-${randomUUID()}@forge.test`,
  });
  const bob = await createTestUser(harness.db, {
    ...verified,
    email: `bob-${randomUUID()}@forge.test`,
  });
  const outsider = await createTestUser(harness.db, {
    ...verified,
    email: `outsider-${randomUUID()}@forge.test`,
  });
  const projectA = await createTestProject(harness.db, alice.id);
  const projectB = await createTestProject(harness.db, alice.id);
  for (const project of [projectA, projectB]) {
    await createTestProjectMember(harness.db, {
      projectId: project.id,
      userId: bob.id,
      role: 'member',
    });
  }
  await bindRocketChat(projectA.id, alice.id, RC_A);
  await bindRocketChat(projectB.id, alice.id, RC_B);
  ctx = {
    projectA: projectA.id,
    projectB: projectB.id,
    alice,
    bob,
    outsider,
  };
});

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  as: { id: string },
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = await mods.signUserToken(as.id);
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function linkRowCount(): Promise<number> {
  const rows = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM assistant_speaker_links`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

function propose(projectId: string, as: { id: string }, externalId: string) {
  return call('POST', `/api/projects/${projectId}/speaker-links/proposals`, as, {
    source: 'rocketchat',
    externalId,
  });
}

function confirm(projectId: string, as: { id: string }, externalId: string) {
  return call('POST', `/api/projects/${projectId}/speaker-links`, as, {
    source: 'rocketchat',
    externalId,
  });
}

describe('the whole walk a person makes (criterion 21)', () => {
  it('proposes, confirms, reads back and unlinks over HTTP alone', async () => {
    directory.set(key(RC_A, 'rc-alice'), {
      externalId: 'rc-alice',
      username: 'alice.rc',
      email: ctx.alice.email.toUpperCase(),
    });

    const proposed = await propose(ctx.projectA, ctx.alice, 'rc-alice');
    expect(proposed.status).toBe(200);
    expect(proposed.json.youMayConfirm).toBe(true);
    expect(await linkRowCount()).toBe(0);

    const confirmed = await confirm(ctx.projectA, ctx.alice, 'rc-alice');
    expect(confirmed.status).toBe(201);
    expect((confirmed.json.link as Record<string, unknown>).userId).toBe(ctx.alice.id);
    expect((confirmed.json.link as Record<string, unknown>).externalNamespace).toBe(NS_A);

    const listed = await call('GET', '/api/me/speaker-links', ctx.alice);
    expect((listed.json.links as unknown[]).length).toBe(1);

    const resolved = await mods.resolveSpeaker({
      source: 'rocketchat',
      namespace: NS_A,
      externalId: 'rc-alice',
    });
    expect(resolved).toEqual({ linked: true, userId: ctx.alice.id });

    const unlinked = await call(
      'DELETE',
      `/api/me/speaker-links/rocketchat/${NS_A}/rc-alice`,
      ctx.alice,
    );
    expect(unlinked.status).toBe(200);
    expect(await linkRowCount()).toBe(0);
  });
});

describe('resolution (criteria 1, 2, 3, 4, 14)', () => {
  it('refuses an unlinked speaker by name, carrying the confirm step', async () => {
    const out = await mods.resolveSpeaker({
      source: 'rocketchat',
      namespace: NS_A,
      externalId: 'rc-nobody',
      label: 'nobody.rc',
    });
    expect(out.linked).toBe(false);
    if (out.linked) throw new Error('unreachable');
    expect(out.refusal.code).toBe('SPEAKER_UNLINKED');
    expect(out.refusal.message).toContain('nobody.rc');
    expect(out.refusal.message).toContain('rc-nobody');
    expect(out.refusal.message).toContain(NS_A);
    expect(out.refusal.message).toContain('/speaker-links');
  });

  it('refuses a source outside the vocabulary rather than reading it as unlinked', async () => {
    const out = await mods.resolveSpeaker({
      source: 'slack',
      namespace: NS_A,
      externalId: 'x',
    });
    if (out.linked) throw new Error('unreachable');
    expect(out.refusal.code).toBe('SPEAKER_SOURCE_UNKNOWN');
    expect(out.refusal.message).toContain('rocketchat');
  });

  it('refuses again after an unlink, exactly as before the link existed', async () => {
    directory.set(key(RC_A, 'rc-alice'), {
      externalId: 'rc-alice',
      username: 'alice.rc',
      email: ctx.alice.email,
    });
    const before = await mods.resolveSpeaker({
      source: 'rocketchat',
      namespace: NS_A,
      externalId: 'rc-alice',
    });
    await confirm(ctx.projectA, ctx.alice, 'rc-alice');
    await call('DELETE', `/api/me/speaker-links/rocketchat/${NS_A}/rc-alice`, ctx.alice);
    const after = await mods.resolveSpeaker({
      source: 'rocketchat',
      namespace: NS_A,
      externalId: 'rc-alice',
    });
    expect(after).toEqual(before);
  });
});

describe('two installations sharing one external id (criterion 5)', () => {
  it('links, resolves and unlinks each independently', async () => {
    directory.set(key(RC_A, 'u-1'), {
      externalId: 'u-1',
      username: 'a',
      email: ctx.alice.email,
    });
    directory.set(key(RC_B, 'u-1'), { externalId: 'u-1', username: 'b', email: ctx.bob.email });

    expect((await confirm(ctx.projectA, ctx.alice, 'u-1')).status).toBe(201);
    expect((await confirm(ctx.projectB, ctx.bob, 'u-1')).status).toBe(201);

    expect(
      await mods.resolveSpeaker({ source: 'rocketchat', namespace: NS_A, externalId: 'u-1' }),
    ).toEqual({ linked: true, userId: ctx.alice.id });
    expect(
      await mods.resolveSpeaker({ source: 'rocketchat', namespace: NS_B, externalId: 'u-1' }),
    ).toEqual({ linked: true, userId: ctx.bob.id });

    await call('DELETE', `/api/me/speaker-links/rocketchat/${NS_A}/u-1`, ctx.alice);
    expect(
      (await mods.resolveSpeaker({ source: 'rocketchat', namespace: NS_B, externalId: 'u-1' }))
        .linked,
    ).toBe(true);
  });
});

describe('who may confirm (criteria 6, 7, 8, 9, 10, 11, 12)', () => {
  it('writes nothing on a proposal, however many times it is asked', async () => {
    directory.set(key(RC_A, 'rc-alice'), {
      externalId: 'rc-alice',
      username: 'alice.rc',
      email: ctx.alice.email,
    });
    for (let i = 0; i < 3; i++) await propose(ctx.projectA, ctx.alice, 'rc-alice');
    expect(await linkRowCount()).toBe(0);
  });

  it('returns a lone candidate as a proposal and authorizes nothing by it', async () => {
    directory.set(key(RC_A, 'rc-alice'), {
      externalId: 'rc-alice',
      username: 'alice.rc',
      email: ctx.alice.email,
    });
    const out = await propose(ctx.projectA, ctx.bob, 'rc-alice');
    expect((out.json.candidates as unknown[]).length).toBe(1);
    expect(out.json.youMayConfirm).toBe(false);
    expect(await linkRowCount()).toBe(0);
  });

  it('refuses a local-part candidate at confirmation and names the difference', async () => {
    const local = ctx.alice.email.split('@')[0];
    directory.set(key(RC_A, 'rc-alice'), {
      externalId: 'rc-alice',
      username: 'alice.rc',
      email: `${local}@somewhere-else.test`,
    });
    const proposed = await propose(ctx.projectA, ctx.alice, 'rc-alice');
    expect(
      (proposed.json.candidates as Array<Record<string, unknown>>).map((c) => c.matchedOn),
    ).toEqual(['local-part']);
    const out = await confirm(ctx.projectA, ctx.alice, 'rc-alice');
    expect(out.status).toBe(403);
    expect(out.json.code).toBe('SPEAKER_ADDRESS_DIFFERS');
    expect(await linkRowCount()).toBe(0);
  });

  it('refuses a caller who is not the target, naming who the channel reports', async () => {
    directory.set(key(RC_A, 'rc-alice'), {
      externalId: 'rc-alice',
      username: 'alice.rc',
      email: ctx.alice.email,
    });
    const out = await confirm(ctx.projectA, ctx.bob, 'rc-alice');
    expect(out.status).toBe(403);
    expect(out.json.code).toBe('SPEAKER_NOT_THE_TARGET');
    expect(out.json.error).toContain(ctx.alice.email);
    expect(await linkRowCount()).toBe(0);
  });

  // cm:why the empty directory is the instrument — a check made after the read would answer SPEAKER_NOT_ON_CHANNEL, so the code is what proves the ordering rather than the status
  it('refuses a caller with no project access before the directory is read', async () => {
    directory.clear();
    const out = await confirm(ctx.projectA, ctx.outsider, 'rc-alice');
    expect(out.status).toBe(403);
    expect(out.json.code).toBe('FORBIDDEN');
    expect(out.json.message).toContain('not a project member');
  });

  it('refuses a second confirmation of the same speaker', async () => {
    directory.set(key(RC_A, 'rc-alice'), {
      externalId: 'rc-alice',
      username: 'alice.rc',
      email: ctx.alice.email,
    });
    expect((await confirm(ctx.projectA, ctx.alice, 'rc-alice')).status).toBe(201);
    const again = await confirm(ctx.projectA, ctx.alice, 'rc-alice');
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('SPEAKER_ALREADY_LINKED');
    expect(await linkRowCount()).toBe(1);
  });

  it('refuses the loser of two simultaneous confirmations, and stores one row', async () => {
    directory.set(key(RC_A, 'rc-alice'), {
      externalId: 'rc-alice',
      username: 'alice.rc',
      email: ctx.alice.email,
    });
    const [a, b] = await Promise.all([
      confirm(ctx.projectA, ctx.alice, 'rc-alice'),
      confirm(ctx.projectA, ctx.alice, 'rc-alice'),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const refused = a.status === 409 ? a : b;
    expect(refused.json.code).toBe('SPEAKER_ALREADY_LINKED');
    expect(await linkRowCount()).toBe(1);
  });

  it("lists the caller's own links and nobody else's", async () => {
    directory.set(key(RC_A, 'rc-alice'), {
      externalId: 'rc-alice',
      username: 'alice.rc',
      email: ctx.alice.email,
    });
    directory.set(key(RC_A, 'rc-bob'), {
      externalId: 'rc-bob',
      username: 'bob.rc',
      email: ctx.bob.email,
    });
    await confirm(ctx.projectA, ctx.alice, 'rc-alice');
    await confirm(ctx.projectA, ctx.bob, 'rc-bob');
    const mine = await call('GET', '/api/me/speaker-links', ctx.bob);
    const links = mine.json.links as Array<Record<string, unknown>>;
    expect(links.map((l) => l.externalId)).toEqual(['rc-bob']);
  });

  it("refuses to unlink a link that is not the caller's", async () => {
    directory.set(key(RC_A, 'rc-alice'), {
      externalId: 'rc-alice',
      username: 'alice.rc',
      email: ctx.alice.email,
    });
    await confirm(ctx.projectA, ctx.alice, 'rc-alice');
    const out = await call('DELETE', `/api/me/speaker-links/rocketchat/${NS_A}/rc-alice`, ctx.bob);
    expect(out.status).toBe(404);
    expect(await linkRowCount()).toBe(1);
  });
});

describe('channels with no directory behind them (criterion 16)', () => {
  it.each([
    ['telegram', 'no implementation yet'],
    ['widget', 'no implementation yet'],
    ['web', 'already carries a Forge userId'],
  ])('refuses %s by name', async (source, phrase) => {
    const out = await call(
      'POST',
      `/api/projects/${ctx.projectA}/speaker-links/proposals`,
      ctx.alice,
      {
        source,
        externalId: 'whatever',
      },
    );
    expect(out.status).toBe(404);
    expect(out.json.code).toBe('SPEAKER_DIRECTORY_UNSUPPORTED');
    expect(out.json.error).toContain(phrase);
  });

  it('refuses an address the channel does not report', async () => {
    directory.set(key(RC_A, 'rc-mute'), { externalId: 'rc-mute', username: 'mute', email: null });
    const out = await propose(ctx.projectA, ctx.alice, 'rc-mute');
    expect(out.json.code).toBe('SPEAKER_EMAIL_ABSENT');
  });
});
