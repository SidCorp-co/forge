/**
 * The one secret door (ISS-1348), from epod's thread of 19/11: the master needed a
 * production OAuth secret, the room agent could only link a testing profile's slot, named a settings
 * screen in prose, and the owner pasted the secret in chat.
 *
 * Held here, in forge's shared operations room:
 * - support.secret_link names a variable { environment, key }, a testing profile's slot or an
 *   integration's credential, and core builds the link to that one field; a variable not held yet
 *   opens as a new one; each kind refuses by name what the project does not declare (c1);
 * - with presign, a one-time write URL sets the slot once: a second use, a use past its time, a GET
 *   and an empty body are each refused by name, and the use is kept by fingerprint (c2);
 * - the thread that asked is told by fingerprint once the slot holds a value, through the write URL
 *   or the page, and the value is nowhere in the room's record, the audit or the outbox (c3);
 * - a secret pasted in a thread that asked for a slot is answered with that slot's link and a fresh
 *   write command (c4).
 * Every value is an obvious fake planted for the test.
 *
 * @direct-test-of packages/core/src/support/secret-link.ts
 * @direct-test-of packages/core/src/support/secret-slots.ts
 * @direct-test-of packages/core/src/support/secret-write.ts
 * @direct-test-of packages/core/src/support/secret-receipts.ts
 * @direct-test-of packages/core/src/support/secret-flag.ts
 * @direct-test-of packages/core/src/project-config/variables-grant.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
});

import { app } from '../../src/index.js';
import { type SecretLink, secretLink } from '../../src/support/secret-link.js';
import { type RoomRow, roomsOfProject } from '../../src/support/store.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { createTestProject, rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const w = new SupportWorld();
let chat: StandInRocketChat;
let room: RoomRow;
const own = { slug: '' };
const sibling = { id: '', slug: '' };
// obvious fakes, built here so no literal secret sits in the tree
const VALUE = ['fake', 'oauth', 'client', 'secret', '0001'].join('-');
const VALUE_PAGE = ['fake', 'page', 'secret', '0002'].join('-');
const PASTED = ['fake', 'pasted', '0003', 'Zq'].join('-');

type Outcome =
  | { ok: true; value: SecretLink }
  | { ok: false; refusals: { code: string; detail: string }[] };
const codeOf = (o: Outcome) => (o.ok ? null : o.refusals[0]?.code);
const linkOf = (o: Outcome): SecretLink => {
  if (!o.ok) throw new Error(JSON.stringify(o.refusals));
  return o.value;
};

/** A thread a member opened in the room, taken in. */
async function threadOf(text: string): Promise<string> {
  const id = await chat.say(chat.alice, text);
  await expect
    .poll(
      async () => (await rows(sql`SELECT 1 FROM support_actions WHERE external_id = ${id}`)).length,
      {
        timeout: 15_000,
      },
    )
    .toBe(1);
  await w.settleWarm();
  return id;
}

/** A PUT, GET or other request to a write URL, as curl sends a file's bytes. */
async function hit(url: string, method: string, body?: string) {
  const res = await app.fetch(
    new Request(`http://forge.test${new URL(url).pathname}`, {
      method,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'curl/8.5.0' },
      ...(body === undefined ? {} : { body }),
    }),
  );
  const parsed = (await res.json().catch(() => ({}))) as { error?: { code?: string } } & Record<
    string,
    unknown
  >;
  return { status: res.status, code: parsed.error?.code, body: parsed };
}

