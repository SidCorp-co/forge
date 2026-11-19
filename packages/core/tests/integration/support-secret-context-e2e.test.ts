/**
 * A secret sent in a room (ISS-1326, ISS-1328), from the Catalog-AdminHub thread of 18/11: the owner
 * sent "Secret: <key>", which was filtered, then the same key alone, a bare 32-character hex string,
 * which reached the session unfiltered, since a bare key has neither label nor known prefix and
 * record ids, uuids and shas share its shape (ISS-614). The session was then told on every secret to
 * ask for the message's deletion, and asked again, plus a rotation, after the owner had declined.
 *
 * Held here: a token sent alone right after a filtered secret in its thread, or after its writer
 * said a key is coming, is filtered with the note; a sha sent alone in a thread about a commit is
 * not. The note on a thread's first secret says it once, names the credential door and asks the
 * deletion at most once; a later secret in that thread is told as already said, with no deletion
 * and no rotation ask. support.secret_link answers the Testing settings link of one declared slot,
 * and refuses by name a profile or slot the project does not declare.
 *
 * ISS-1353: a password written under a Vietnamese label, and an email and password pair answering a
 * thread that asked for a login, are each kept scrubbed and flagged; an email alone is kept as written.
 * A secret the screen did not catch is redacted on the record through a door naming its action.
 *
 * @direct-test-of packages/core/src/support/secret-flag.ts
 * @direct-test-of packages/core/src/support/secret-screen.ts
 * @direct-test-of packages/core/src/support/secret-redact.ts
 * @direct-test-of packages/core/src/support/secret-link.ts
 * @direct-test-of packages/core/src/support/inbound.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { type Act, ChannelWorld, code } from '../helpers/support-channel.js';
import type { Member, TurnMessage } from '../helpers/support-world.js';

const w = new ChannelWorld();
// obvious fakes, built here so no literal key sits in the tree
const KEY = 'a1b2c3d4e5f60718'.repeat(2);
const KEY_TWO = '0f1e2d3c4b5a6978'.repeat(2);
const SHA = '3f2a9c1b'.repeat(5);
const DECLINED = 'không cần xóa'; // i18n-allow: the owner's words on 18/11, "no need to delete"

beforeAll(async () => {
  await w.open();
  const carol = await w.confirm('carol', {
    roles: ['technical'],
    askFor: 'deleting chat messages',
  });
  expect(carol.status, JSON.stringify(carol.body)).toBe(200);
}, 120_000);

afterAll(() => w.stop());

/** Every note core handed the session in `thread`, oldest first. */
const notesIn = (thread: string): TurnMessage[] =>
  w.box.turns.flatMap((t) => t.messages).filter((m) => m.from === 'forge' && m.thread === thread);

/** What the room kept of one member message. */
async function kept(id: string): Promise<string> {
  const [row] = await rows<{ t: string }>(sql`
    SELECT input->>'text' AS t FROM support_actions
     WHERE room_id = ${w.roomId}::uuid AND external_id = ${id} AND kind = 'message_in'`);
  return String(row?.t);
}

async function flagsOf(id: string): Promise<{ told: string }[]> {
  return (
    await rows<{ output: { told: string } }>(sql`
      SELECT output FROM support_actions
       WHERE room_id = ${w.roomId}::uuid AND kind = 'secret_flagged' AND input->>'message' = ${id}`)
  ).map((r) => r.output);
}

/** `who` writes `text` in `thread`, and the room has taken it in. */
async function say(who: Member, text: string, thread?: string): Promise<string> {
  const id = await w.chat.say(who, text, thread);
  await expect.poll(async () => (await kept(id)) !== 'undefined', { timeout: 15_000 }).toBe(true);
  await w.settleWarm();
  return id;
}

