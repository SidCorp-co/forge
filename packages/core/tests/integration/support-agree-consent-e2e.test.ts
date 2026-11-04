import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { rows } from '../helpers/factories.js';
import { AgentWorld, agentBlock, dave, OWNER_ID, zed } from '../helpers/support-agent-world.js';
import { carol, code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import type { Member } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/fixes.ts
// @direct-test-of packages/core/src/support/propose.ts
// @direct-test-of packages/core/src/support/confirm-role.ts
//
// Who consents by their own word (FB-489, FB-490). ISS-953: an asker the room already lets confirm —
// a confirmer the binding names, a member the channel record confirms as Technical or Maintenance —
// consents by their own request, as the owner did alone. ISS-954: no live channel binding grants
// owner mode, so the owner it names was asked to say ok to work he had just ordered; his order in a
// thread now settles a filing there, whoever reported it and whenever he ordered it, while a build, a
// deploy or a host change keeps its confirmer gate. The world is support-agent-world's, whose
// binding names an owner and grants no owner mode, as the live ones do.

const w = new AgentWorld();
let chat: StandInRocketChat;

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  const plain = agentBlock([w.devTarget], chat.rid);
  expect(plain.grants.abilities).not.toContain('owner_mode');
  const set = await w.retarget({ agent: { ...plain, answers: 'every-message' } });
  expect(set.status, JSON.stringify(set.body)).toBeLessThan(300);
  await w.settleWarm();
}, 120_000);

afterAll(() => w.stop());

