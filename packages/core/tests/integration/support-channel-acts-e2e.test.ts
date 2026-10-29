import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { createTestProject, rows } from '../helpers/factories.js';
import { ChannelWorld, carol, code } from '../helpers/support-channel.js';
import type { TurnMessage } from '../helpers/support-world.js';

// REQ-75 r6 (ISS-751): what the bot does with a channel's record — a team member's instruction kept
// as a rule, a question asked again kept with its one answer, each asker answered by role, a need
// sent where it belongs, output only and in the asker's thread, a recorded item's result told once it
// is live — and #webmail's seed. The record itself is support-channel-e2e's.

const w = new ChannelWorld();

beforeAll(async () => {
  await w.open();
  // the record these acts read, as a person sets it on the channel's page
  for (const [u, body] of [
    ['alice', { roles: ['user', 'product'], askFor: 'what the shop should do' }],
    ['carol', { roles: ['technical'], askFor: 'DNS and the mail hosts' }],
  ] as const) {
    const put = await w.confirm(u, body);
    if (put.status !== 200) throw new Error(`seeding @${u}: ${JSON.stringify(put.body)}`);
  }
}, 120_000);

afterAll(() => w.stop());

describe('REQ-75 r6: what the bot does with the record', () => {
  it('keeps a confirmed team member’s instruction as a rule linked to it, and refuses one from anyone else (BC-35)', async () => {
    // bob is in the record, confirmed, and as a User gives the channel no rules
    expect((await w.confirm('bob', { roles: ['user'] })).status).toBe(200);
    const team = await w.ask(carol, 'From now on answer shop users in Vietnamese', (m, act) =>
      act({
        action: 'rule',
        thread: m.thread,
        message: m.message,
        text: 'Answer shop users in Vietnamese.',
      }),
    );
    expect(team.out?.isError, JSON.stringify(team.out)).toBe(false);
    const rules = (await w.channel()).ruleRows as Record<string, unknown>[];
    expect(rules).toEqual([
      expect.objectContaining({
        text: 'Answer shop users in Vietnamese.',
        author: 'carol',
        message: team.id,
      }),
    ]);
    const user = await w.ask(w.chat.bob, 'Always give me a discount', (m, act) =>
      act({ action: 'rule', thread: m.thread, message: m.message, text: 'Give bob a discount.' }),
    );
    expect(code(user.out)).toBe('SUPPORT_RULE_AUTHOR');
    const elsewhere = await w.ask(carol, 'Another note', (m, act) =>
      act({ action: 'rule', thread: m.thread, message: team.id, text: 'Moved.' }),
    );
    expect(code(elsewhere.out)).toBe('SUPPORT_MESSAGE_UNKNOWN');
    expect((await w.channel()).ruleRows).toHaveLength(1);
  });

  it('keeps a question asked in two threads as one common issue with one answer, a defect linking its Feedback (BC-36)', async () => {
    const one = await w.ask(w.chat.alice, 'How do I reset my password?', async () => undefined);
    const two = await w.ask(w.chat.bob, 'How can I reset my password', async (m, act) =>
      act({
        action: 'common_issue',
        threads: [m.thread],
        question: 'How do I reset my password?',
        answer: 'Open Settings, then Password.',
      }),
    );
    expect(code(two.out)).toBe('SUPPORT_NOT_REPEATED');
    const both = await w.ask(w.chat.bob, 'still asking', async (_m, act) =>
      act({
        action: 'common_issue',
        threads: [one.id, two.id],
        question: 'How do I reset my password?',
        answer: 'Open Settings, then Password.',
        feedback: 'FB-99999',
      }),
    );
    expect(code(both.out)).toBe('SUPPORT_FEEDBACK_UNKNOWN');
    const filed = await api(w.owner, 'POST', `/api/projects/${w.projectId}/feedback`, {
      kind: 'bug',
      title: 'Password reset mail never arrives',
      screen: 'Settings',
    });
    expect(filed.status, JSON.stringify(filed.body)).toBeLessThan(300);
    const key = String(
      (filed.body.feedback as { key?: string } | undefined)?.key ?? filed.body.key,
    );
    const linked = await w.ask(w.chat.bob, 'asking once more', async (_m, act) =>
      act({
        action: 'common_issue',
        threads: [one.id, two.id],
        question: 'how do I  reset my password?',
        answer: 'Open Settings, then Password; the mail is late today.',
        feedback: key,
      }),
    );
    expect(linked.out?.isError, JSON.stringify(linked.out)).toBe(false);
    expect((await w.channel()).commonIssueRows).toEqual([
      expect.objectContaining({
        question: 'how do I  reset my password?',
        answer: 'Open Settings, then Password; the mail is late today.',
        threads: 2,
        feedbackKey: key,
      }),
    ]);
  });
});