describe('ISS-1326: a key sent alone is a secret where its thread says so', () => {
  it('filters the bare key sent right after a labelled one, and tells the thread once (ISS-1328)', async () => {
    // the session gives the link once, on the first note, as its card teaches
    const said: string[] = [];
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from !== 'forge' || !m.text.includes('support.secret_link {')) continue;
        const link = await (act as Act)({
          action: 'secret_link',
          thread: m.thread,
          kind: 'testing',
          profile: 'stg',
          service: 'pgprints',
        });
        said.push(String(link.link ?? code(link)));
      }
    };
    const first = await say(w.chat.bob, `Secret: ${KEY}`);
    expect(await kept(first)).not.toContain(KEY);
    await expect.poll(() => notesIn(first).length, { timeout: 15_000 }).toBe(1);
    // the owner declines the deletion, as on 18/11: core adds no note and asks nothing more
    const declined = await say(w.chat.bob, DECLINED, first);
    expect(await kept(declined)).toBe(DECLINED);
    expect(notesIn(first)).toHaveLength(1);

    const bare = await say(w.chat.bob, KEY, first);
    // planted on today's code: the bare key is kept as written and no note follows
    expect(await kept(bare)).not.toContain(KEY);
    await expect.poll(() => notesIn(first).length, { timeout: 15_000 }).toBe(2);
    expect(await flagsOf(first)).toEqual([{ technical: 'carol', posted: false, told: 'first' }]);
    expect(await flagsOf(bare)).toEqual([{ technical: 'carol', posted: false, told: 'again' }]);

    const [once, again] = notesIn(first).map((n) => n.text);
    // the first note: said once, why, the credential door in the same line, one deletion ask
    expect(once).toContain('Say so once in this thread');
    expect(once).toContain('support.secret_link');
    expect(once).toContain('@carol once to delete');
    expect(once).toContain('settled for this thread');
    expect(once).toContain('Never ask anyone to rotate');
    // the second: already told, no deletion ask, no rotation ask
    expect(again).toContain('already told once');
    expect(again).toContain('ask no deletion and no rotation');
    expect(again).not.toMatch(/to delete that message|@carol/);
    for (const n of [once, again]) expect(n).not.toContain(KEY);
    // the session asked for the link on the first note alone; the profile is not declared here
    expect(said).toEqual(['SUPPORT_SECRET_PROFILE_UNKNOWN']);
    expect(await w.linesIn(first)).toEqual([]);
  });

  it('filters a bare key its writer said was coming', async () => {
    w.box.model = async () => undefined;
    const opened = await say(w.chat.alice, 'Gửi anh secret key của tài khoản test nhé');
    const bare = await say(w.chat.alice, KEY_TWO, opened);
    expect(await kept(bare)).not.toContain(KEY_TWO);
    expect(await flagsOf(bare)).toEqual([{ technical: 'carol', posted: false, told: 'first' }]);
  });

  it('keeps a sha sent alone in a thread about a commit as written (ISS-614 holds)', async () => {
    w.box.model = async () => undefined;
    const opened = await say(w.chat.alice, 'Please review the commit that fixed the export');
    const sha = await say(w.chat.alice, SHA, opened);
    expect(await kept(sha)).toBe(SHA);
    expect(await flagsOf(sha)).toEqual([]);
    expect(notesIn(opened)).toEqual([]);
  });
});

describe('ISS-1353: account credentials written in chat are kept scrubbed and flagged', () => {
  // obvious fakes, built here so no literal credential sits in the tree
  const PASS = ['Fake', 'Pass', '0042'].join('-');
  const EMAIL = 'qa-tester@example.test';

  it('filters a Vietnamese-labelled password', async () => {
    w.box.model = async () => undefined;
    const said = await say(w.chat.alice, `Mật khẩu: ${PASS}`); // i18n-allow: the label under test
    expect(await kept(said)).not.toContain(PASS);
    expect(await kept(said)).toContain('[Filtered]');
    expect(await flagsOf(said)).toHaveLength(1);
  });

  it('filters a bare email and password answering a thread that asked for a test login', async () => {
    w.box.model = async () => undefined;
    const asked = await say(w.chat.bob, 'Cho mình xin tài khoản test để đăng nhập nhé'); // i18n-allow: "give me a test account to sign in"
    const pair = await say(w.chat.alice, `${EMAIL} / ${PASS}`, asked);
    expect(await kept(pair)).toBe(`${EMAIL} / [Filtered]`);
    expect(await flagsOf(pair)).toHaveLength(1);
  });

  it('redacts a secret the screen did not catch through the door that names its action (c2)', async () => {
    w.box.model = async () => undefined;
    // a shape no screen reads: the password said in words of its own, kept as written
    const missed = await say(w.chat.alice, `the code to get in is ${PASS} for now`);
    expect(await kept(missed)).toContain(PASS);
    const [action] = await rows<{ id: string; conversation_id: string }>(sql`
      SELECT id, conversation_id FROM support_actions
       WHERE room_id = ${w.roomId}::uuid AND external_id = ${missed} AND kind = 'message_in'`);
    const door = (id: string, token = w.owner) =>
      api(
        token,
        'POST',
        `/api/projects/${w.projectId}/support/rooms/${w.roomId}/actions/${id}/redaction`,
        {
          reason: 'a test password was kept as written',
        },
      );
    expect((await door(String(action?.id), w.stranger)).status).toBe(403);
    const done = await door(String(action?.id));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ action: action?.id, message: missed, redactedBy: w.ownerId });
    expect(await kept(missed)).toBe('[Filtered]');
    const [message] = await rows<{ content: string }>(sql`
      SELECT content FROM conversation_messages
       WHERE conversation_id = ${action?.conversation_id}::uuid AND external_id = ${missed}`);
    expect(message?.content).toBe('[Filtered]');
    const [record] = await rows<{ by: string; reason: string }>(sql`
      SELECT output->>'by' AS by, input->>'reason' AS reason FROM support_actions
       WHERE room_id = ${w.roomId}::uuid AND kind = 'secret_redacted'
         AND input->>'action' = ${String(action?.id)}`);
    expect(record).toEqual({ by: w.ownerId, reason: 'a test password was kept as written' });
    const again = await door(String(action?.id));
    expect([again.status, code(again.body as Record<string, unknown>)]).toEqual([
      409,
      'SUPPORT_ACTION_REDACTED',
    ]);
    const unknown = await door('00000000-0000-4000-8000-000000000000');
    expect([unknown.status, code(unknown.body as Record<string, unknown>)]).toEqual([
      404,
      'SUPPORT_ACTION_UNKNOWN',
    ]);
  });

  it('keeps an email alone as written, with no flag', async () => {
    w.box.model = async () => undefined;
    const asked = await say(w.chat.bob, 'Which account should I sign in with?');
    const email = await say(w.chat.alice, `use ${EMAIL}`, asked);
    expect(await kept(email)).toBe(`use ${EMAIL}`);
    expect(await flagsOf(email)).toEqual([]);
  });
});

