import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { AgentWorld, agentBlock, dave } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import type { Member } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/deciders.ts
// @direct-test-of packages/core/src/support/fixes.ts
// @direct-test-of packages/core/src/support/confirm-role.ts
// @direct-test-of packages/core/src/support/channel.ts
// @direct-test-of packages/core/src/support/channel-read.ts
// @direct-test-of packages/core/src/support/propose.ts
// @direct-test-of packages/core/src/knowledge/ruling-deciders.ts
// @direct-test-of packages/core/src/knowledge/upsert.ts
//
// ISS-1042 (owner ruling 2026-11-06, "read what the user means; never make them follow a text form"):
// sidpeak's room decider is tuyendtb, from the project's 2026-11-05 ruling. ISS-1000 made her plain go
// count only after a `support.rule { decides }` typed in the room by the owner or a confirmed
// Technical/Maintenance member. Who decides now comes from the project's rulings: a `rule` knowledge
// entry naming her, written by a master through the knowledge door. Her go in any words, on a proposal
// put to her or in her own request, is her agreement, with no room rule; a person not named is asked
// as before, and the refusal names who can agree.

const tuyen: Member = { userId: 'u-tuyen', username: 'tuyen' };
const RULING = 'release-decider';

const w = new AgentWorld();
let chat: StandInRocketChat;

/** The master's write: the ruling as a `rule` knowledge entry naming its deciders. */
const putRuling = (slug: string, body: Record<string, unknown>) =>
  api(w.owner, 'PUT', `/api/projects/${w.projectId}/knowledge/${slug}`, {
    title: 'Production releases on tuyen’s word',
    body: 'Owner ruling 2026-11-05: in the support room, a release goes ahead on tuyen’s word.',
    kind: 'rule',
    confidence: 'verified',
    source: 'owner ruling 2026-11-05, ISS-1042',
    scope: 'the support room of this project',
    recheckWhen: 'the owner rules again on who decides a release',
    ...body,
  });

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
  const ruled = await putRuling(RULING, {
    metadata: { deciders: [{ member: 'tuyen', acts: ['filing'] }] },
  });
  expect(ruled.status, JSON.stringify(ruled.body)).toBe(200);
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

