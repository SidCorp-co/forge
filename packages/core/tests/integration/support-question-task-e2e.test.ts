import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

// the chat room lane's agent, were it reached: the agenfold posts, unasked and in plain English
vi.mock('../../src/assistant/external-chat.js', () => ({
  runExternalChatTurn: async () => ({
    conversationId: null,
    reply: 'Room input is needed to unblock the run.',
    terminal: 'done',
    error: null,
    iterations: 1,
    toolCalls: [],
    progress: null,
    rounds: [],
  }),
}));

import { randomUUID } from 'node:crypto';
import { db } from '../../src/db/client.js';
import { namespaceFromServerUrl } from '../../src/integrations/rocketchat/namespace.js';
import { createTestFeedback, createTestIssue, rows } from '../helpers/factories.js';
import { AgentWorld, OWNER_ID } from '../helpers/support-agent-world.js';
import { type Act, carol, code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/question-task.ts
// @direct-test-of packages/core/src/support/owner-owed.ts
// @direct-test-of packages/core/src/support/prompt.ts
// @direct-test-of packages/core/src/support/owner-ask.ts
// @direct-test-of packages/core/src/support/screen.ts
// @direct-test-of packages/core/src/integrations/rocketchat/project-room.ts
//
// ISS-916: an owner's message answers a person-owed question he was shown, from any thread.
//
// ISS-873 (owner, agenfold 2026-11-02): a run's parked question in a project whose rooms a channel
// agent answers is never posted into a room by core. It is handed to the agent as a task in the
// owner's room's record; the agent answers it from the record (an approved image on linked
// feedback) and nothing is posted, or asks the owner once, in plain words with no code, inside the
// owner's room's one thread for the day's questions — never at a room's top level. A code in a
// team room's post is refused unless it is a reply inside a member's own thread.

const w = new AgentWorld();
let chat: StandInRocketChat;
let seq = 8500;
let drain: typeof import('../../src/assistant/chat-room/question-delivery.js').drainQuestionDeliveries;

/** A run parked on a new issue of the project, asking in words. */
async function parked(prompt: string): Promise<{ id: string; issueId: string }> {
  const issue = await createTestIssue(w.projectId, w.ownerId, ++seq, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  const { askQuestion } = await import('../../src/questions/index.js');
  const id = randomUUID();
  await askQuestion({
    id,
    projectId: w.projectId,
    issueId: issue.id,
    askedBy: w.ownerId,
    prompt,
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the image to use' },
  } as Parameters<typeof askQuestion>[0]);
  return { id, issueId: issue.id };
}

const question = async (id: string) =>
  (
    await rows<{ status: string; steps: Record<string, unknown>[] }>(
      sql`SELECT status, steps FROM agent_questions WHERE id = ${id}::uuid`,
    )
  )[0];

/** Every line the bot posted outside a thread, in both groups. */
const topLevel = () =>
  [...chat.linesIn(chat.rid), ...chat.linesIn(chat.rid2)].filter((l) => !l.tmid);

/** The question thread the agent was handed, once the drain hands it, and what it does there. */
async function handed(
  questionId: string,
  does: (thread: string, act: Act, note: string) => Promise<void>,
): Promise<void> {
  await w.settleWarm();
  let done = false;
  w.box.model = async (turn, act) => {
    const task = turn.messages.find((m) => m.thread.startsWith(`question-${questionId}`));
    if (!task || done) return;
    await does(task.thread, act as Act, task.text);
    done = true;
  };
  await drain(new Date());
  await expect.poll(() => done, { timeout: 20_000 }).toBe(true);
}

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  ({ drainQuestionDeliveries: drain } = await import(
    '../../src/assistant/chat-room/question-delivery.js'
  ));
}, 120_000);

afterAll(() => w.stop());

