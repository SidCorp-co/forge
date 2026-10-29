import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { ChannelWorld, code } from '../helpers/support-channel.js';

// REQ-75 r6 (ISS-750): a bound channel's record in Forge — its members, their roles and what to ask
// each, nothing secret or personal kept — read the same by every bot session of the group and across
// a restart. The world is support-room-e2e's: the real Rocket.Chat connection manager against the
// stand-in chat server, and a box playing the session through `forge_support` alone.
// What the bot does with the record (ISS-751) is support-channel-acts-e2e.

const w = new ChannelWorld();
// a GitHub token's shape, built here so no literal secret sits in the tree
const TOKEN = `github_pat_${'A1b2C3d4'.repeat(4)}`;
const threads: string[] = [];

beforeAll(() => w.open(), 120_000);

afterAll(() => w.stop());

describe('REQ-75 r6: the channel record and who is in it', () => {
  it('lists the bound channel under Product, with members, rules, common issues and routes (BC-30)', async () => {
    const list = await api(w.owner, 'GET', w.base());
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.channels).toEqual([
      { rid: w.rid, name: 'catalog-support', members: 0, rules: 0, commonIssues: 0 },
    ]);
    const one = await w.channel();
    expect(one).toMatchObject({ memberRows: [], ruleRows: [], commonIssueRows: [] });
    expect((one.routes as { route: string }[]).map((r) => r.route)).toEqual([
      'forge',
      'technical',
      'product',
    ]);
    // a group no binding of the project attaches has no page, and a stranger reads none
    const none = await api(w.owner, 'GET', `${w.base()}/NOTBOUND`);
    expect(none.status).toBe(404);
    expect(JSON.stringify(none.body)).toContain('SUPPORT_CHANNEL_UNKNOWN');
    expect((await api(w.stranger, 'GET', w.base())).status).toBe(403);
  });

  it('names the session answering it: Forge’s own bot, its box and its live address (BC-42)', async () => {
    const [placed] = await rows<{ session_id: string; box: string | null }>(sql`
      SELECT r.session_id, d.name AS box FROM support_rooms r
        JOIN agent_sessions s ON s.id = r.session_id LEFT JOIN devices d ON d.id = s.device_id
       WHERE r.id = ${w.roomId}::uuid`);
    expect(placed?.box).toBeTruthy();
    expect((await w.channel()).agent).toMatchObject({
      kind: 'channel',
      role: 'support',
      channel: w.rid,
      answeredBy: 'forge',
      box: placed?.box,
      address: `forge-session:${placed?.session_id}`,
    });
    // Forge's bot is read off its session, never declared by hand
    const declared = await api(w.owner, 'PUT', `${w.base()}/${w.rid}/agent`, {
      role: 'catalog Babo',
      box: 'elsewhere',
      address: 'tmux:babo',
    });
    expect(declared.status).toBe(409);
    expect(JSON.stringify(declared.body)).toContain('SUPPORT_CHANNEL_NOT_OUTSIDE');
  });

  it('records the roles the bot inferred from a message, read as inferred (BC-32)', async () => {
    const { id, out } = await w.ask(
      w.chat.alice,
      'Hi, I read the shop mail at the front desk',
      (m, act) =>
        act({
          action: 'member',
          member: 'alice',
          roles: ['user'],
          askFor: 'what she sees in the shop',
          message: m.message,
        }),
    );
    expect(out?.isError, JSON.stringify(out)).toBe(false);
    threads.push(id);
    expect(await w.memberRow('alice')).toMatchObject({
      roles: ['user'],
      state: 'inferred',
      askFor: 'what she sees in the shop',
      confirmedBy: null,
    });
    // the next message names the writer's roles as the record holds them
    const next = await w.ask(w.chat.alice, 'Thanks', async () => undefined);
    threads.push(next.id);
    expect(next.turn.messages.find((m) => m.text === 'Thanks')?.from).toMatchObject({
      name: 'alice',
      roles: ['user'],
    });
    // a message this room never received is no source
    const { out: unknown } = await w.ask(w.chat.bob, 'I am bob', (_m, act) =>
      act({ action: 'member', member: 'bob', roles: ['user'], message: 'NOSUCHMESSAGE' }),
    );
    expect(code(unknown)).toBe('SUPPORT_MESSAGE_UNKNOWN');
    expect(await w.memberRow('bob')).toBeUndefined();
  });

  it('takes the five roles, several at once, and refuses any other by name (BC-31)', async () => {
    const other = await w.confirm('carol', { roles: ['admin'] });
    expect(other.status).toBe(400);
    expect(JSON.stringify(other.body)).toContain('roles');
    expect((await w.confirm('carol', { roles: [] })).status).toBe(400);
    expect((await w.confirm('carol', { roles: ['user', 'user'] })).status).toBe(400);
    const all = await w.confirm('dave', {
      roles: ['user', 'product', 'technical', 'maintenance', 'bot'],
    });
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(
      await rows(sql`SELECT 1 FROM support_channel_members WHERE username = 'dave'`),
    ).toHaveLength(1);
    await expect(
      db.execute(
        sql`UPDATE support_channel_members SET roles = ARRAY['owner'] WHERE username = 'dave'`,
      ),
    ).rejects.toMatchObject({ cause: { constraint_name: 'support_channel_members_roles_chk' } });
    await db.execute(sql`DELETE FROM support_channel_members WHERE username = 'dave'`);
  });

  it('a person’s correction confirms a member, and the bot’s later inference changes nothing (BC-33)', async () => {
    const put = await w.confirm('alice', {
      roles: ['user', 'product'],
      askFor: 'what the shop should do',
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await w.memberRow('alice')).toMatchObject({
      roles: ['user', 'product'],
      state: 'confirmed',
      askFor: 'what the shop should do',
    });
    expect((await w.memberRow('alice'))?.confirmedBy).toBeTruthy();
    const { out } = await w.ask(w.chat.alice, 'I fixed the server myself', (m, act) =>
      act({ action: 'member', member: 'alice', roles: ['technical'], message: m.message }),
    );
    expect(code(out)).toBe('SUPPORT_MEMBER_CONFIRMED');
    expect(await w.memberRow('alice')).toMatchObject({
      roles: ['user', 'product'],
      state: 'confirmed',
    });
    // the technical member the rest of the run asks
    expect(
      (await w.confirm('carol', { roles: ['technical'], askFor: 'DNS and the mail hosts' })).status,
    ).toBe(200);
  });
});

