/**
 * The one secret door (ISS-1348, ISS-1346), from epod's thread of 19/11: the master needed a
 * production OAuth secret, the room agent could only link a testing profile's slot, named a settings
 * screen in prose, and the owner pasted the secret in chat.
 *
 * Held here, in forge's shared operations room:
 * - support.secret_link names a variable { environment, key }, a testing profile's slot or an
 *   integration's credential, and core builds the link to that one field; a variable not held yet
 *   opens as a new one; each kind refuses by name what the project does not declare (c1);
 * - it names another project of the room's reach with `project`, and refuses one outside it
 *   (ISS-1346 c1, c2, c3);
 * - with presign, a one-time write URL sets the slot once: a second use, a use past its time, a GET
 *   and an empty body are each refused by name, and the use is kept by fingerprint (c2);
 * - the thread that asked is told by fingerprint once the slot holds a value, through the write URL
 *   or the page, and the value is nowhere in the room's record, the audit or the outbox (c3);
 * - a secret pasted in a thread that asked for a slot is answered with that slot's link and a fresh
 *   write command (c4);
 * - the project's Secrets page lists each request first with why, its shape and who it was for, a
 *   slot already held reads so with when and by whom, every secret is grouped by what uses it with no
 *   value and no secret:// label, and the page mints a request's one-time write URL (c6 to c9).
 * Every value is an obvious fake planted for the test.
 *
 * @direct-test-of packages/core/src/support/secret-link.ts
 * @direct-test-of packages/core/src/support/secret-slots.ts
 * @direct-test-of packages/core/src/support/secret-write.ts
 * @direct-test-of packages/core/src/support/secret-receipts.ts
 * @direct-test-of packages/core/src/support/secret-flag.ts
 * @direct-test-of packages/core/src/project-config/variables-grant.ts
 * @direct-test-of packages/core/src/project-config/secret-fills.ts
 * @direct-test-of packages/core/src/support/secret-page.ts
 * @direct-test-of packages/core/src/support/secret-page-slots.ts
 * @direct-test-of packages/core/src/support/secret-page-routes.ts
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

describe('ISS-1346: the secret link names a project of the room’s reach', () => {
  it('opens the sibling’s settings at its declared slot, keeps the room’s own when none is named, and refuses one outside', async () => {
    const thread = await threadOf('sid-desk cần key mail-support cho stg'); // i18n-allow: "sid-desk needs the mail-support key for stg"
    const ask = (project?: string) =>
      secretLink(room, {
        thread,
        why: 'Tests read support mail as this mailbox',
        kind: 'testing',
        profile: 'stg',
        service: 'mail-support',
        shape: 'mailbox',
        ...(project ? { project } : {}),
      });
    // planted on today's code: the link was the room's own project's, which declares no stg
    const named = linkOf(await ask(sibling.slug));
    expect(named.project).toBe(sibling.slug);
    expect(new URL(named.link).pathname).toBe(`/projects/${sibling.slug}/settings`);
    expect(new URL(named.link).searchParams.get('tab')).toBe('secrets');
    // the sibling's master stored the mailbox before anyone asked: the request opens on that
    expect(named.held).toBe(true);
    expect(codeOf(await ask())).toBe('SUPPORT_SECRET_PROFILE_UNKNOWN');
    expect(codeOf(await ask('no-such-project'))).toBe('OPS_OUT_OF_SCOPE');
  });
});

describe('ISS-1348: one secret act for every kind of slot', () => {
  let thread = '';
  let asked: SecretLink;

  it('links a production variable not held yet to its field, and refuses each kind by name (c1)', async () => {
    thread = await threadOf('Cần GOOGLE_CLIENT_SECRET cho production'); // i18n-allow: "need GOOGLE_CLIENT_SECRET for production"
    asked = linkOf(
      await secretLink(room, {
        thread,
        why: 'Driver sign-in with Google needs it before the release',
        kind: 'variable',
        environment: 'production',
        key: 'GOOGLE_CLIENT_SECRET',
        example: 'GOCSPX-…',
        presign: true,
      }),
    );
    const link = new URL(asked.link);
    expect(link.pathname).toBe(`/projects/${own.slug}/settings`);
    // the link lands on the request it recorded, on the one Secrets page
    const [recorded] = await rows<{ id: string; why: string; example: string }>(
      sql`SELECT id, why, example FROM support_secret_asks WHERE thread = ${thread} ORDER BY created_at LIMIT 1`,
    );
    expect(link.search).toBe(`?tab=secrets&ask=${recorded?.id}`);
    expect(recorded).toMatchObject({
      why: 'Driver sign-in with Google needs it before the release',
      example: 'GOCSPX-…',
    });
    expect(asked).toMatchObject({ kind: 'variable', held: false, project: own.slug });
    expect(asked.write).toMatchObject({ method: 'PUT', minutes: 15 });
    expect(asked.write?.command).toContain(`curl -X PUT --data-binary @`);

    const why = 'Errors reach Sentry from every environment';
    const every = linkOf(
      await secretLink(room, {
        thread,
        why,
        kind: 'variable',
        environment: null,
        key: 'SENTRY_DSN',
      }),
    );
    expect(new URL(every.link).searchParams.get('tab')).toBe('secrets');
    expect(every.write).toBeUndefined();
    const connection = linkOf(
      await secretLink(room, { thread, why, kind: 'integration', provider: 'rocketchat' }),
    );
    expect(new URL(connection.link).searchParams.get('tab')).toBe('secrets');
    expect(connection.slot.connection).toBe(w.rcConnectionId);

    const refused = await Promise.all(
      [
        { kind: 'variable' as const, environment: 'qa', key: 'K' },
        { kind: 'variable' as const, key: 'K' },
        { kind: 'variable' as const, environment: null, key: 'K', profile: 'stg' },
        { kind: 'testing' as const, environment: null },
        { kind: 'integration' as const, provider: 'sentry' },
      ].map((slot) => secretLink(room, { thread, why, ...slot })),
    );
    expect(refused.map(codeOf)).toEqual([
      'SUPPORT_SECRET_ENVIRONMENT_UNKNOWN',
      'SUPPORT_SECRET_SLOT_SHAPE',
      'SUPPORT_SECRET_SLOT_SHAPE',
      'SUPPORT_SECRET_SLOT_SHAPE',
      'SUPPORT_SECRET_INTEGRATION_UNKNOWN',
    ]);
  });

  it('refuses an asking line that holds a secret itself, as a person reads it on the page (c1)', async () => {
    const leaked = await secretLink(room, {
      thread,
      why: `use password: ${VALUE}`,
      kind: 'variable',
      environment: 'production',
      key: 'K',
    });
    expect(codeOf(leaked)).toBe('SUPPORT_SECRET_ASK_HOLDS_SECRET');
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
        why: 'late',
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
});

describe('ISS-1348: a pasted secret is answered with its slot’s door', () => {
  it('answers a secret pasted in a thread that asked for a slot with its link and a fresh command (c4)', async () => {
    const opened = await threadOf('Cần STRIPE_KEY cho staging'); // i18n-allow: "need STRIPE_KEY for staging"
    const stripe = linkOf(
      await secretLink(room, {
        thread: opened,
        why: 'Card payments on staging',
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

describe('ISS-1348: one Secrets page, requests first (owner’s ruling of 19/11)', () => {
  type Held = { at: string; by: string | null; via: string | null } | null;
  type Slot = { anchor: string; label: string; detail: string; held: Held; form: { kind: string } };
  type Read = {
    requests: {
      id: string;
      askIds: string[];
      why: string;
      example: string | null;
      askedFor: string | null;
      slot: Slot;
      filled: Held;
    }[];
    groups: { kind: string; name: string | null; usedIn: string[]; slots: Slot[] }[];
  };
  const page = async (project: string) => {
    const res = await api(w.owner, 'GET', `/api/projects/${project}/support/secrets`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as unknown as Read;
  };

  it('lists what is waiting first, says who filled the rest and how, and holds no value (c6, c8)', async () => {
    const read = await page(w.projectId);
    const labels = read.requests.map((r) => r.slot.label);
    // STRIPE_KEY waits; GOOGLE_CLIENT_SECRET was set by its command, SENTRY_DSN on its page
    expect(labels[0]).toBe('Stripe key');
    expect(read.requests[0]).toMatchObject({
      why: 'Card payments on staging',
      askedFor: chat.alice.username,
      filled: null,
      slot: { detail: 'STRIPE_KEY', held: null, form: { kind: 'value' } },
    });
    const google = read.requests.find((r) => r.slot.detail === 'GOOGLE_CLIENT_SECRET');
    expect(google?.slot.label).toBe('Google client secret');
    expect(google?.slot.held).toMatchObject({ by: null, via: 'presigned' });
    // the pasted secret's note made a second ask of the same slot: one request, both its asks
    expect(read.requests[0]?.askIds.length).toBeGreaterThan(1);
    const sentry = read.requests.find((r) => r.slot.detail === 'SENTRY_DSN');
    const [owner] = await rows<{ name: string }>(
      sql`SELECT coalesce(display_name, split_part(email, '@', 1)) AS name FROM users WHERE id = ${w.ownerId}::uuid`,
    );
    expect(sentry?.slot.held).toMatchObject({ by: owner?.name, via: 'page' });
    expect(sentry?.filled).toMatchObject({ by: owner?.name, via: 'page' });

    // grouped by what uses each: the app per environment; no value, and no secret:// as a label
    const app = read.groups.filter((g) => g.kind === 'app').map((g) => g.name);
    expect(app).toEqual(['staging', 'production', null]);
    const text = JSON.stringify(read);
    for (const value of [VALUE, VALUE_PAGE]) expect(text).not.toContain(value);
    for (const s of read.groups.flatMap((g) => g.slots)) expect(s.label).not.toMatch(/secret:\/\//);
  });

  it('opens a request for a slot already held on that state, with the shape it asked for (c8, c7)', async () => {
    const read = await page(sibling.id);
    const [mailbox] = read.requests;
    expect(mailbox?.slot).toMatchObject({
      label: 'Mail support',
      detail: 'stg · mail-support',
      form: { kind: 'fields' },
    });
    expect(mailbox?.slot.held).not.toBeNull();
    const testing = read.groups.find((g) => g.kind === 'testing');
    expect(testing).toMatchObject({ name: 'stg', usedIn: ['staging'] });
  });

  it('mints a request’s one-time write URL for a person, once per ask, and refuses a filled or unknown one (c7)', async () => {
    const read = await page(w.projectId);
    const stripe = read.requests[0];
    const minted = await api(
      w.owner,
      'POST',
      `/api/projects/${w.projectId}/support/secrets/requests/${stripe?.id}/write-url`,
    );
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    expect(minted.body).toMatchObject({ method: 'PUT', minutes: 15 });
    const set = await hit(String(minted.body.url), 'PUT', VALUE);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(await hit(String(minted.body.url), 'PUT', VALUE)).toMatchObject({
      code: 'SUPPORT_SECRET_WRITE_USED',
    });
    await settleOutbox();
    const filled = (await page(w.projectId)).requests.find((r) => r.slot.detail === 'STRIPE_KEY');
    expect(filled?.slot.held).toMatchObject({ via: 'presigned' });

    const again = await api(
      w.owner,
      'POST',
      `/api/projects/${w.projectId}/support/secrets/requests/${stripe?.id}/write-url`,
    );
    expect(again.body).toMatchObject({ error: { code: 'SUPPORT_SECRET_ASK_FILLED' } });
    const unknown = await api(
      w.owner,
      'POST',
      `/api/projects/${w.projectId}/support/secrets/requests/${sibling.id}/write-url`,
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: { code: 'SUPPORT_SECRET_ASK_UNKNOWN' } });
  });
});