describe('ISS-873: a parked question in a channel agent project posts nothing by itself', () => {
  it('has the owner written in the owner room, linked to their Forge account', async () => {
    // the owner has written in the owner's room, and is linked to their Forge account
    await w.hear(() => chat.say(chat.alice, 'Chào cả nhà'));
    await db.execute(sql`
      INSERT INTO assistant_speaker_links (source, external_namespace, external_id, user_id, confirmed_via)
      VALUES ('rocketchat', ${namespaceFromServerUrl(chat.serverUrl)}, ${OWNER_ID}, ${w.ownerId}, 'channel_email_match')`);
    const [linked] = await rows<{ user_id: string }>(
      sql`SELECT user_id FROM assistant_speaker_links WHERE external_id = ${OWNER_ID}`,
    );
    expect(linked?.user_id).toBe(w.ownerId);
  });

  it('hands the agenfold round to the agent as a task, and no room gets a top-level post', async () => {
    const before = topLevel().length;
    const { id } = await parked('Which mockup image should the home page use?');
    let note = '';
    await handed(id, async (_thread, _act, text) => {
      note = text;
      // handed, and nothing posted yet: the agent decides
      expect(topLevel().length).toBe(before);
    });
    expect(note).toContain('Which mockup image should the home page use?');
    expect(note).toContain('answer it from the record');
    const [delivery] = await rows<{ status: string }>(
      sql`SELECT status FROM rocketchat_question_deliveries WHERE question_id = ${id}::uuid`,
    );
    expect(delivery?.status).toBe('delivered');
    expect(topLevel().length).toBe(before);
    expect(topLevel().map((l) => l.text)).not.toContain('Room input is needed to unblock the run.');
    // nor is a channel agent's room ever the project's question room, should the hand-off be missing
    const { roomForProject } = await import('../../src/integrations/rocketchat/index.js');
    expect(await roomForProject(w.projectId)).toBeNull();
  });

  it('answers from the approved image on linked feedback, posting nothing', async () => {
    const before = [...chat.linesIn(chat.rid), ...chat.linesIn(chat.rid2)].length;
    const { id, issueId } = await parked('Which image goes on the landing page?');
    await createTestFeedback(w.projectId, w.ownerId, 37, [issueId]);
    await rows(sql`
      INSERT INTO feedback_attachments (project_id, feedback_id, name, mime, size, storage_path, flagged, uploaded_by)
      SELECT project_id, id, 'landing-mockup.png', 'image/png', 12, 'feedback/x/landing-mockup.png', false, reported_by
        FROM feedback WHERE project_id = ${w.projectId}::uuid AND fb_seq = 37`);
    const outs: Record<string, unknown>[] = [];
    let note = '';
    await handed(id, async (thread, act, text) => {
      note = text;
      outs.push(await act({ action: 'answer_question', thread, answer: 'x' }));
      outs.push(
        await act({
          action: 'answer_question',
          thread: 'question-nothing-1',
          rid: chat.rid,
          source: 'FB-37',
        }),
      );
      outs.push(
        await act({
          action: 'answer_question',
          thread,
          source: 'FB-37, its attached landing-mockup.png',
          answer: 'landing-mockup.png',
        }),
      );
    });
    expect(note).toContain('landing-mockup.png');
    expect(code(outs[0])).toBe('SUPPORT_ANSWER_SOURCE');
    expect(code(outs[1])).toBe('SUPPORT_QUESTION_UNKNOWN');
    expect(outs[2]?.isError, JSON.stringify(outs[2])).toBe(false);
    const q = await question(id);
    expect(q?.status).toBe('answered');
    expect(q?.steps.at(-1)).toMatchObject({ answerText: 'landing-mockup.png' });
    expect([...chat.linesIn(chat.rid), ...chat.linesIn(chat.rid2)].length).toBe(before);
  });

  it('asks the owner once, in plain words, inside the day thread; a second round shares it', async () => {
    const first = await parked('Should the banner rotate?');
    const outs: Record<string, unknown>[] = [];
    let thread1 = '';
    await handed(first.id, async (thread, act) => {
      thread1 = thread;
      // a code is refused by name, and opens nothing
      outs.push(
        await act({
          action: 'ask_owner',
          thread,
          question: `ISS-${seq} is parked: pick option banner.rotate`,
          opener: 'Câu hỏi hôm nay',
        }),
      );
      // no day thread yet, and no line to open it
      outs.push(
        await act({ action: 'ask_owner', thread, question: 'Banner có tự chuyển không anh?' }),
      );
      outs.push(
        await act({
          action: 'ask_owner',
          thread,
          question: 'Banner trên trang chủ có tự chuyển không anh?',
          opener: 'Câu hỏi hôm nay cho anh',
        }),
      );
      // the same question again is not asked twice
      outs.push(
        await act({ action: 'ask_owner', thread, question: 'Banner có tự chuyển không anh?' }),
      );
    });
    expect(code(outs[0])).toBe('SUPPORT_INTERNAL_CODE');
    expect(code(outs[1])).toBe('SUPPORT_DAY_THREAD_OPENER');
    expect(outs[2]?.isError, JSON.stringify(outs[2])).toBe(false);
    expect(code(outs[3])).toBe('SUPPORT_OWNER_ALREADY_ASKED');
    const roots = topLevel().filter((l) => l.text === 'Câu hỏi hôm nay cho anh');
    expect(roots).toHaveLength(1);
    expect(topLevel().some((l) => l.text.includes('ISS-'))).toBe(false);
    const day = roots[0]?.id ?? '';
    expect(w.threadLines(chat.rid, day).map((l) => l.text)).toEqual([
      '@alice Banner trên trang chủ có tự chuyển không anh?',
    ]);

    // a second question the same day goes into the same thread, with no opener
    const second = await parked('Does the menu stick to the top?');
    const more: Record<string, unknown>[] = [];
    await handed(second.id, async (thread, act) => {
      more.push(
        await act({ action: 'ask_owner', thread, question: 'Menu có dính trên đầu không anh?' }),
      );
    });
    expect(more[0]?.isError, JSON.stringify(more[0])).toBe(false);
    expect(topLevel().filter((l) => l.text === 'Câu hỏi hôm nay cho anh')).toHaveLength(1);
    expect(w.threadLines(chat.rid, day)).toHaveLength(2);

    // the same round is not handed again: no second task, no post
    const lines = chat.linesIn(chat.rid).length;
    await drain(new Date());
    const [tasks] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_actions
       WHERE thread = ${thread1} AND kind = 'message_in' AND actor_kind = 'core'`);
    expect(tasks?.n).toBe(1);
    expect(chat.linesIn(chat.rid).length).toBe(lines);

    // the owner's answer in a thread holding two questions is recorded on none until the agent names it
    let told = '';
    let recorded: Record<string, unknown> = {};
    const said = await w.hear(
      () => chat.say(chat.alice, 'Có, cho tự chuyển', day),
      async (turn, act, message) => {
        told =
          turn.messages.find((m) => m.from === 'forge' && m.text.includes('recorded on none'))
            ?.text ?? '';
        recorded = await act({
          action: 'answer_question',
          thread: thread1,
          message: message().message ?? '',
        });
      },
    );
    expect(said.id).toBeTruthy();
    expect(told).toContain('recorded on none');
    expect(recorded.isError, JSON.stringify(recorded)).toBe(false);
    const q1 = await question(first.id);
    expect(q1?.status).toBe('answered');
    expect(q1?.steps.at(-1)).toMatchObject({
      answerText: 'Có, cho tự chuyển',
      answeredBy: w.ownerId,
    });
    expect((await question(second.id))?.status).toBe('open');
  });
});

describe('ISS-873: a team room shows a code only in a reply inside a member own thread', () => {
  it('lets a reply in the asker thread carry a code, and refuses an announcement holding one', async () => {
    const outs: Record<string, unknown>[] = [];
    await w.hear(
      () => chat.say(carol, 'Which issue holds the mail fix, with its key?'),
      async (_t, act, message) => {
        outs.push(
          await act({ action: 'reply', thread: message().thread, text: `It is ${w.issueKey}.` }),
        );
        outs.push(
          await act({ action: 'announce', rid: chat.rid, text: `${w.issueKey} shipped today.` }),
        );
        outs.push(
          await act({
            action: 'ask_owner',
            thread: message().thread,
            question: `May ${w.issueKey} ship?`,
          }),
        );
      },
    );
    expect(outs[0]?.isError, JSON.stringify(outs[0])).toBe(false);
    expect(code(outs[1])).toBe('SUPPORT_INTERNAL_CODE');
    expect(JSON.stringify(outs[1])).toContain('top level');
    expect(code(outs[2])).toBe('SUPPORT_INTERNAL_CODE');
    expect(topLevel().some((l) => l.text.includes(w.issueKey))).toBe(false);
  });
});

describe('ISS-916: an owner’s answer reaches a question he owes, wherever he writes it', () => {
  /** The `question.answered` events written for a question: what wakes the master who asked. */
  const answeredEvents = async (id: string) =>
    (
      await rows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pipeline_outbox
         WHERE type = 'question.answered' AND payload ->> 'questionId' = ${id}`)
    )[0]?.n ?? 0;
  const owedNote = (turn: { messages: { from: unknown; text: string }[] }) =>
    turn.messages.find((m) => m.from === 'forge' && m.text.includes('the owner owes'))?.text ?? '';

  it('shows the owner the open questions he owes, capped, and records his top-level answer as his', async () => {
    // the owner is linked to his Forge account, as the first ISS-873 case has him (run alone, too)
    await db.execute(sql`
      INSERT INTO assistant_speaker_links (source, external_namespace, external_id, user_id, confirmed_via)
      SELECT 'rocketchat', ${namespaceFromServerUrl(chat.serverUrl)}, ${OWNER_ID}, ${w.ownerId}, 'channel_email_match'
       WHERE NOT EXISTS (SELECT 1 FROM assistant_speaker_links WHERE external_id = ${OWNER_ID})`);
    const { id } = await parked('Which workspace key should Mộc use?');
    for (let i = 0; i < 5; i++) await parked(`Filler question ${i} for the cap?`);
    const [open] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM agent_questions
       WHERE project_id = ${w.projectId}::uuid AND status = 'open' AND blocker_kind = 'human'
         AND batch_id IS NULL`);
    let note = '';
    let recorded: Record<string, unknown> = {};
    // the owner writes at the top level of his room, in no thread any question was asked in
    const said = await w.hear(
      () => chat.say(chat.alice, 'Bạn có toàn quyền rồi, tự làm đi'),
      async (turn, act, message) => {
        note = owedNote(turn);
        recorded = await act({
          action: 'answer_question',
          thread: message().thread,
          forgeQuestion: id,
          message: message().message ?? '',
        });
      },
    );
    expect(note).toContain(`question ${id}`);
    expect(note).toContain('Which workspace key should Mộc use?');
    expect(note).toContain(`- and ${(open?.n ?? 0) - 5} more`);
    expect(recorded.isError, JSON.stringify(recorded)).toBe(false);
    const q = await question(id);
    expect(q?.status).toBe('answered');
    expect(q?.steps.at(-1)).toMatchObject({
      answerText: 'Bạn có toàn quyền rồi, tự làm đi',
      answeredBy: w.ownerId,
    });
    expect(await answeredEvents(id)).toBe(1);
    expect(w.threadLines(chat.rid, said.id)).toEqual([]);
  });

  it('answers nothing with anyone else’s message, and shows them no owed questions', async () => {
    const { id } = await parked('May the nightly import run at noon?');
    let note = 'unset';
    let refused: Record<string, unknown> = {};
    await w.hear(
      () => chat.say(chat.bob, 'yes, run it at noon'),
      async (turn, act, message) => {
        note = owedNote(turn);
        refused = await act({
          action: 'answer_question',
          thread: message().thread,
          forgeQuestion: id,
          message: message().message ?? '',
        });
      },
    );
    expect(note).toBe('');
    expect(code(refused), JSON.stringify(refused)).toBe('SUPPORT_ANSWER_NOT_THE_OWNER');
    expect((await question(id))?.status).toBe('open');
    expect(await answeredEvents(id)).toBe(0);
  });

  it('refuses a question that is no person’s, or one named with no message of his', async () => {
    const outs: Record<string, unknown>[] = [];
    await w.hear(
      () => chat.say(chat.alice, 'ok'),
      async (_turn, act, message) => {
        const m = message();
        outs.push(
          await act({
            action: 'answer_question',
            thread: m.thread,
            forgeQuestion: randomUUID(),
            message: m.message ?? '',
          }),
        );
        outs.push(
          await act({ action: 'answer_question', thread: m.thread, forgeQuestion: randomUUID() }),
        );
      },
    );
    expect(code(outs[0])).toBe('SUPPORT_OWNER_QUESTION_UNKNOWN');
    expect(code(outs[1])).toBe('SUPPORT_ANSWER_SOURCE');
  });
});
