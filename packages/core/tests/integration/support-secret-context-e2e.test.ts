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
 * and no rotation ask. support.secret_link answers the Secrets page link of one declared slot's
 * request (ISS-1348), and refuses by name a profile or slot the project does not declare.
 *
 * ISS-1353: a password written under a Vietnamese label, and an email and password pair answering a
 * thread that asked for a login, are each kept scrubbed and flagged; an email alone is kept as written.
 * A secret the screen did not catch is redacted on the record through a door naming its action.
 *
 * ISS-1372 (AdminHub thread of 20/11): the owner's production token was dropped as [Filtered] and he
 * was asked to delete his message. Held here: what a project admin hands over is kept in the bound
 * project's vault and read by its master at the acting door, audited; a non-admin's waits pending for
 * a day, until a project admin approves or discards it; the record and transcript read
 * [Secret kept: <name>]; the value is in no row, log line or prompt; nobody is asked to delete.
 *
 * @direct-test-of packages/core/src/support/secret-flag.ts
 * @direct-test-of packages/core/src/support/secret-screen.ts
 * @direct-test-of packages/core/src/support/secret-redact.ts
 * @direct-test-of packages/core/src/support/secret-link.ts
 * @direct-test-of packages/core/src/support/inbound.ts
 * @direct-test-of packages/core/src/support/secret-keep.ts
 * @direct-test-of packages/core/src/project-config/kept-secrets.ts
 * @direct-test-of packages/core/src/project-config/kept-secret-routes.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { ensureMasterSession } from '../../src/devices/index.js';
import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { type LogLines, recordLogLines } from '../helpers/log-lines.js';
import { type Act, ChannelWorld, code } from '../helpers/support-channel.js';
import type { Member, TurnMessage } from '../helpers/support-world.js';

const w = new ChannelWorld();
/** Every line the process logged, as the logger was handed it (ISS-1372). */
let log: LogLines;
// obvious fakes, built here so no literal key sits in the tree
const KEY = 'a1b2c3d4e5f60718'.repeat(2);
const KEY_TWO = '0f1e2d3c4b5a6978'.repeat(2);
const SHA = '3f2a9c1b'.repeat(5);
const DECLINED = 'không cần xóa'; // i18n-allow: the owner's words on 18/11, "no need to delete"