describe('ISS-1042: the member the project’s rulings name as decider agrees in any words', () => {
  it('records her own release request at once, with no room rule, and the brief names her', async () => {
    const before = await filings();
    // nothing typed in the room names her: the record holds no rule at all
    expect((await w.channel()).ruleRows).toEqual([]);

    const own = await ownRecordRequest(tuyen, 'release trước 620 và 621');
    // the session is told her request is her agreement, and which ruling says so
    expect(String(own.proposed.next)).toContain(
      `the project's ruling [knowledge:${RULING}] names them the one who decides`,
    );
    expect(String(own.proposed.next)).toContain('ask them nothing');
    // the session reads the same source: the brief's record names her under the ruling
    expect(own.turn.text).toContain('Who decides, from the project');
    expect(own.turn.text).toContain(
      `@tuyen decides recording work (a filing) [knowledge:${RULING}]`,
    );
    expect(own.agreed, JSON.stringify(own.agreed)).toMatchObject({ recorded: true });
    // policy input, said where it is used: on the answer and on the audit fact
    expect(String(own.agreed.what)).toContain("It counted as @tuyen's agreement");
    expect(await consentIn(own.thread)).toMatchObject({
      actor_key: tuyen.userId,
      output: { consent: 'named_decider', ruling: RULING },
    });
    expect(await filings()).toBe(before + 1);
  });

  it('counts her plain go on a proposal put to her, and asks anyone else as before', async () => {
    // sidpeak, 2026-11-06: the agent put a release to her and she answered "lên luôn nha"
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
    // bob is no decider: the session is told to ask, as before
    expect(proposed, JSON.stringify(proposed)).toMatchObject({ pending: true });
    expect(String(proposed.next)).toContain('Ask ');
    const proposal = String(proposed.proposal);
    // dave, a Product member no ruling names, answers first: refused, naming who can agree
    const daveSays = await w.agreeBy(dave, 'ok release', asked.id, proposal);
    expect(code(daveSays.out), JSON.stringify(daveSays.out)).toBe('SUPPORT_NOT_A_CONFIRMER');
    expect(JSON.stringify(daveSays.out)).toContain(
      "@tuyen, whom the project's rulings name as deciding recording work (a filing)",
    );
    const tuyenSays = await w.agreeBy(tuyen, 'lên luôn nha', asked.id, proposal);
    expect(tuyenSays.out, JSON.stringify(tuyenSays.out)).toMatchObject({ recorded: true });
    expect(String(tuyenSays.out.what)).toContain("It counted as @tuyen's agreement");
    expect(await consentIn(asked.id)).toMatchObject({
      actor_key: tuyen.userId,
      output: { consent: 'named_decider', ruling: RULING },
    });
    expect(await filings()).toBe(before + 1);
  });

  it('still refuses anyone else’s earlier request by name, teaching who counts', async () => {
    const before = await filings();
    const bob = await ownRecordRequest(chat.bob, 'please record that my payslips show no overtime');
    expect(String(bob.proposed.next)).not.toContain('their own request');
    expect(code(bob.agreed), JSON.stringify(bob.agreed)).toBe('SUPPORT_AGREEMENT_BEFORE_PROPOSAL');
    expect(JSON.stringify(bob.agreed)).toContain("whom the project's rulings name as deciding");
    expect(await filings()).toBe(before);
  });

  it('counts her for the acts the ruling names only: her own deploy request still waits', async () => {
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
    expect(JSON.stringify(agreed)).toContain(
      "the project's rulings name nobody who decides a deploy",
    );
  });

  it('refuses the old room-typed decides by name, and a rule said in the room names nobody', async () => {
    let refused: Record<string, unknown> = {};
    let kept: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(chat.alice, 'Khi dave xin release thì ghi luôn, đừng hỏi lại'),
      async (_t, act, message) => {
        const m = message();
        const rule = {
          action: 'rule',
          thread: m.thread,
          message: m.message,
          text: 'When @dave asks for a release, record it at once.',
        };
        refused = await act({ ...rule, decides: { member: 'dave', acts: ['filing'] } });
        kept = await act(rule);
      },
    );
    // gone from the rule's shape: a caller still sending it is refused naming it, and nothing is kept
    expect(code(refused), JSON.stringify(refused)).toBe('BAD_REQUEST');
    expect(JSON.stringify(refused)).toContain('Unrecognized key: \\"decides\\"');
    expect(kept, JSON.stringify(kept)).toMatchObject({ rule: expect.any(String) });
    expect(kept).not.toHaveProperty('decides');
    // the owner's rule is kept as words, and dave's own request still waits for his plain yes
    const ruleRows = (await w.channel()).ruleRows as Record<string, unknown>[];
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows[0]).not.toHaveProperty('decides');
    const before = await filings();
    const own = await ownRecordRequest(dave, 'release trước 630');
    expect(String(own.proposed.next)).not.toContain('their own request');
    expect(code(own.agreed), JSON.stringify(own.agreed)).toBe('SUPPORT_AGREEMENT_BEFORE_PROPOSAL');
    expect(await filings()).toBe(before);
  });

  it('refuses a ruling naming its deciders wrongly, by name, with the shape that is valid', async () => {
    const act = await putRuling('bad-act', {
      metadata: { deciders: [{ member: 'tuyen', acts: ['release'] }] },
    });
    expect(act.status, JSON.stringify(act.body)).toBe(422);
    expect(JSON.stringify(act.body)).toContain('KNOWLEDGE_DECIDERS_SHAPE');
    expect(JSON.stringify(act.body)).toContain('/metadata/deciders/0/acts/0');
    expect(JSON.stringify(act.body)).toContain('acts: (fix | filing | deploy | command | build)[]');
    const guide = await putRuling('not-a-rule', {
      kind: 'guide',
      metadata: { deciders: [{ member: 'tuyen', acts: ['filing'] }] },
    });
    expect(guide.status, JSON.stringify(guide.body)).toBe(422);
    expect(JSON.stringify(guide.body)).toContain('only a ruling, an entry of kind `rule`');
    const nobody = await putRuling('nobody', { metadata: { deciders: [] } });
    expect(nobody.status, JSON.stringify(nobody.body)).toBe(422);
    expect(JSON.stringify(nobody.body)).toContain('KNOWLEDGE_DECIDERS_SHAPE');
    // none of them was stored
    const stored = await rows<{ slug: string }>(sql`
      SELECT slug FROM knowledge_entries WHERE project_id = ${w.projectId}::uuid
         AND slug IN ('bad-act', 'not-a-rule', 'nobody')`);
    expect(stored).toEqual([]);
  });

  it('stops counting her once the ruling is gone, and the brief stops naming her', async () => {
    const gone = await api(w.owner, 'DELETE', `/api/projects/${w.projectId}/knowledge/${RULING}`);
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    const before = await filings();
    const own = await ownRecordRequest(tuyen, 'release trước 640');
    expect(own.turn.text).not.toContain('@tuyen decides');
    expect(String(own.proposed.next)).not.toContain('their own request');
    expect(code(own.agreed), JSON.stringify(own.agreed)).toBe('SUPPORT_AGREEMENT_BEFORE_PROPOSAL');
    expect(await filings()).toBe(before);
  });
});