describe('REQ-75 r6: nothing private kept, and one person mentioned', () => {
  it('refuses a secret, an email address or a phone number in the record, storing nothing (BC-40)', async () => {
    for (const askFor of [
      `token ${TOKEN}`,
      'mail me at carol@example.com',
      'call +84 912 345 678',
    ]) {
      const put = await w.confirm('carol', { roles: ['technical'], askFor });
      expect(put.status, askFor).toBe(400);
      expect(JSON.stringify(put.body)).toContain('SUPPORT_CHANNEL_PRIVATE_DATA');
    }
    expect((await w.memberRow('carol'))?.askFor).toBe('DNS and the mail hosts');
    const rule = await api(w.owner, 'POST', `${w.base()}/${w.rid}/rules`, {
      text: 'Escalate to ops@example.com',
    });
    expect(rule.status).toBe(400);
    // an address of a host is no phone number
    const host = await w.confirm('carol', {
      roles: ['technical'],
      askFor: 'DNS and the hosts at 10.0.0.12',
    });
    expect(host.status, JSON.stringify(host.body)).toBe(200);
    await w.confirm('carol', { roles: ['technical'], askFor: 'DNS and the mail hosts' });
  });

  it('keeps a member’s posted secret out of every record and asks one Technical member to delete it (BC-40)', async () => {
    const said = `my api token is ${TOKEN}, please check it`;
    const { id, turn } = await w.ask(w.chat.bob, said, async () => undefined);
    expect(turn.text).not.toContain(TOKEN);
    const kept = await rows<{ t: string }>(sql`
      SELECT input::text AS t FROM support_actions WHERE room_id = ${w.roomId}::uuid AND external_id = ${id}`);
    expect(kept[0]?.t).toBeTruthy();
    expect(kept[0]?.t).not.toContain(TOKEN);
    const stored = await rows<{ content: string }>(sql`
      SELECT content FROM conversation_messages WHERE external_id = ${id}`);
    expect(stored[0]?.content).not.toContain(TOKEN);
    const lines = await w.untilLines((ls) =>
      ls.some((l) => l.tmid === id && l.text.includes('holds a secret')),
    );
    const flag = lines.filter((l) => l.tmid === id && l.text.includes('holds a secret'));
    expect(flag).toHaveLength(1);
    expect(flag[0]?.text).toMatch(/^@carol /);
    const [action] = await rows<{ output: { technical: string } }>(sql`
      SELECT output FROM support_actions WHERE room_id = ${w.roomId}::uuid AND kind = 'secret_flagged'`);
    expect(action?.output.technical).toBe('carol');
  });

  it('lets a reply mention one person the channel lists or the asker, and refuses any other (BC-34)', async () => {
    const tries: [string, string | null][] = [
      ['@alice @carol please look', 'SUPPORT_MENTION_REFUSED'],
      ['@all the shop is back', 'SUPPORT_MENTION_REFUSED'],
      ['@eve can you check', 'SUPPORT_MENTION_REFUSED'],
      ['@carol can you check the mail host', null],
      ['@bob it works again', null],
    ];
    const answers: (string | undefined)[] = [];
    const { id } = await w.ask(w.chat.bob, 'Mail is not arriving', async (m, act) => {
      for (const [text] of tries)
        answers.push(code(await act({ action: 'reply', thread: m.thread, text })));
      return undefined;
    });
    expect(answers).toEqual(tries.map(([, c]) => c ?? undefined));
    const posted = (await w.chat.botLines()).filter((l) => l.tmid === id).map((l) => l.text);
    expect(posted).toEqual(['@carol can you check the mail host', '@bob it works again']);
  });

  it('briefs a cold session with the channel record, and tells a warm one when it changed (BC-41)', async () => {
    expect(await rows(sql`SELECT 1 FROM support_channels WHERE rid = ${w.rid}`)).toHaveLength(1);
    const added = await api(w.owner, 'POST', `${w.base()}/${w.rid}/rules`, {
      text: 'Never post a plan.',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const warm = await w.ask(w.chat.bob, 'hello again', async (_m, act) =>
      act({
        action: 'common_issue',
        threads: threads.slice(0, 2),
        question: 'Is the shop open on Sunday?',
        answer: 'Yes, from ten to four.',
      }),
    );
    expect(warm.out?.isError, JSON.stringify(warm.out)).toBe(false);
    expect(warm.turn.text).toContain('The channel record changed');
    expect(warm.turn.text).toContain('Never post a plan.');
    // the session restarts without its own history: the brief carries the whole record
    await db.execute(sql`UPDATE agent_sessions SET claude_session_id = NULL
                          WHERE id = (SELECT session_id FROM support_rooms WHERE id = ${w.roomId}::uuid)`);
    const cold = await w.ask(w.chat.bob, 'are you there', async () => undefined);
    expect(cold.turn.event).toBe('agent:start');
    for (const part of [
      'This channel, as Forge records it',
      '@carol: Technical (confirmed) — ask for: DNS and the mail hosts',
      '@alice: User + Product (confirmed)',
      'Never post a plan.',
      'Is the shop open on Sunday?',
      'Forge: a problem with Forge itself',
    ]) {
      expect(cold.turn.text, part).toContain(part);
    }
  });
});
