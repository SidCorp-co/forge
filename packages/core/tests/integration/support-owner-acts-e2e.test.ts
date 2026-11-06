import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { rows } from '../helpers/factories.js';
import { AgentWorld, OWNER_ID } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/owner-consent.ts
//
// ISS-1013 (REQ-85, FB-507, FB-540): the owner asks his room to operate his product as him. He
// consents once, in his own words in his own room; the agent reads that his message is the
// agreement and cites it, and core records who, when, which product and which room, from what the
// chat server signed. One plain word of his withdraws it. Anyone else's message, and any other
// room, is refused by name, saying who can consent.

const w = new AgentWorld();
let chat: StandInRocketChat;

/** The owner's consents in the project, oldest first, as the row holds them. */
const consents = () =>
  rows<{
    owner_key: string;
    owner_label: string | null;
    room_rid: string;
    binding_label: string;
    given_message: string;
    withdrawn_message: string | null;
    withdrawn: boolean;
  }>(sql`
    SELECT c.owner_key, c.owner_label, r.rid AS room_rid, cn.display_name AS binding_label,
           c.given_message, c.withdrawn_message, c.withdrawn_at IS NOT NULL AS withdrawn
      FROM support_owner_consents c
      JOIN support_rooms r ON r.id = c.room_id
      JOIN integration_bindings b ON b.id = c.binding_id
      JOIN integration_connections cn ON cn.id = b.connection_id
     WHERE c.project_id = ${w.projectId}::uuid
     ORDER BY c.given_at, c.id`);

/** `who` writes `text` in group `rid`; the session cites that message as the owner's word. */
async function consentBy(
  who: typeof chat.alice,
  text: string,
  decision: 'give' | 'withdraw',
  opts: { rid?: string; product?: string } = {},
) {
  let out: Record<string, unknown> = {};
  const heard = await w.hear(
    () => (opts.rid ? chat.sayIn(opts.rid, who, text) : chat.say(who, text)),
    async (_t, act, message) => {
      out = await act({
        action: 'owner_consent',
        thread: message().thread,
        message: message().message,
        decision,
        ...(opts.product ? { product: opts.product } : {}),
        ...(opts.rid ? { rid: opts.rid } : {}),
      });
    },
  );
  return { id: heard.id, out };
}

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
}, 120_000);

afterAll(() => w.stop());

describe('ISS-1013: the owner consents in his own words, and withdraws with one (BC-3)', () => {
  it("records the owner's consent: who, when, which product, which room, and his message", async () => {
    const { id, out } = await consentBy(
      chat.alice,
      'Ừ, cứ dùng tài khoản của tôi để vận hành Catalog luôn',
      'give',
    );
    expect(out, JSON.stringify(out)).toMatchObject({
      isError: false,
      decision: 'give',
      already: false,
      consent: {
        product: 'Catalog API',
        room: chat.rid,
        owner: { account: OWNER_ID, name: 'alice' },
        givenMessage: id,
        withdrawnAt: null,
      },
    });
    expect(Date.parse(String((out.consent as { givenAt: string }).givenAt))).not.toBeNaN();
    expect(await consents()).toEqual([
      {
        owner_key: OWNER_ID,
        owner_label: 'alice',
        room_rid: chat.rid,
        binding_label: 'Catalog API',
        given_message: id,
        withdrawn_message: null,
        withdrawn: false,
      },
    ]);
    const [audit] = await rows<{ actor_key: string; input: Record<string, unknown> }>(sql`
      SELECT actor_key, input FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND kind = 'owner_consented'`);
    expect(audit).toEqual({
      actor_key: OWNER_ID,
      input: { product: 'Catalog API', message: id, citedBy: 'session' },
    });
  });

  it('given again while it stands, the one consent stands and no second is recorded', async () => {
    const { out } = await consentBy(chat.alice, 'yes, as I said, go ahead', 'give', {
      product: 'Catalog API',
    });
    expect(out, JSON.stringify(out)).toMatchObject({ isError: false, already: true });
    expect(await consents()).toHaveLength(1);
  });

  it('withdraws it with his one plain word, and none stands after', async () => {
    const { id, out } = await consentBy(chat.alice, 'thôi', 'withdraw');
    expect(out, JSON.stringify(out)).toMatchObject({
      isError: false,
      decision: 'withdraw',
      withdrawn: [{ product: 'Catalog API', withdrawnMessage: id }],
    });
    expect((await consents()).map((c) => [c.withdrawn, c.withdrawn_message])).toEqual([[true, id]]);
    // withdrawn again, nothing stood, and it says so
    const again = await consentBy(chat.alice, 'stop', 'withdraw');
    expect(again.out, JSON.stringify(again.out)).toMatchObject({ isError: false, withdrawn: [] });
    expect(String(again.out.says)).toContain('no consent of his stood');
  });
});

describe('ISS-1013: nobody else consents, and no other room (BC-1, BC-7)', () => {
  it('refuses a message the owner did not write, naming who can consent, and records nothing', async () => {
    const { out } = await consentBy(chat.bob, 'sure, use the owner account', 'give');
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_CONSENT_NOT_THE_OWNER');
    expect(JSON.stringify(out)).toContain('only @alice, the owner this binding names, can consent');
    expect((await consents()).filter((c) => !c.withdrawn)).toEqual([]);
  });

  it("refuses the owner's consent in another room, naming his own room", async () => {
    const { out } = await consentBy(chat.alice, 'yes go ahead', 'give', { rid: chat.rid2 });
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_OWNER_OTHER_ROOM');
    expect(JSON.stringify(out)).toContain(`in his own words in his own room ${chat.rid}`);
    expect((await consents()).filter((c) => !c.withdrawn)).toEqual([]);
  });

  it('refuses a product the project does not bind, naming the ones it does', async () => {
    const { out } = await consentBy(chat.alice, 'yes for Agenfold', 'give', {
      product: 'Agenfold',
    });
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_OWNER_PRODUCT_UNKNOWN');
    expect(JSON.stringify(out)).toContain('it binds Catalog API');
  });
});