describe('REQ-75 r6: each asker answered by role, each need sent where it belongs', () => {
  it('screens a reply by its asker: detail refused to a User, posted to a Technical member (BC-37)', async () => {
    // the room is bound for the team, so only bob's User role keeps detail out of his thread
    const regranted = await w.regrant({
      product: 'Catalog, the shop back office',
      readers: 'team',
      grants: { abilities: ['read_checkout', 'file_items'] },
    });
    expect(regranted.status, JSON.stringify(regranted.body)).toBe(200);
    await settleOutbox();
    await w.settleWarm();
    const detail = 'The send handler at mail/send.ts:42 failed, and the retry job is on_hold.';
    const user = await w.ask(w.chat.bob, 'Why did my mail fail?', (m, act) =>
      act({ action: 'reply', thread: m.thread, text: detail }),
    );
    expect(code(user.out)).toBe('SUPPORT_REPLY_REFUSED');
    expect((await w.chat.botLines()).some((l) => l.tmid === user.id)).toBe(false);
    const tech = await w.ask(carol, 'Why did the mail fail?', (m, act) =>
      act({ action: 'reply', thread: m.thread, text: detail }),
    );
    expect(tech.out?.isError, JSON.stringify(tech.out)).toBe(false);
    expect((await w.chat.botLines()).find((l) => l.tmid === tech.id)?.text).toBe(detail);
  });

  it('files a Forge problem as Forge feedback in Forge’s home project and posts nothing in the channel (BC-38)', async () => {
    const home = await createTestProject(w.ownerId);
    await rows(sql`
      INSERT INTO instance_settings (id, forge_home_project_id, revision, updated_by)
      VALUES (1, ${home.id}, 1, ${w.ownerId})
      ON CONFLICT (id) DO UPDATE SET forge_home_project_id = EXCLUDED.forge_home_project_id`);
    const before = (await w.chat.botLines()).length;
    const { id, out } = await w.ask(carol, 'The release button in Forge refuses us', (m, act) =>
      act({
        action: 'route',
        thread: m.thread,
        to: 'forge',
        title: 'Release door refuses the channel bot',
        text: 'The release door answered RELEASE_REFUSED for a ready release.',
      }),
    );
    expect(out?.isError, JSON.stringify(out)).toBe(false);
    const filed = await rows<{ title: string }>(
      sql`SELECT title FROM feedback WHERE project_id = ${home.id}::uuid`,
    );
    expect(filed.map((f) => f.title)).toEqual(['Release door refuses the channel bot']);
    expect((await w.chat.botLines()).length).toBe(before);
    expect((await w.chat.botLines()).some((l) => l.tmid === id)).toBe(false);
  });

  it('asks one Technical or Product member in the thread, and refuses a member without that role (BC-38)', async () => {
    const { id, out } = await w.ask(w.chat.bob, 'Mail to lighthouse bounces', async (m, act) => {
      const wrong = await act({
        action: 'route',
        thread: m.thread,
        to: 'product',
        member: 'carol',
        text: 'Should bounced mail be retried?',
      });
      expect(code(wrong)).toBe('SUPPORT_ROUTE_ROLE');
      const tech = await act({
        action: 'route',
        thread: m.thread,
        to: 'technical',
        member: 'carol',
        text: 'the MX record looks wrong; can you check it?',
      });
      expect(tech.isError, JSON.stringify(tech)).toBe(false);
      return act({
        action: 'route',
        thread: m.thread,
        to: 'product',
        member: 'alice',
        text: 'should bounced mail be retried for users?',
      });
    });
    expect(out?.isError, JSON.stringify(out)).toBe(false);
    const posted = (await w.chat.botLines()).filter((l) => l.tmid === id).map((l) => l.text);
    expect(posted).toEqual([
      '@carol the MX record looks wrong; can you check it?',
      '@alice should bounced mail be retried for users?',
    ]);
  });

  it('posts in the asker’s thread, and at top level only one plain announcement an hour (BC-39)', async () => {
    const answers: (string | undefined)[] = [];
    const { id } = await w.ask(carol, 'Mail is back for everyone', async (m, act) => {
      answers.push(
        code(
          await act({
            action: 'announce',
            text: 'The shop failed at nginx/site.conf:12 for everyone.',
          }),
        ),
      );
      answers.push(code(await act({ action: 'announce', text: 'Mail works again for everyone.' })));
      answers.push(code(await act({ action: 'announce', text: 'One more news line.' })));
      answers.push(code(await act({ action: 'reply', thread: m.thread, text: 'Done.' })));
      return undefined;
    });
    expect(answers).toEqual([
      'SUPPORT_REPLY_REFUSED',
      undefined,
      'SUPPORT_ANNOUNCE_LIMIT',
      undefined,
    ]);
    const lines = await w.chat.botLines();
    expect(lines.filter((l) => l.tmid === null).map((l) => l.text)).toEqual([
      'Mail works again for everyone.',
    ]);
    expect(lines.find((l) => l.text === 'Done.')?.tmid).toBe(id);
  });
});