describe('ISS-1328: support.secret_link answers the link of one declared slot', () => {
  it('links the Testing settings at the slot, and refuses by name what the project does not declare', async () => {
    const put = (path: string, body: unknown) =>
      api(w.owner, 'PUT', `/api/projects/${w.projectId}${path}`, body);
    // a profile names only stored values: the master declares a slot before its value is given
    for (const name of ['supplier', 'pgprints']) {
      const stored = await put(`/secrets/stg/${name}`, { value: 'placeholder-not-a-key' });
      expect(stored.status, JSON.stringify(stored.body)).toBe(200);
    }
    const variable = await api(w.owner, 'POST', `/api/projects/${w.projectId}/variables`, {
      key: 'DATABASE_URL',
      value: 'postgres://example.test/stg',
      environment: null,
      type: 'plain',
      protected: false,
    });
    expect(variable.status, JSON.stringify(variable.body)).toBeLessThan(300);
    const profile = await put('/testing-profiles/stg', {
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
        version: 1,
        id: 'stg',
        actors: { supplier: { role: 'project-member', credential: 'secret://stg/supplier' } },
        services: {
          pgprints: { access: 'readwrite', credential: 'secret://stg/pgprints' },
          db: { access: 'readonly', credential: 'var://DATABASE_URL' },
        },
        limits: [],
      },
    });
    expect(profile.status, JSON.stringify(profile.body)).toBeLessThan(300);
    const [{ slug }] = (await rows<{ slug: string }>(
      sql`SELECT slug FROM projects WHERE id = ${w.projectId}::uuid`,
    )) as [{ slug: string }];

    const answers: Record<string, unknown>[] = [];
    const tries: Record<string, unknown>[] = [
      { profile: 'stg', service: 'pgprints' },
      { profile: 'stg', actor: 'supplier' },
      { profile: 'prod', service: 'pgprints' },
      { profile: 'stg', service: 'stripe' },
      { profile: 'stg', service: 'db' },
      { profile: 'stg' },
      { profile: 'stg', actor: 'supplier', service: 'pgprints' },
      // a name the slot regex takes that an object's prototype also answers
      { profile: 'stg', actor: 'constructor' },
      { profile: 'stg', service: 'toString' },
    ];
    await w.ask(w.chat.bob, 'Mình gửi key PGPrints test thế nào?', async (m, act) => {
      for (const t of tries)
        answers.push(await act({ action: 'secret_link', thread: m.thread, kind: 'testing', ...t }));
      return undefined;
    });
    const [service, actor, ...refused] = answers;
    expect(service).toMatchObject({
      link: expect.stringMatching(
        new RegExp(
          `/projects/${slug}/settings\\?tab=testing&profile=stg&service=pgprints#profile-stg$`,
        ),
      ),
      kind: 'testing',
      slot: { profile: 'stg', service: 'pgprints' },
    });
    expect(String(service?.says)).toContain('never ask anyone to rotate it');
    expect(actor).toMatchObject({ slot: { actor: 'supplier' } });
    expect(String(actor?.link)).toContain('profile=stg&actor=supplier');
    expect(refused.map(code)).toEqual([
      'SUPPORT_SECRET_PROFILE_UNKNOWN',
      'SUPPORT_SECRET_SLOT_UNKNOWN',
      'SUPPORT_SECRET_SLOT_VARIABLE',
      'SUPPORT_SECRET_SLOT_ONE',
      'SUPPORT_SECRET_SLOT_ONE',
      'SUPPORT_SECRET_SLOT_UNKNOWN',
      'SUPPORT_SECRET_SLOT_UNKNOWN',
    ]);
    expect(JSON.stringify(refused[1])).toContain(
      'declares no service stripe; it declares actor supplier, service db, service pgprints',
    );
  });
});
