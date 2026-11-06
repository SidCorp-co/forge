import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { rows } from '../helpers/factories.js';
import { AgentWorld, agentBlock, dave, OWNER_ID } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import type { Member } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/deciders.ts
// @direct-test-of packages/core/src/support/fixes.ts
// @direct-test-of packages/core/src/support/confirm-role.ts
// @direct-test-of packages/core/src/support/channel.ts
// @direct-test-of packages/core/src/support/channel-read.ts
// @direct-test-of packages/core/src/support/propose.ts
//
// ISS-1000 (FB-510, FB-535): sidpeak's room named tuyendtb as the one who decides releases, and the
// owner wrote a channel rule "when she asks for a release, record it at once without asking her
// again"; the channel record held her as Product, so her own "release …" was refused as an earlier
// message and she was asked again. A rule naming a member as the decider of an act is now kept on the
// record, the brief and the agreement both read it, and it stands only when the owner or a confirmed
// Technical or Maintenance member wrote it.

const tuyen: Member = { userId: 'u-tuyen', username: 'tuyen' };

const w = new AgentWorld();
let chat: StandInRocketChat;

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  const set = await w.retarget({
    agent: { ...agentBlock([w.devTarget], chat.rid), answers: 'every-message' },
  });
  expect(set.status, JSON.stringify(set.body)).toBeLessThan(300);
  // tuyen is the room's Product member, as the live record holds her; dave a Product member too
  for (const u of ['tuyen', 'dave']) {
    const put = await w.confirm(u, { roles: ['product'] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  }
  await w.settleWarm();
}, 120_000);

afterAll(() => w.stop());