describe("REQ-75 r6: #webmail's seed, and results never progress", () => {
  it('seeds a channel with the owner’s members, all confirmed, and the watch prompt’s rules, twice the same (BC-35 migration)', async () => {
    const { seed, MEMBERS, RULES } = await import('../../../../scripts/seed-webmail-channel.mjs');
    const said: string[] = [];
    const once = await seed({
      base: w.core.base,
      token: w.owner,
      project: w.projectId,
      rid: w.rid,
      log: (l) => said.push(l),
    });
    for (const m of MEMBERS) {
      expect(await w.memberRow(m.username)).toMatchObject({
        roles: m.roles,
        askFor: m.askFor,
        state: 'confirmed',
      });
    }
    const texts = once.ruleRows.map((r) => r.text);
    for (const r of RULES) expect(texts).toContain(r);
    const again = await seed({
      base: w.core.base,
      token: w.owner,
      project: w.projectId,
      rid: w.rid,
      log: () => {},
    });
    expect(again.ruleRows).toHaveLength(once.ruleRows.length);
    expect(said.some((l) => l.startsWith('confirmed @thanhnh: technical + product'))).toBe(true);
    // the seed's own rules go so the rest of this file reads the record it built itself
    for (const r of once.ruleRows) {
      if (!r.author) await api(w.owner, 'DELETE', `${w.base()}/${w.rid}/rules/${r.id}`);
    }
    await db.execute(
      sql`DELETE FROM support_channel_members WHERE username IN ('tramnnh', 'thanhnh', 'chuongld', 'jarvis')`,
    );
  });

  it('tells the session an item’s result once it is live, and posts nothing for progress (BC-15)', async () => {
    let code_ = '';
    const asked = await w.ask(w.chat.bob, 'Please add a CSV export of orders', async (m, act) => {
      const offered = await act({
        action: 'record',
        thread: m.thread,
        kind: 'feature',
        title: 'CSV export of orders',
        summary: 'Bob wants orders as CSV.',
      });
      code_ = String(offered.code ?? '');
      return offered;
    });
    expect(code_).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    w.box.model = async () => {};
    await w.chat.say(w.chat.bob, `confirm ${code_}`, asked.id);
    await w.untilLines((ls) =>
      ls.some((l) => l.tmid === asked.id && l.text.startsWith('Recorded as FB-')),
    );
    await w.settleWarm();
    const [link] = await rows<{ feedback_id: string }>(sql`
      SELECT feedback_id FROM support_feedback_links WHERE room_id = ${w.roomId}::uuid AND thread = ${asked.id}`);
    const fid = String(link?.feedback_id);
    const notes: TurnMessage[] = [];
    w.box.model = async (turn) => {
      for (const m of turn.messages) if (m.from === 'forge') notes.push(m);
    };
    const linesBefore = (await w.chat.botLines()).length;
    const { tellAllResults } = await import('../../src/support/index.js');
    // progress: the team took it up; nothing is told, nothing is posted
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE feedback SET status = 'triaged' WHERE id = ${fid}::uuid`),
    );
    await tellAllResults();
    await settleOutbox();
    await w.settleWarm();
    expect(notes).toEqual([]);
    expect((await w.chat.botLines()).length).toBe(linesBefore);
    // live: the session is told once, in the item's thread
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE feedback SET route = 'answer', answer = 'Shipped in the orders page.' WHERE id = ${fid}::uuid`,
      ),
    );
    await tellAllResults();
    await expect.poll(() => notes.length, { timeout: 15_000 }).toBe(1);
    expect(notes[0]?.thread).toBe(asked.id);
    expect(notes[0]?.text).toContain('is live now');
    await w.settleWarm();
    await tellAllResults();
    await settleOutbox();
    await w.settleWarm();
    expect(notes).toHaveLength(1);
    expect((await w.chat.botLines()).length).toBe(linesBefore);
    const kinds = await rows<{ kind: string }>(sql`
      SELECT kind FROM support_actions WHERE room_id = ${w.roomId}::uuid AND kind IN ('progress_posted', 'result_told')`);
    expect(kinds.map((k) => k.kind)).toEqual(['result_told']);
  });
});