const filings = async () =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${w.projectId}::uuid`,
    )
  )[0]?.n ?? 0;

/** The consent core recorded on the filing settled in `thread`. */
const consentIn = async (thread: string) =>
  (
    await rows<{ actor_key: string; output: unknown }>(sql`
      SELECT actor_key, output FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND thread = ${thread} AND kind = 'fix_confirmed'`)
  )[0];

/**
 * `who` writes `text` (in `thread`, else a new one); in that turn the session records a request for
 * `asker` (the writer by default) and cites the message `cite` picks (the one just written) with agree.
 */
async function writeRecordAndCite(
  who: Member,
  text: string,
  opts: { asker?: string; thread?: string; cite?: (written: string) => string } = {},
): Promise<{ thread: string; proposed: Record<string, unknown>; agreed: Record<string, unknown> }> {
  let proposed: Record<string, unknown> = {};
  let agreed: Record<string, unknown> = {};
  const asked = await w.hear(
    () => chat.say(who, text, opts.thread),
    async (_t, act, message) => {
      const m = message();
      proposed = await act({
        action: 'record',
        thread: m.thread,
        kind: 'request',
        title: `Asked: ${text.slice(0, 40)}`,
        summary: text,
        asker: opts.asker ?? who.userId,
      });
      agreed = await act({
        action: 'agree',
        thread: m.thread,
        proposal: String(proposed.proposal),
        message: opts.cite ? opts.cite(String(m.message)) : String(m.message),
      });
    },
  );
  expect(proposed, JSON.stringify(proposed)).toMatchObject({ pending: true });
  return { thread: opts.thread ?? asked.id, proposed, agreed };
}

/** `who` reports in a new thread; in that turn the session records it for them, agreeing to nothing. */
async function reportAndPropose(who: Member, text: string) {
  let proposed: Record<string, unknown> = {};
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
    },
  );
  expect(proposed, JSON.stringify(proposed)).toMatchObject({ pending: true });
  return { thread: asked.id, proposal: String(proposed.proposal) };
}

describe('ISS-953: an asker the room lets confirm consents by their own request', () => {
  it('records the own request of the named confirmer and of a confirmed Technical member at once', async () => {
    const before = await filings();
    for (const [who, text] of [
      [zed, 'please record that the refund page shows no totals'],
      [carol, 'please record that the sync log repeats each line'],
    ] as const) {
      const own = await writeRecordAndCite(who, text);
      expect(String(own.proposed.next)).toContain('their own request is their agreement');
      expect(own.agreed, JSON.stringify(own.agreed)).toMatchObject({ recorded: true });
      expect(await consentIn(own.thread)).toMatchObject({
        actor_key: who.userId,
        output: { consent: 'own_request' },
      });
    }
    expect(await filings()).toBe(before + 2);
  });

  it('refuses a User’s own earlier request, and a confirmer’s earlier message cited for another asker', async () => {
    const before = await filings();
    const bob = await writeRecordAndCite(
      chat.bob,
      'please record that my invoices show the wrong VAT',
    );
    expect(String(bob.proposed.next)).not.toContain('their own request');
    expect(code(bob.agreed), JSON.stringify(bob.agreed)).toBe('SUPPORT_AGREEMENT_BEFORE_PROPOSAL');
    const zedSaid = await w.hear(() => chat.say(zed, 'we should log the slow exports'));
    const cited = await writeRecordAndCite(chat.bob, 'please record the slow exports', {
      thread: zedSaid.id,
      cite: () => zedSaid.id,
    });
    expect(code(cited.agreed), JSON.stringify(cited.agreed)).toBe(
      'SUPPORT_AGREEMENT_BEFORE_PROPOSAL',
    );
    expect(await filings()).toBe(before);
  });
});

describe('ISS-954: the owner the binding names settles a filing in its thread, without owner mode', () => {
  it('records a reporter’s filing on the owner’s “Lỗi thì fix đi” after the proposal', async () => {
    const before = await filings();
    const filed = await reportAndPropose(
      chat.bob,
      'Pixelight contacts arrive unsubscribed since 20/10',
    );
    const owner = await w.agreeBy(chat.alice, 'Lỗi thì fix đi', filed.thread, filed.proposal);
    expect(owner.out, JSON.stringify(owner.out)).toMatchObject({ recorded: true });
    expect(await filings()).toBe(before + 1);
    expect(await consentIn(filed.thread)).toMatchObject({
      actor_key: OWNER_ID,
      output: { consent: 'owner_order' },
    });
  });

  it('records a reporter’s filing on the owner’s order given before the proposal, in its thread', async () => {
    const before = await filings();
    const bobSaid = await w.hear(() => chat.say(chat.bob, 'the CDP sync drops the phone field'));
    const ordered = await writeRecordAndCite(chat.alice, '@babo Lỗi thì fix đi', {
      thread: bobSaid.id,
      asker: chat.bob.userId,
    });
    expect(ordered.agreed, JSON.stringify(ordered.agreed)).toMatchObject({ recorded: true });
    expect(await filings()).toBe(before + 1);
  });

  it('records the owner’s own filing request at once, telling the session so', async () => {
    const before = await filings();
    const own = await writeRecordAndCite(
      chat.alice,
      'record that the label printer skips page two',
    );
    expect(String(own.proposed.next)).toContain('their own request is their agreement');
    expect(own.agreed, JSON.stringify(own.agreed)).toMatchObject({ recorded: true });
    expect(await filings()).toBe(before + 1);
  });
});

describe('ISS-954: what the owner’s word without owner mode still does not settle', () => {
  it('refuses another member’s word on a reporter’s filing, naming the owner who may agree', async () => {
    const before = await filings();
    const filed = await reportAndPropose(chat.bob, 'the returns page shows last month');
    const daveSays = await w.agreeBy(dave, 'fix it', filed.thread, filed.proposal);
    expect(code(daveSays.out), JSON.stringify(daveSays.out)).toBe('SUPPORT_NOT_A_CONFIRMER');
    expect(JSON.stringify(daveSays.out)).toContain('or the owner');
    expect(await filings()).toBe(before);
  });

  it('keeps a deploy gated: the owner’s word without owner mode runs none', async () => {
    let proposed: Record<string, unknown> = {};
    const asked = await w.hear(
      () => chat.say(chat.bob, 'please deploy dev'),
      async (_t, act, message) => {
        proposed = await act({ action: 'deploy', thread: message().thread, target: w.devTarget });
      },
    );
    expect(proposed, JSON.stringify(proposed)).toMatchObject({ pending: true });
    const owner = await w.agreeBy(chat.alice, 'deploy đi', asked.id, String(proposed.proposal));
    expect(code(owner.out), JSON.stringify(owner.out)).toBe('SUPPORT_NOT_A_CONFIRMER');
  });

  it('under owner mode settles any proposal on his word, and names his order where a User’s is refused', async () => {
    const granted = await w.retarget({
      agent: {
        ...agentBlock([w.devTarget], chat.rid),
        answers: 'every-message',
        grants: {
          ...agentBlock([w.devTarget], chat.rid).grants,
          abilities: ['file_items', 'deploy', 'owner_mode'],
        },
      },
    });
    expect(granted.status, JSON.stringify(granted.body)).toBeLessThan(300);
    await w.settleWarm();
    const bob = await writeRecordAndCite(
      chat.bob,
      'please record that the shipping label prints blank',
    );
    expect(code(bob.agreed), JSON.stringify(bob.agreed)).toBe('SUPPORT_AGREEMENT_BEFORE_PROPOSAL');
    expect(JSON.stringify(bob.agreed)).toContain("the owner's order");
    const owner = await w.agreeBy(
      chat.alice,
      'ok làm đi',
      bob.thread,
      String(bob.proposed.proposal),
    );
    expect(owner.out, JSON.stringify(owner.out)).toMatchObject({ recorded: true });
  });
});