beforeAll(async () => {
  await w.open();
  // every line logged is recorded, so a planted value can be looked for in all of them (ISS-1372);
  // the world's own spy on errors keeps doing what it did, the recorder calling on to it
  log = recordLogLines();
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
          why: 'The tests call PGPrints with it',
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
    expect(await flagsOf(first)).toMatchObject([{ posted: false, told: 'first' }]);
    expect(await flagsOf(bare)).toMatchObject([{ posted: false, told: 'again' }]);

    const [once, again] = notesIn(first).map((n) => n.text);
    // each note names what was kept, said once in the reply; nobody is asked to delete (ISS-1372)
    for (const n of [once, again]) {
      expect(n).toContain('secret://kept/');
      expect(n).toContain('Tell the room once, in this same reply');
      expect(n).toContain('Ask nobody to delete the message');
      expect(n).not.toMatch(/@carol|once to delete|settled for this thread/);
      expect(n).not.toContain(KEY);
    }
    // the value was kept, so no slot link is asked for
    expect(said).toEqual([]);
    expect(await w.linesIn(first)).toEqual([]);
  });

  it('tells a bare key sent at the top level after a filtered one there as already said', async () => {
    // a writer of their own, so no earlier top-level message of another test is in the context
    w.box.model = async () => undefined;
    const dave: Member = { userId: 'u-dave', username: 'dave' };
    const KEY_THREE = '9a8b7c6d5e4f3021'.repeat(2);
    const labelled = await say(dave, `Secret: ${KEY_THREE}`);
    await expect.poll(() => notesIn(labelled).length, { timeout: 15_000 }).toBe(1);
    const bare = await say(dave, KEY_THREE);
    expect(await kept(bare)).not.toContain(KEY_THREE);
    expect(await flagsOf(labelled)).toMatchObject([{ posted: false, told: 'first' }]);
    // planted on toldBefore matching the bare key's own id alone: it read 'first'
    expect(await flagsOf(bare)).toMatchObject([{ posted: false, told: 'again' }]);
    await expect.poll(() => notesIn(bare).length, { timeout: 15_000 }).toBe(1);
    const [note] = notesIn(bare).map((n) => n.text);
    expect(note).toContain('secret://kept/');
    expect(note).not.toMatch(/to delete that message|@carol/);
  });

  it('filters a bare key its writer said was coming', async () => {
    w.box.model = async () => undefined;
    const opened = await say(w.chat.alice, 'Gửi anh secret key của tài khoản test nhé');
    const bare = await say(w.chat.alice, KEY_TWO, opened);
    expect(await kept(bare)).not.toContain(KEY_TWO);
    expect(await flagsOf(bare)).toMatchObject([{ posted: false, told: 'first' }]);
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
    expect(await kept(said)).toMatch(/\[Secret kept: mat-khau-[0-9a-f]{6}\]/);
    expect(await flagsOf(said)).toHaveLength(1);
  });

  it('filters a bare email and password answering a thread that asked for a test login', async () => {
    w.box.model = async () => undefined;
    const asked = await say(w.chat.bob, 'Cho mình xin tài khoản test để đăng nhập nhé'); // i18n-allow: "give me a test account to sign in"
    const pair = await say(w.chat.alice, `${EMAIL} / ${PASS}`, asked);
    expect(await kept(pair)).toMatch(
      new RegExp(`^${EMAIL} / \\[Secret kept: credential-[0-9a-f]{6}\\]$`),
    );
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

describe('ISS-1372: a credential handed over in a bound room is kept, not dropped', () => {
  // obvious fakes in a production token's shape, built here so no literal token sits in the tree
  const ADMIN_TOKEN = ['fake', 'prod', 'Zq8vN3pL5tR2wX7yK4mB'].join('-');
  const MEMBER_TOKEN = ['fake', 'prod', 'Hd5sQ9wE2rT7yU4iO1pA'].join('-');
  const OTHER_TOKEN = ['fake', 'prod', 'Lm3nB8vC1xZ6aS9dF2gH'].join('-');
  const erin: Member = { userId: 'u-erin', username: 'erin' };
  const frank: Member = { userId: 'u-frank', username: 'frank' };
  const kept = (id: string) =>
    rows<{ t: string }>(sql`
      SELECT input->>'text' AS t FROM support_actions
       WHERE room_id = ${w.roomId}::uuid AND external_id = ${id} AND kind = 'message_in'`).then(
      (r) => String(r[0]?.t),
    );
  type Entry = {
    name: string;
    ref: string;
    state: string;
    message: string;
    label: string;
    kind: string;
    expiresAt: string | null;
    valueAt: string | null;
    from: { admin: boolean; userId: string | null };
  };
  const entryOf = async (message: string): Promise<Entry> => {
    const list = await api(w.owner, 'GET', `/api/projects/${w.projectId}/kept-secrets`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const found = (list.body.kept as Entry[]).find((e) => e.message === message);
    expect(found, JSON.stringify(list.body)).toBeDefined();
    return found as Entry;
  };
  let master = '';

  beforeAll(async () => {
    // erin is the owner's own chat account; frank is a member with no Forge account
    const namespace = new URL(w.chat.serverUrl).host;
    await db.execute(sql`
      INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
      VALUES ('rocketchat', ${namespace}, ${erin.userId}, ${erin.username}, ${w.ownerId}, 'channel_email_match')`);
    await ensureMasterSession({ deviceId: w.box.deviceId, projectId: w.projectId, name: 'master' });
    // the box's own credential, which a master on that box calls under
    master = w.box.token;
  });

  const read = (name: string) =>
    api(master, 'GET', `/api/projects/${w.projectId}/acting-secrets/kept/${name}`);

  it("keeps a project admin's token in the vault, names it in the record and the note, and the master reads it audited (c1, c3, c4)", async () => {
    w.box.model = async () => undefined;
    const id = await say(erin, `AdminHub production token: ${ADMIN_TOKEN}`);
    const entry = await entryOf(id);
    expect(entry).toMatchObject({
      label: 'AdminHub production token',
      kind: 'token',
      state: 'usable',
      expiresAt: null,
      ref: `secret://kept/${entry.name}`,
      from: { admin: true, userId: w.ownerId },
    });
    expect(entry.name).toMatch(/^adminhub-production-token-[0-9a-f]{6}$/);
    // the record and the transcript name what it became
    expect(await kept(id)).toBe(`AdminHub production token: [Secret kept: ${entry.name}]`);
    const [message] = await rows<{ content: string }>(sql`
      SELECT content FROM conversation_messages WHERE external_id = ${id}`);
    expect(message?.content).toBe(`AdminHub production token: [Secret kept: ${entry.name}]`);
    // the note, handed with the message in the same turn, names it, its project and who uses it
    await expect.poll(() => notesIn(id).length, { timeout: 15_000 }).toBe(1);
    const [note] = notesIn(id).map((n) => n.text);
    expect(note).toContain(`"AdminHub production token" (token) kept in`);
    expect(note).toContain(entry.ref);
    expect(note).toContain('master and its runs');
    expect(note).toContain('revoked or replaced on its page');
    expect(note).toContain('Tell the room once, in this same reply');
    expect(note).not.toMatch(/delete (that|the) message from|You may ask|cannot delete it/);
    // the master reads it at the acting door, and the read is audited
    const got = await read(entry.name);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body).toMatchObject({
      secret: entry.ref,
      value: ADMIN_TOKEN,
      reader: { kind: 'master' },
    });
    const [audit] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM project_variable_events
       WHERE project_id = ${w.projectId}::uuid AND act = 'delivered' AND key = ${entry.ref}`);
    expect(audit?.n).toBe(1);
    expect(await w.linesIn(id)).toEqual([]);
  });

  it("holds a non-admin's token pending for a day, unreadable until an admin approves it (c2)", async () => {
    w.box.model = async () => undefined;
    const id = await say(frank, `AdminHub production token: ${MEMBER_TOKEN}`);
    const entry = await entryOf(id);
    expect(entry).toMatchObject({
      state: 'pending',
      valueAt: null,
      from: { admin: false, userId: null },
    });
    const hours = (Date.parse(String(entry.expiresAt)) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    await expect.poll(() => notesIn(id).length, { timeout: 15_000 }).toBe(1);
    expect(notesIn(id)[0]?.text).toContain('holds no project admin');
    const refusedRead = await read(entry.name);
    expect([refusedRead.status, code(refusedRead.body as Record<string, unknown>)]).toEqual([
      409,
      'ACTING_SECRET_KEPT_PENDING',
    ]);
    // a stranger and an agent's token are refused; the owner approves it
    const approve = (token: string) =>
      api(token, 'POST', `/api/projects/${w.projectId}/kept-secrets/${entry.name}/approval`);
    expect((await approve(w.stranger)).status).toBe(403);
    expect(code((await approve(master)).body as Record<string, unknown>)).toBe(
      'KEPT_SECRET_PERSON_ONLY',
    );
    const approved = await approve(w.owner);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ state: 'usable', decidedBy: w.ownerId });
    expect(((await read(entry.name)).body as { value?: string }).value).toBe(MEMBER_TOKEN);
    const again = await approve(w.owner);
    expect([again.status, code(again.body as Record<string, unknown>)]).toEqual([
      409,
      'KEPT_SECRET_NOT_PENDING',
    ]);
  });

  it("discards a pending token at an admin's word, and destroys one left past its day (c2)", async () => {
    w.box.model = async () => undefined;
    const discarded = await entryOf(await say(frank, `AdminHub production token: ${OTHER_TOKEN}`));
    const gone = await api(
      w.owner,
      'DELETE',
      `/api/projects/${w.projectId}/kept-secrets/${discarded.name}`,
    );
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(gone.body).toMatchObject({ state: 'discarded' });
    const after = await read(discarded.name);
    expect([after.status, code(after.body as Record<string, unknown>)]).toEqual([
      404,
      'ACTING_SECRET_KEPT_GONE',
    ]);

    const late = await entryOf(await say(frank, `staging api key = ${OTHER_TOKEN}x`));
    // a day passes: the record's expiry is moved into the past
    await db.execute(sql`
      UPDATE project_variable_events
         SET detail = jsonb_set(detail, '{kept,expiresAt}', to_jsonb((now() - interval '1 minute')::text))
       WHERE project_id = ${w.projectId}::uuid AND key = ${late.ref} AND act = 'created'`);
    const expired = await read(late.name);
    expect([expired.status, code(expired.body as Record<string, unknown>)]).toEqual([
      404,
      'ACTING_SECRET_KEPT_GONE',
    ]);
    const values = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM project_secrets
       WHERE project_id = ${w.projectId}::uuid AND scope = 'kept' AND name IN (${late.name}, ${discarded.name})`);
    expect(values[0]?.n).toBe(0);
    expect(await entryOf(late.message)).toMatchObject({ state: 'expired' });
  });

  it('holds the planted values in no row of any table, no log line and no prompt (c5)', async () => {
    const planted = [ADMIN_TOKEN, MEMBER_TOKEN, OTHER_TOKEN];
    const tables = await rows<{ t: string }>(sql`
      SELECT quote_ident(table_name) AS t FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    const hits: string[] = [];
    for (const { t } of tables) {
      for (const v of planted) {
        const [row] = await rows<{ n: number }>(
          sql.raw(
            `SELECT count(*)::int AS n FROM public.${t} x WHERE to_jsonb(x)::text LIKE '%${v}%'`,
          ),
        );
        if ((row?.n ?? 0) > 0) hits.push(t);
      }
    }
    expect(hits).toEqual([]);
    const prompts = JSON.stringify(w.box.turns);
    const logged = log.lines;
    expect(logged.length).toBeGreaterThan(0);
    for (const v of planted) {
      expect(logged.filter((l) => l.includes(v))).toEqual([]);
      expect(prompts.includes(v)).toBe(false);
    }
  });

  it('asks nobody to delete in any note core handed the room (c4)', () => {
    const notes = w.box.turns.flatMap((t) => t.messages).filter((m) => m.from === 'forge');
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes)
      expect(n.text).not.toMatch(/You may ask .* to delete|delete that message from/);
  });
});

describe('ISS-1328: support.secret_link answers the link of one declared slot', () => {
  it('links the slot’s request on the Secrets page, and refuses by name what the project does not declare', async () => {
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
        answers.push(
          await act({
            action: 'secret_link',
            thread: m.thread,
            why: 'The tests call PGPrints with it',
            kind: 'testing',
            ...t,
          }),
        );
      return undefined;
    });
    const [service, actor, ...refused] = answers;
    expect(service).toMatchObject({
      link: expect.stringMatching(
        new RegExp(`/projects/${slug}/settings\\?tab=secrets&ask=[0-9a-f-]{36}$`),
      ),
      kind: 'testing',
      slot: { profile: 'stg', service: 'pgprints' },
    });
    expect(String(service?.says)).toContain('never ask anyone to rotate it');
    expect(actor).toMatchObject({ slot: { actor: 'supplier' } });
    expect(String(actor?.link)).not.toBe(String(service?.link));
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
