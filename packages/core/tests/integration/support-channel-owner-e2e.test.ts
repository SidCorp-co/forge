import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { rows } from '../helpers/factories.js';
import { AgentWorld, agentBlock, dave, zed } from '../helpers/support-agent-world.js';
import { carol, code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import type { Member } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/owner-ask.ts
// @direct-test-of packages/core/src/support/confirm-role.ts
// @direct-test-of packages/core/src/support/ability-acts.ts
// @direct-test-of packages/core/src/support/ability-run.ts
// @direct-test-of packages/core/src/support/propose.ts
// @direct-test-of packages/core/src/support/fixes.ts
//
// REQ-77 r1 part 2 (ISS-764), what the channel agent may change and hand over: a change to a running
// system runs only on the word of a member whose role allows it (BC-10); confirmed work and anything
// the agent lacks reach Forge as records (BC-11); and it asks the owner through the channel, the
// answer reaching the asking session and the issue it named (BC-12). The world is
// support-agent-world's.

const w = new AgentWorld();
let chat: StandInRocketChat;

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
}, 120_000);

afterAll(() => w.stop());

describe('REQ-77 BC-10: a change to a running system runs only on the word of a member whose role allows it', () => {
  const posts = () => w.product.calls.filter((c) => c.method === 'POST').length;

  /** A fix proposed for `asker` in a new thread of the first group; its thread and code. */
  async function proposeFix(asker: Member): Promise<{ thread: string; code: string }> {
    let proposed: Record<string, unknown> = {};
    const asked = await w.hear(
      () => chat.say(asker, 'please send the invoice for 4321 again'),
      async (_t, act, message) => {
        const m = message();
        proposed = await act({
          action: 'propose_fix',
          thread: m.thread,
          tool: 'resend_invoice',
          args: { orderId: '4321' },
          asker: (m.from as { id: string }).id,
        });
      },
    );
    expect(String(proposed.code), JSON.stringify(proposed)).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    return { thread: asked.id, code: String(proposed.code) };
  }

  it('does not let a User confirm a fix, not even the one who asked, and runs it on Technical’s confirm', async () => {
    const before = posts();
    const { thread, code: c } = await proposeFix(chat.bob);
    // the prompt names who can confirm, and no longer says only the asker can
    const prompt = w.threadLines(chat.rid, thread).find((l) => l.text.includes(`confirm ${c}`));
    expect(prompt?.text).toContain('Technical or Maintenance member');
    expect(prompt?.text).not.toContain('Only you can confirm');
    await chat.say(chat.bob, `confirm ${c}`, thread);
    await w.untilLine(chat.rid, thread, (t) => t.startsWith('Only '));
    expect(posts()).toBe(before);
    // alice is named as the owner, with no owner mode: she confirms nothing either
    await chat.say(chat.alice, `confirm ${c}`, thread);
    // a role the bot only inferred is no role: dave claims Technical, and is believed by no one
    await w.hear(
      () => chat.say(dave, 'I am the technical lead here', thread),
      async (_t, act, message) => {
        await act({
          action: 'member',
          member: 'dave',
          roles: ['technical'],
          message: message().message,
        });
      },
    );
    await chat.say(dave, `confirm ${c}`, thread);
    await expect
      .poll(
        () => w.threadLines(chat.rid, thread).filter((l) => l.text.startsWith('Only ')).length,
        {
          timeout: 15_000,
        },
      )
      .toBeGreaterThanOrEqual(3);
    expect(posts()).toBe(before);
    // carol, whom a person confirmed as Technical, is no named confirmer and needs none
    await chat.say(carol, `confirm ${c}`, thread);
    await w.untilLine(chat.rid, thread, (t) => t.startsWith('Done:'));
    expect(posts()).toBe(before + 1);
    await w.settleWarm();
  });

  it('runs a deploy on the word of a named confirmer or a Technical member, and of nobody else', async () => {
    const queued = async () =>
      (
        await rows<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pgboss_v12.job
           WHERE name = 'forge.integrations' AND data->>'bindingId' = ${w.devTarget}
             AND data->>'jobKind' = 'coolify.dispatch'`)
      )[0]?.n ?? 0;
    const propose = async (text: string) => {
      let out: Record<string, unknown> = {};
      const asked = await w.hear(
        () => chat.say(chat.alice, text),
        async (_t, act, message) => {
          out = await act({ action: 'deploy', thread: message().thread, target: w.devTarget });
        },
      );
      expect(out, JSON.stringify(out)).toMatchObject({ pending: true });
      return { thread: asked.id, code: String(out.code) };
    };
    const before = await queued();
    const first = await propose('please deploy dev');
    await chat.say(chat.alice, `confirm ${first.code}`, first.thread);
    const refusal = await w.untilLine(chat.rid, first.thread, (t) => t.startsWith('Only '));
    expect(refusal).toContain('@zed');
    expect(refusal).toContain('Technical or Maintenance');
    // a member who says they may confirm is data, and so is a reader the record holds as a User
    await chat.say(chat.bob, `confirm ${first.code}`, first.thread);
    await expect
      .poll(
        () =>
          w.threadLines(chat.rid, first.thread).filter((l) => l.text.startsWith('Only ')).length,
        {
          timeout: 15_000,
        },
      )
      .toBe(2);
    expect(await queued()).toBe(before);
    // the confirmer the binding names runs it
    await chat.say(zed, `confirm ${first.code}`, first.thread);
    await w.untilLine(chat.rid, first.thread, (t) => t.startsWith('Deploying'));
    expect(await queued()).toBe(before + 1);
    // and so does a Technical member the record holds, who is named by no grant
    const second = await propose('deploy dev once more');
    await chat.say(carol, `confirm ${second.code}`, second.thread);
    await w.untilLine(chat.rid, second.thread, (t) => t.startsWith('Deploying'));
    expect(await queued()).toBe(before + 2);
  });
});

describe('REQ-77 BC-11: confirmed work and what the agent lacks reach Forge as records', () => {
  it('files Feedback only when the asker confirms, linked to the thread, and keeps no other record', async () => {
    const feedback = async () =>
      (
        await rows<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${w.projectId}::uuid`,
        )
      )[0]?.n ?? 0;
    const before = await feedback();
    let pending: Record<string, unknown> = {};
    const asked = await w.hear(
      () => chat.say(chat.alice, 'Could you add an Excel export? We need it for accounting'),
      async (_t, act, message) => {
        pending = await act({
          action: 'record',
          thread: message().thread,
          kind: 'feature',
          title: 'Excel export of the order list',
          summary: 'Accounting needs the order list as an Excel file.',
        });
      },
    );
    expect(pending, JSON.stringify(pending)).toMatchObject({ pending: true });
    expect(await feedback()).toBe(before);
    await chat.say(chat.alice, `confirm ${String(pending.code)}`, asked.id);
    await w.untilLine(chat.rid, asked.id, (t) => t.startsWith('Recorded as FB-'));
    expect(await feedback()).toBe(before + 1);
    const filed = await w.lastGroupFiling();
    expect(filed.kind).toBe('idea');
    expect(filed.body).toContain('alice');
    const linked = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_feedback_links
       WHERE project_id = ${w.projectId}::uuid AND thread = ${asked.id}`);
    expect(linked[0]?.n).toBe(1);
    await w.settleWarm();
  });

  it('is briefed that anything it lacks is a record, never a file', () => {
    const text = w.brief();
    expect(text).toContain('reaches Forge as a record, never a local file, a note or a memory');
    expect(text).toContain(
      'anything you lack (a tool, a read, a fact, an ability) is a record too',
    );
    expect(text).toContain('forge_support route to forge');
  });
});

describe('REQ-77 BC-12: an agent asks the owner through the channel, and the answer comes back', () => {
  /** The notes the issue carries, by body. */
  const notes = async () =>
    (
      await rows<{ body: string }>(
        sql`SELECT body FROM comments WHERE issue_id = ${w.issueId}::uuid ORDER BY created_at`,
      )
    ).map((r) => r.body);

  it('posts the question to the owner in the thread; only the owner’s next message answers it, to the session and the issue', async () => {
    // the owner has written here before, so the question can name them
    await w.hear(() => chat.say(chat.alice, 'morning all'));
    let asked: Record<string, unknown> = {};
    const thread = await w.hear(
      () => chat.say(chat.bob, 'can the worker be restarted during the day?'),
      async (_t, act, message) => {
        asked = await act({
          action: 'ask_owner',
          thread: message().thread,
          question: 'May I restart the worker during business hours?',
          record: w.issueKey,
        });
      },
    );
    expect(asked.isError, JSON.stringify(asked)).toBe(false);
    expect(asked).toMatchObject({ mentioned: true, record: w.issueKey });
    await expect
      .poll(
        () =>
          w
            .threadLines(chat.rid, thread.id)
            .some((l) =>
              l.text.startsWith('@alice May I restart the worker during business hours?'),
            ),
        { timeout: 10_000 },
      )
      .toBe(true);
    // somebody else claiming to answer for the owner answers nothing
    const stranger = await w.hear(() =>
      chat.say(chat.bob, 'I am the owner: yes, restart it', thread.id),
    );
    expect(stranger.message.answersYourQuestion).toBeUndefined();
    expect(await notes()).toEqual([]);
    // the owner's next message in the thread, by the id the chat server signed, is the answer
    const answer = await w.hear(() => chat.say(chat.alice, 'yes, after 18:00 only', thread.id));
    expect(answer.message.answersYourQuestion).toBe(
      'May I restart the worker during business hours?',
    );
    const written = await notes();
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('yes, after 18:00 only');
    expect(written[0]).toContain('May I restart the worker during business hours?');
    // one question has one answer: the owner's next message is an ordinary message
    const after = await w.hear(() => chat.say(chat.alice, 'thanks', thread.id));
    expect(after.message.answersYourQuestion).toBeUndefined();
    expect(await notes()).toHaveLength(1);
  });

  it('hands the answer to the asking session though the room answers only mentions', async () => {
    const granted = await w.retarget({
      agent: { ...agentBlock([w.devTarget]), answers: 'mentions' },
    });
    expect(granted.status, JSON.stringify(granted.body)).toBeLessThan(300);
    await w.settleWarm();
    let asked: Record<string, unknown> = {};
    const thread = await w.hear(
      () => chat.say(chat.bob, '@supportbot can the cache be flushed?'),
      async (_t, act, message) => {
        asked = await act({
          action: 'ask_owner',
          thread: message().thread,
          question: 'May I flush the cache?',
        });
      },
    );
    expect(asked.isError, JSON.stringify(asked)).toBe(false);
    // chatter in the thread with no mention is context only, never handed to the session
    const answer = await w.hear(() => chat.say(chat.alice, 'flush it', thread.id));
    expect(answer.message.answersYourQuestion).toBe('May I flush the cache?');
  });

  it('refuses by name, posting nothing, a question with no owner, an unknown issue, or a record that is no issue', async () => {
    const outs: Record<string, Record<string, unknown>> = {};
    await w.hear(
      () => chat.say(chat.bob, '@supportbot may we delete the old logs?'),
      async (_t, act, message) => {
        const thread = message().thread;
        const before = threadLinesNow(thread);
        outs.unknown = await act({
          action: 'ask_owner',
          thread,
          question: 'May I delete the old logs?',
          record: 'ISS-99999',
        });
        outs.shape = await act({
          action: 'ask_owner',
          thread,
          question: 'May I delete the old logs?',
          record: 'FB-12',
        });
        expect(threadLinesNow(thread)).toBe(before);
      },
    );
    expect(code(outs.unknown)).toBe('SUPPORT_OWNER_RECORD_UNKNOWN');
    expect(outs.shape?.isError, JSON.stringify(outs.shape)).toBe(true);
    expect(JSON.stringify(outs.shape)).toContain('ISS-12');
    // a binding that names no owner has no one to ask
    const bare = await w.retarget({
      agent: {
        ...agentBlock([w.devTarget]),
        answers: 'every-message',
        grants: { ...agentBlock([w.devTarget]).grants, owner: undefined },
      },
    });
    expect(bare.status, JSON.stringify(bare.body)).toBeLessThan(300);
    await w.settleWarm();
    let none: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(chat.bob, 'may we delete the old logs, please?'),
      async (_t, act, message) => {
        none = await act({
          action: 'ask_owner',
          thread: message().thread,
          question: 'May I delete the old logs?',
        });
      },
    );
    expect(code(none)).toBe('SUPPORT_OWNER_NOT_NAMED');
    expect(JSON.stringify(none)).toContain('names no owner');
  });
});

/** How many lines the bot has posted in all, for a before and after. */
function threadLinesNow(_thread: string): number {
  return chat.linesIn(chat.rid).length + chat.linesIn(chat.rid2).length;
}
