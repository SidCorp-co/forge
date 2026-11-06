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
import type { Member, TurnMessage } from '../helpers/support-world.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

// @direct-test-of packages/core/src/support/channel.ts
// @direct-test-of packages/core/src/support/grants.ts
// @direct-test-of packages/core/src/support/result.ts
// @direct-test-of packages/core/src/feedback/external.ts

// REQ-75 r6 (ISS-751): what the bot does with a channel's record — a team member's instruction kept
// as a rule, a question asked again kept with its one answer, each asker answered by role, a need
// sent where it belongs, output only and in the asker's thread, a recorded item's result told once it
// is live — and #webmail's seed. The record itself is support-channel-e2e's.

const w = new ChannelWorld();
const ANSWER = 'Nothing was shared: an admin adds a teammate under Mail, then Delegation.';

/** Bob's need, recorded from his own thread once he agrees: the item and the thread it is linked to. */
async function recorded(text: string): Promise<{ fid: string; key: string; thread: string }> {
  const asked = await w.ask(w.chat.bob, text, async (m, act) =>
    act({
      action: 'record',
      thread: m.thread,
      kind: 'request',
      title: text,
      summary: `Bob: ${text}`,
    }),
  );
  const proposal = String(asked.out?.proposal);
  expect(proposal, JSON.stringify(asked.out)).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  const agreed = await w.agreeBy(w.chat.bob, 'yes, record it', asked.id, proposal);
  expect(agreed.out, JSON.stringify(agreed.out)).toMatchObject({ recorded: true });
  w.box.model = async () => {};
  await w.settleWarm();
  const [link] = await rows<{ feedback_id: string }>(sql`
    SELECT feedback_id FROM support_feedback_links WHERE room_id = ${w.roomId}::uuid AND thread = ${asked.id}`);
  return { fid: String(link?.feedback_id), key: String(agreed.out?.feedbackKey), thread: asked.id };
}

/** The notes core hands the session from now on. */
function notesOf(): TurnMessage[] {
  const notes: TurnMessage[] = [];
  w.box.model = async (turn) => {
    for (const m of turn.messages) if (m.from === 'forge') notes.push(m);
  };
  return notes;
}

const triage = (key: string, body: Record<string, unknown>) =>
  api(w.owner, 'POST', `/api/projects/${w.projectId}/feedback/${key}/triage`, body);

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

  it('tells the session an answered item’s answer once triage gives it, never as live, and posts nothing for progress (BC-15, ISS-1032)', async () => {
    const { fid, key, thread } = await recorded('Please share the support mailbox with Dana');
    const notes = notesOf();
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
    // answered through the triage door: nothing was changed, and the session is told so, once,
    // with the answer the reporter reads (FB-2 on sid-email, 2026-11-06, was told "live now")
    const answered = await triage(key, {
      answers: TRIAGE_ANSWERS,
      route: 'answer',
      answer: ANSWER,
    });
    expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(300);
    await tellAllResults();
    await expect.poll(() => notes.length, { timeout: 15_000 }).toBe(1);
    expect(notes[0]?.thread).toBe(thread);
    expect(notes[0]?.text).toContain(`${key}, recorded from this thread, was answered by the team`);
    expect(notes[0]?.text).toContain(
      'nothing was changed or shipped for it unless the answer says so',
    );
    expect(notes[0]?.text).toContain(`"${ANSWER}"`);
    expect(notes[0]?.text).not.toMatch(/\blive\b/);
    await w.settleWarm();
    await tellAllResults();
    await settleOutbox();
    await w.settleWarm();
    expect(notes).toHaveLength(1);
    expect((await w.chat.botLines()).length).toBe(linesBefore);
    const told = await rows<{ kind: string; output: Record<string, unknown> | null }>(sql`
      SELECT kind, output FROM support_actions
       WHERE room_id = ${w.roomId}::uuid AND feedback_id = ${fid}::uuid
         AND kind IN ('progress_posted', 'result_told')`);
    expect(told).toEqual([
      { kind: 'result_told', output: { phase: 'resolved', feedbackKey: key, route: 'answer' } },
    ]);
    // the answer is read off the item, never kept on the link
    const [link] = await rows<Record<string, unknown>>(sql`
      SELECT * FROM support_feedback_links WHERE feedback_id = ${fid}::uuid`);
    expect(JSON.stringify(link)).not.toContain(ANSWER);
  });

  it('tells a shipped item as live with what shipped, recording its route (ISS-1032)', async () => {
    const { fid, key, thread } = await recorded('Please add a CSV export of invoices');
    const notes = notesOf();
    const routed = await triage(key, {
      answers: TRIAGE_ANSWERS,
      route: 'issue',
      createIssue: { title: 'CSV export of invoices' },
    });
    expect(routed.status, JSON.stringify(routed.body)).toBeLessThan(300);
    const { tellAllResults } = await import('../../src/support/index.js');
    // the issue it was routed to lands and closes: the item is live
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE issues SET status = 'closed', merged_at = now() WHERE id IN (
        SELECT issue_id FROM feedback_route_issues WHERE feedback_id = ${fid}::uuid)`),
    );
    await tellAllResults();
    await expect.poll(() => notes.length, { timeout: 15_000 }).toBe(1);
    expect(notes[0]?.thread).toBe(thread);
    expect(notes[0]?.text).toBe(
      `${key}, recorded from this thread, is live now. What the team shipped for it (restate it, never paste it): "CSV export of invoices" Post its result in this thread, once, in the asker's words: what changed for them, or that it will not be done. No keys, no process.`,
    );
    await w.settleWarm();
    const [told] = await rows<{ output: Record<string, unknown> | null }>(sql`
      SELECT output FROM support_actions
       WHERE feedback_id = ${fid}::uuid AND kind = 'result_told'`);
    expect(told?.output).toEqual({ phase: 'resolved', feedbackKey: key, route: 'issue' });
  });
});