/** Every note core handed the session in `thread`, oldest first. */
async function notesIn(thread: string): Promise<string[]> {
  return (
    await rows<{ note: string }>(sql`
      SELECT input->>'note' AS note FROM support_actions
       WHERE room_id = ${room.id}::uuid AND thread = ${thread} AND kind = 'message_in' AND actor_kind = 'core'
       ORDER BY created_at`)
  ).map((r) => r.note);
}

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  [{ slug: own.slug } = { slug: '' }] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  const [org] = await rows<{ org_id: string }>(
    sql`SELECT org_id FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  const other = await createTestProject(w.ownerId, { orgId: String(org?.org_id) });
  Object.assign(sibling, { id: other.id, slug: other.slug });
  const rc = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Babo',
    config: {
      serverUrl: chat.serverUrl,
      role: { name: 'babo', persona: 'You are Babo. You coordinate Forge.', grants: ['read'] },
    },
    secrets: { authToken: chat.bot.authToken, userId: chat.bot.userId },
    bindings: [
      {
        projectId: w.projectId,
        role: 'service',
        target: { provider: 'rocketchat', rids: [chat.rid], operations: { scope: 'forge' } },
      },
    ],
  });
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  w.rcConnectionId = String((rc.body.connection as { id: string }).id);
  await settleOutbox();
  const { startRocketChatManager } = await import('../../src/integrations/rocketchat/index.js');
  await startRocketChatManager();
  await w.settleWarm();
  const [declared] = await roomsOfProject(w.projectId);
  if (!declared) throw new Error('the operations room was not declared');
  room = declared;
  for (const project of [w.projectId, sibling.id]) {
    await seedProjectDocument(project, w.ownerId, {
      defaultBranch: 'main',
      promotions: [{ from: 'dev', to: 'main', via: 'merge' }],
      environments: {
        staging: {
          tier: 'staging',
          deploysFrom: 'dev',
          deployment: { mode: 'external' },
          url: 'https://stg.example.test',
          ...(project === sibling.id ? { testing: 'stg' } : {}),
        },
        production: {
          tier: 'production',
          deploysFrom: 'main',
          deployment: { mode: 'external' },
          url: 'https://example.test',
        },
      },
    });
  }
  // the sibling's master declared a testing slot before any value was given (FB-756's sid-desk)
  const sib = (path: string, body: unknown) =>
    api(w.owner, 'PUT', `/api/projects/${sibling.id}${path}`, body);
  const slot = await sib('/secrets/stg/mail-support', { value: 'placeholder-not-a-key' });
  expect(slot.status, JSON.stringify(slot.body)).toBe(200);
  const profile = await sib('/testing-profiles/stg', {
    baseRevision: null,
    document: {
      $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
      version: 1,
      id: 'stg',
      actors: {},
      services: {
        'mail-support': { access: 'readwrite', credential: 'secret://stg/mail-support' },
      },
      limits: [],
    },
  });
  expect(profile.status, JSON.stringify(profile.body)).toBeLessThan(300);
}, 180_000);

afterAll(() => w.stop());

describe('ISS-1348: one secret act for every kind of slot', () => {
  let thread = '';
  let asked: SecretLink;

  it('links a production variable not held yet to its field, and refuses each kind by name (c1)', async () => {
    thread = await threadOf('Cần GOOGLE_CLIENT_SECRET cho production'); // i18n-allow: "need GOOGLE_CLIENT_SECRET for production"
    asked = linkOf(
      await secretLink(room, {
        thread,
        kind: 'variable',
        environment: 'production',
        key: 'GOOGLE_CLIENT_SECRET',
        presign: true,
      }),
    );
    const link = new URL(asked.link);
    expect(link.pathname).toBe(`/projects/${own.slug}/settings`);
    expect(link.search).toBe('?tab=variables&key=GOOGLE_CLIENT_SECRET&environment=production');
    expect(link.hash).toBe('#variables');
    expect(asked).toMatchObject({ kind: 'variable', held: false, project: own.slug });
    expect(asked.write).toMatchObject({ method: 'PUT', minutes: 15 });
    expect(asked.write?.command).toContain(`curl -X PUT --data-binary @`);

    const every = linkOf(
      await secretLink(room, { thread, kind: 'variable', environment: null, key: 'SENTRY_DSN' }),
    );
    expect(new URL(every.link).search).toBe('?tab=variables&key=SENTRY_DSN&environment=*');
    expect(every.write).toBeUndefined();
    const connection = linkOf(
      await secretLink(room, { thread, kind: 'integration', provider: 'rocketchat' }),
    );
    expect(new URL(connection.link).pathname).toBe('/integrations');
    expect(new URL(connection.link).searchParams.get('connection')).toBe(w.rcConnectionId);

    const refused = await Promise.all(
      [
        { kind: 'variable' as const, environment: 'qa', key: 'K' },
        { kind: 'variable' as const, key: 'K' },
        { kind: 'variable' as const, environment: null, key: 'K', profile: 'stg' },
        { kind: 'testing' as const, environment: null },
        { kind: 'integration' as const, provider: 'sentry' },
      ].map((slot) => secretLink(room, { thread, ...slot })),
    );
    expect(refused.map(codeOf)).toEqual([
      'SUPPORT_SECRET_ENVIRONMENT_UNKNOWN',
      'SUPPORT_SECRET_SLOT_SHAPE',
      'SUPPORT_SECRET_SLOT_SHAPE',
      'SUPPORT_SECRET_SLOT_SHAPE',
      'SUPPORT_SECRET_INTEGRATION_UNKNOWN',
    ]);
  });

  it('sets the slot once through the write URL and refuses reuse, expiry, a read and an empty body (c2)', async () => {
    const url = String(asked.write?.url);
    expect(await hit(url, 'GET')).toMatchObject({ status: 403, code: 'SUPPORT_SECRET_WRITE_ONLY' });
    expect(await hit(url, 'PUT', '\n')).toMatchObject({
      status: 400,
      code: 'SUPPORT_SECRET_WRITE_EMPTY',
    });
    // a file's closing newline is the file's: the empty PUT gave its claim back, and this one sets it
    const set = await hit(url, 'PUT', `${VALUE}\n`);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(JSON.stringify(set.body)).not.toContain(VALUE);
    expect(await hit(url, 'PUT', VALUE)).toMatchObject({
      status: 409,
      code: 'SUPPORT_SECRET_WRITE_USED',
    });
    expect(await hit(`${url.slice(0, -4)}AAAA`, 'PUT', VALUE)).toMatchObject({
      status: 404,
      code: 'SUPPORT_SECRET_WRITE_UNKNOWN',
    });

    const listed = await api(w.owner, 'GET', `/api/projects/${w.projectId}/variables`);
    const variable = (listed.body.variables as Record<string, unknown>[]).find(
      (v) => v.key === 'GOOGLE_CLIENT_SECRET',
    );
    // created a secret, protected, as a production value reaches production alone
    expect(variable).toMatchObject({
      environment: 'production',
      type: 'secret',
      protected: true,
      fingerprint: set.body.fingerprint,
    });
    const [event] = await rows<{
      actor_id: string | null;
      new_fingerprint: string;
      detail: Record<string, unknown>;
    }>(sql`
      SELECT actor_id, new_fingerprint, detail FROM project_variable_events
       WHERE project_id = ${w.projectId}::uuid AND key = 'GOOGLE_CLIENT_SECRET'`);
    expect(event).toMatchObject({
      actor_id: null,
      new_fingerprint: set.body.fingerprint,
      detail: { via: 'presigned', from: 'direct curl/8.5.0' },
    });
    const [use] = await rows<{ write_used_at: Date | null; write_used_from: string }>(sql`
      SELECT write_used_at, write_used_from FROM support_secret_asks WHERE thread = ${thread} AND write_hash IS NOT NULL`);
    expect(use?.write_used_at).not.toBeNull();
    expect(use?.write_used_from).toBe('direct curl/8.5.0');

    const late = linkOf(
      await secretLink(room, {
        thread,
        kind: 'variable',
        environment: 'staging',
        key: 'LATE',
        presign: true,
      }),
    );
    await rows(
      sql`UPDATE support_secret_asks SET write_expires_at = now() - interval '1 minute' WHERE slot_key LIKE '%:staging:LATE'`,
    );
    expect(await hit(String(late.write?.url), 'PUT', VALUE)).toMatchObject({
      status: 409,
      code: 'SUPPORT_SECRET_WRITE_EXPIRED',
    });
  });

  it('tells the asking thread by fingerprint, through the write URL and the page, and keeps the value nowhere (c3)', async () => {
    await settleOutbox();
    const [fingerprint] = await rows<{ f: string }>(sql`
      SELECT fingerprint AS f FROM project_variables WHERE project_id = ${w.projectId}::uuid AND key = 'GOOGLE_CLIENT_SECRET'`);
    await expect
      .poll(
        async () => (await notesIn(thread)).filter((n) => n.includes('now holds a value')).length,
      )
      .toBe(1);
    const [told] = (await notesIn(thread)).filter((n) => n.includes('now holds a value'));
    expect(told).toContain('variable GOOGLE_CLIENT_SECRET at environment production');
    expect(told).toContain('the one-time write URL');
    expect(told).toContain(`fingerprint ${fingerprint?.f}`);

    // the page: a person adds the variable the thread asked for, every environment
    const page = await api(w.owner, 'POST', `/api/projects/${w.projectId}/variables`, {
      key: 'SENTRY_DSN',
      value: VALUE_PAGE,
      environment: null,
      type: 'secret',
      protected: false,
    });
    expect(page.status, JSON.stringify(page.body)).toBe(201);
    await settleOutbox();
    await expect
      .poll(
        async () => (await notesIn(thread)).filter((n) => n.includes('its page in Forge')).length,
      )
      .toBe(1);

    for (const value of [VALUE, VALUE_PAGE]) {
      const kept = await rows(sql`
        SELECT 1 FROM support_actions WHERE room_id = ${room.id}::uuid AND (input::text LIKE ${`%${value}%`} OR output::text LIKE ${`%${value}%`})
        UNION ALL SELECT 1 FROM project_variable_events WHERE detail::text LIKE ${`%${value}%`}
        UNION ALL SELECT 1 FROM pipeline_outbox WHERE payload::text LIKE ${`%${value}%`}
        UNION ALL SELECT 1 FROM conversation_messages WHERE content LIKE ${`%${value}%`}`);
      expect(kept).toEqual([]);
    }
  });

  it('answers a secret pasted in a thread that asked for a slot with its link and a fresh command (c4)', async () => {
    const opened = await threadOf('Cần STRIPE_KEY cho staging'); // i18n-allow: "need STRIPE_KEY for staging"
    const stripe = linkOf(
      await secretLink(room, {
        thread: opened,
        kind: 'variable',
        environment: 'staging',
        key: 'STRIPE_KEY',
      }),
    );
    const pasted = await chat.say(chat.alice, `Secret: ${PASTED}`, opened);
    await expect
      .poll(async () => (await notesIn(opened)).filter((n) => n.includes('held a secret')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const [note] = (await notesIn(opened)).filter((n) => n.includes('held a secret'));
    expect(note).toContain(stripe.link);
    expect(note).toMatch(
      /curl -X PUT --data-binary @<file holding the value> '[^']+\/api\/secret-writes\/[A-Za-z0-9_-]{43}'/,
    );
    expect(note).not.toContain(PASTED);
    expect(pasted).toBeTruthy();
  });
});