const filings = async () =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${w.projectId}::uuid`,
    )
  )[0]?.n ?? 0;

/** The consent core recorded on the proposal settled in `thread`. */
const consentIn = async (thread: string) =>
  (
    await rows<{ actor_key: string; output: unknown }>(sql`
      SELECT actor_key, output FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND thread = ${thread} AND kind = 'fix_confirmed'`)
  )[0];

/** `who` writes `text` in a new thread; in that turn the session keeps it as a rule naming `decides`. */
async function ruleBy(who: Member, text: string, decides: { member: string; acts: string[] }) {
  let out: Record<string, unknown> = {};
  await w.hear(
    () => chat.say(who, text),
    async (_t, act, message) => {
      const m = message();
      out = await act({
        action: 'rule',
        thread: m.thread,
        message: m.message,
        text: `When @${decides.member} asks for a release, record it at once and confirm in one line.`,
        decides,
      });
    },
  );
  return out;
}

/** `who` asks in a new thread; the session records it for them and cites that same message. */
async function ownRecordRequest(who: Member, text: string) {
  let proposed: Record<string, unknown> = {};
  let agreed: Record<string, unknown> = {};
  const asked = await w.hear(
    () => chat.say(who, text),
    async (_t, act, message) => {
      const m = message();
      proposed = await act({
        action: 'record',
        thread: m.thread,
        kind: 'request',
        title: `Asked: ${text.slice(0, 40)}`,
        summary: text,
        asker: who.userId,
      });
      agreed = await act({
        action: 'agree',
        thread: m.thread,
        proposal: String(proposed.proposal),
        message: String(m.message),
      });
    },
  );
  expect(proposed, JSON.stringify(proposed)).toMatchObject({ pending: true });
  return { thread: asked.id, turn: asked.turn, proposed, agreed };
}

const ruleRows = async () =>
  (await w.channel()).ruleRows as { text: string; author: string; decides: unknown }[];

describe('ISS-1000: the member a room names as decider agrees by their own request', () => {
  it('records the decider’s own release request at once, from the rule the owner wrote, and says so', async () => {
    const before = await filings();
    const rule = await ruleBy(w.stand.alice, 'Khi tuyen xin release thì ghi luôn, đừng hỏi lại', {
      member: 'tuyen',
      acts: ['filing'],
    });
    expect(rule.decides, JSON.stringify(rule)).toMatchObject({ member: 'tuyen', stands: true });
    // the record both the brief and the agreement read: the rule, whom it names and why it stands
    expect(await ruleRows()).toContainEqual(
      expect.objectContaining({
        author: 'alice',
        decides: { member: 'tuyen', acts: ['filing'], by: 'owner' },
      }),
    );

    const own = await ownRecordRequest(tuyen, 'release trước 620 và 621');
    // the session is told her request is her agreement, and why, so it asks her nothing
    expect(String(own.proposed.next)).toContain('names them the one who decides');
    expect(String(own.proposed.next)).toContain('ask them nothing');
    // the session reads the same record: the changed rule reached it under the rule's words
    expect(own.turn.text).toContain('Forge holds it: @tuyen decides recording work (a filing)');
    expect(own.agreed, JSON.stringify(own.agreed)).toMatchObject({ recorded: true });
    // policy input, said where it is used: on the answer and on the audit fact
    expect(String(own.agreed.what)).toContain("It counted as @tuyen's agreement");
    expect(await consentIn(own.thread)).toMatchObject({
      actor_key: tuyen.userId,
      output: { consent: 'named_decider', ruleAuthor: 'alice', ruleBy: 'owner' },
    });
    expect(await filings()).toBe(before + 1);
    expect(OWNER_ID).toBe(w.stand.alice.userId);
  });

  it('counts the decider’s plain go on a proposal put to her, and nobody else’s', async () => {
    // sidpeak, 2026-11-06: the agent put a release to her, she answered "lên luôn nha", and it asked
    // her to type a set word; her plain go on a proposal of the act she decides is her agreement
    const before = await filings();
    let proposed: Record<string, unknown> = {};
    const asked = await w.hear(
      () => chat.say(chat.bob, 'cần release bản sửa bảng lương'),
      async (_t, act, message) => {
        const m = message();
        proposed = await act({
          action: 'record',
          thread: m.thread,
          kind: 'request',
          title: 'Release the payslip fix',
          summary: 'Release the payslip fix',
          asker: chat.bob.userId,
        });
      },
    );
    expect(proposed, JSON.stringify(proposed)).toMatchObject({ pending: true });
    const proposal = String(proposed.proposal);
    // dave, a Product member no rule names, answers first: refused, naming who may
    const daveSays = await w.agreeBy(dave, 'ok release', asked.id, proposal);
    expect(code(daveSays.out), JSON.stringify(daveSays.out)).toBe('SUPPORT_NOT_A_CONFIRMER');
    expect(JSON.stringify(daveSays.out)).toContain('names as the one who decides it');
    const tuyenSays = await w.agreeBy(tuyen, 'lên luôn nha', asked.id, proposal);
    expect(tuyenSays.out, JSON.stringify(tuyenSays.out)).toMatchObject({ recorded: true });
    expect(String(tuyenSays.out.what)).toContain("It counted as @tuyen's agreement");
    expect(await consentIn(asked.id)).toMatchObject({
      actor_key: tuyen.userId,
      output: { consent: 'named_decider', ruleAuthor: 'alice', ruleBy: 'owner' },
    });
    expect(await filings()).toBe(before + 1);
  });

  it('still refuses anyone else’s earlier request by name, teaching who counts', async () => {
    const before = await filings();
    const bob = await ownRecordRequest(chat.bob, 'please record that my payslips show no overtime');
    expect(String(bob.proposed.next)).not.toContain('their own request');
    expect(code(bob.agreed), JSON.stringify(bob.agreed)).toBe('SUPPORT_AGREEMENT_BEFORE_PROPOSAL');
    expect(JSON.stringify(bob.agreed)).toContain('names as the one who decides it');
    expect(await filings()).toBe(before);
  });

  it('counts the decider for the acts the rule names only: her own deploy request still waits', async () => {
    let proposed: Record<string, unknown> = {};
    let agreed: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(tuyen, 'deploy dev đi'),
      async (_t, act, message) => {
        const m = message();
        proposed = await act({ action: 'deploy', thread: m.thread, target: w.devTarget });
        agreed = await act({
          action: 'agree',
          thread: m.thread,
          proposal: String(proposed.proposal),
          message: String(m.message),
        });
      },
    );
    expect(proposed, JSON.stringify(proposed)).toMatchObject({ pending: true });
    expect(code(agreed), JSON.stringify(agreed)).toBe('SUPPORT_AGREEMENT_BEFORE_PROPOSAL');
  });

  it('keeps a non-owner Product member’s rule as a rule that names no decider', async () => {
    const before = await filings();
    const rule = await ruleBy(dave, 'Khi bob xin release thì ghi luôn', {
      member: 'bob',
      acts: ['filing'],
    });
    expect(rule.decides, JSON.stringify(rule)).toMatchObject({ member: 'bob', stands: false });
    expect(String((rule.decides as { says: string }).says)).toContain('names no decider');
    expect(await ruleRows()).toContainEqual(
      expect.objectContaining({
        author: 'dave',
        decides: { member: 'bob', acts: ['filing'], by: null },
      }),
    );
    const bob = await ownRecordRequest(chat.bob, 'release trước 630');
    expect(String(bob.proposed.next)).not.toContain('their own request');
    expect(code(bob.agreed), JSON.stringify(bob.agreed)).toBe('SUPPORT_AGREEMENT_BEFORE_PROPOSAL');
    expect(await filings()).toBe(before);
  });
});