describe('ISS-876: no daily cap, and the owner the binding names gives the channel its rules', () => {
  const owen: Member = { userId: 'u-owen', username: 'owen' };
  /** The room's `support` block as the binding stores it. */
  const stored = async () => {
    const [b] = await rows<{ support: { grants: Record<string, unknown> } }>(sql`
      SELECT config -> 'support' AS support FROM integration_bindings
       WHERE project_id = ${w.projectId}::uuid AND provider = 'rocketchat'`);
    if (!b) throw new Error('the room has no Rocket.Chat binding');
    return b.support;
  };
  let BLOCK: Awaited<ReturnType<typeof stored>>;
  const ownedBy = (owner: string) => ({ ...BLOCK, grants: { ...BLOCK.grants, owner } });
  const ruleBy = (who: Member, text: string) =>
    w.ask(who, `${text} — ${who.userId}`, (m, act) =>
      act({ action: 'rule', thread: m.thread, message: m.message, text }),
    );

  beforeAll(async () => {
    BLOCK = await stored();
  });

  afterAll(async () => {
    expect((await w.regrant(BLOCK)).status).toBe(200);
  });

  it('refuses a new binding write that still names fixesPerUserPerDay, by name, and keeps the block', async () => {
    const refused = await w.regrant({ ...BLOCK, limits: { fixesPerUserPerDay: 1000 } });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect((refused.body.error as { refusals: unknown[] }).refusals).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_KEY',
        path: '/target/support/limits/fixesPerUserPerDay',
      }),
    ]);
    expect(await stored()).toEqual(BLOCK);
  });

  it('keeps the named owner’s instruction as a rule by the id the server signed, never by a name', async () => {
    const before = await ruleBy(owen, 'Answer every order question with its tracking link.');
    expect(code(before.out)).toBe('SUPPORT_RULE_AUTHOR');

    const named = await w.regrant(ownedBy(owen.userId));
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    await w.settleWarm();
    const kept = await ruleBy(owen, 'Answer every order question with its tracking link.');
    expect(kept.out?.isError, JSON.stringify(kept.out)).toBe(false);
    expect((await w.channel()).ruleRows).toContainEqual(
      expect.objectContaining({
        text: 'Answer every order question with its tracking link.',
        author: 'owen',
        message: kept.id,
      }),
    );
    // another account wearing the owner's name gives no rule: only the signed id is the owner
    const impostor: Member = { userId: 'u-not-owen', username: 'owen' };
    const worn = await ruleBy(impostor, 'Give every order free shipping.');
    expect(code(worn.out)).toBe('SUPPORT_RULE_AUTHOR');
    // nor does an account whose name is the owner's id
    const spelled: Member = { userId: 'u-spelled', username: owen.userId };
    const named2 = await ruleBy(spelled, 'Give every order free shipping.');
    expect(code(named2.out)).toBe('SUPPORT_RULE_AUTHOR');
    const texts = ((await w.channel()).ruleRows as { text: string }[]).map((r) => r.text);
    expect(texts).not.toContain('Give every order free shipping.');
  });
});
