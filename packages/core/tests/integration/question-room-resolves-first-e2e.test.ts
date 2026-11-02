// @direct-test-of packages/core/src/assistant/chat-room/question-delivery.ts
// @direct-test-of packages/core/src/assistant/chat-room/question-voice.ts
// @direct-test-of packages/core/src/assistant/chat-room/question-record.ts
// @direct-test-of packages/core/src/integrations/rocketchat/thread-registry.ts
// @direct-test-of packages/core/src/conversations/room-language.ts
// ISS-873 (owner, agenfold 2026-11-02; ruling agent-is-the-voice): core never posts a parked run's
// question into a room by itself. The room's agent is handed it and first answers it from the record
// (an approved file on linked feedback), posting nothing; only where a person is needed does it ask,
// once, in the room's language, in plain words with no code, inside a thread — the room's one thread
// for the day's questions, opened by the agent's own line — never at the room's top level. The model
// and the chat server are the stand-ins; the question, the ledger, the threads and the answer are
// real rows.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

interface TurnArgs {
  projectId: string;
  message: string;
  replyLanguage?: string | null;
  tools?: {
    tools: { function: { name: string } }[];
    execute(
      name: string,
      argsJson: string,
    ): Promise<{ content: { text: string }[]; isError?: boolean }>;
  };
}
const model = vi.hoisted(() => ({
  turns: [] as TurnArgs[],
  act: null as null | ((t: TurnArgs) => Promise<{ reply: string }>),
}));
const posted = vi.hoisted(() => [] as { text: string; tmid: string | undefined }[]);
const postIds = vi.hoisted(() => ({ next: 0 }));
const connection = vi.hoisted(() => ({ id: '' }));

vi.mock('../../src/assistant/external-chat.js', () => ({
  runExternalChatTurn: async (args: TurnArgs) => {
    model.turns.push(args);
    const out = model.act ? await model.act(args) : { reply: '' };
    return {
      conversationId: null,
      reply: out.reply,
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [],
      progress: null,
      rounds: [],
    };
  },
}));

vi.mock('../../src/integrations/rocketchat/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/integrations/rocketchat/index.js')>();
  return {
    ...real,
    roomForProject: async () => ({ connectionId: connection.id, rid: 'TEAM' }),
    resolveRoomPostAuth: async () => ({
      serverUrl: 'https://chat.example.com',
      authToken: 'bot-token',
      userId: 'BOT',
    }),
    sendFixedReply: async (t: { tmid?: string }, text: string) => {
      posted.push({ text, tmid: t.tmid });
      postIds.next += 1;
      return { messageId: `POST-${postIds.next}` };
    },
  };
});

let projectId = '';
let ownerId = '';
let askerId = '';
let issueId = '';
let ask: typeof import('../../src/questions/index.js').askQuestion;
let drain: typeof import('../../src/assistant/chat-room/question-delivery.js').drainQuestionDeliveries;

const OPENER = 'Mấy câu hỏi hôm nay của nhóm';
const QUESTION = 'Anh ơi, trang chủ dùng ảnh nào ạ?';

/** A run parked on the issue, asking in words. */
async function parked(prompt = 'Which mockup image should the home page use?'): Promise<string> {
  const id = randomUUID();
  await ask({
    id,
    projectId,
    issueId,
    askedBy: askerId,
    prompt,
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the image to use' },
  } as Parameters<typeof ask>[0]);
  return id;
}

/** The agent asks: the day's opener for a turn with no tool, the question for the asking turn. */
const asks = (question = QUESTION) => {
  model.act = async (t) => ({ reply: t.tools ? question : OPENER });
};

const threadOf = async (questionId: string) =>
  (
    await rows<{ tmid: string }>(
      sql`SELECT tmid FROM rocketchat_question_threads WHERE question_id = ${questionId}::uuid`,
    )
  )[0]?.tmid;

const statusOf = async (questionId: string) =>
  (
    await rows<{ status: string; steps: Record<string, unknown>[] }>(
      sql`SELECT status, steps FROM agent_questions WHERE id = ${questionId}::uuid`,
    )
  )[0];

/** Every post outside a thread: only the agent's line opening a day's thread may be one. */
const topLevel = () => posted.filter((p) => p.tmid === undefined);

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ({ askQuestion: ask } = await import('../../src/questions/index.js'));
  ({ drainQuestionDeliveries: drain } = await import(
    '../../src/assistant/chat-room/question-delivery.js'
  ));
  ownerId = (await createTestUser({ verified: true })).id;
  askerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  issueId = (await createTestIssue(projectId, ownerId, 85, { status: 'in_progress', createdAt: new Date() }))
    .id;
  const [conn] = await rows<{ id: string }>(sql`
    INSERT INTO integration_connections (owner_type, owner_id, provider, display_name, config)
    VALUES ('user', ${ownerId}::uuid, 'rocketchat', 'Team bot', '{"serverUrl":"https://chat.example.com"}'::jsonb)
    RETURNING id`);
  connection.id = conn?.id ?? '';
  // the room speaks Vietnamese: what its people last wrote there
  const { namespaceFromServerUrl } = await import('../../src/integrations/rocketchat/index.js');
  const { appendMessages, openConversation } = await import('../../src/conversations/index.js');
  const room = await openConversation({
    adapter: 'rocketchat',
    externalId: `${namespaceFromServerUrl('https://chat.example.com')} TEAM`,
    shape: 'group',
    projectId,
    title: 'Team room',
  });
  await appendMessages({
    conversationId: room.id,
    messages: [{ role: 'user', content: 'Mọi người xem giúp mình bản dựng mới nhé, cảm ơn cả nhà' }],
  });
}, 120_000);

afterAll(closeWorld);

beforeEach(() => {
  model.turns.length = 0;
  model.act = null;
  posted.length = 0;
});

describe('a round the record answers is answered there, and nothing is posted', () => {
  it('answers from the approved image on linked feedback, citing it, as the project agent', async () => {
    const fb = await createTestFeedback(projectId, ownerId, 37, [issueId]);
    await rows(sql`
      INSERT INTO feedback_decisions (project_id, feedback_id, decision, reason, decided_agency, decided_by)
      SELECT project_id, id, 'accepted', 'Approved: use this mockup.', 'human', reported_by
        FROM feedback WHERE project_id = ${projectId}::uuid AND fb_seq = 37`);
    await rows(sql`
      INSERT INTO feedback_attachments (project_id, feedback_id, name, mime, size, storage_path, flagged, uploaded_by)
      SELECT project_id, id, 'home-mockup.png', 'image/png', 12, 'feedback/x/home-mockup.png', false, reported_by
        FROM feedback WHERE project_id = ${projectId}::uuid AND fb_seq = 37`);
    const id = await parked();
    const read: string[] = [];
    model.act = async (t) => {
      const record = await t.tools?.execute('read_record', '{}');
      read.push(record?.content[0]?.text ?? '');
      await t.tools?.execute(
        'answer_from_record',
        JSON.stringify({ source: `${fb}, its attached home-mockup.png`, answer: 'home-mockup.png' }),
      );
      return { reply: '' };
    };
    await drain(new Date());
    expect(read[0]).toContain('home-mockup.png');
    expect(read[0]).toContain('accepted');
    expect(posted).toEqual([]);
    const q = await statusOf(id);
    expect(q?.status).toBe('answered');
    expect(q?.steps.at(-1)).toMatchObject({ answerText: 'home-mockup.png' });
    expect(JSON.stringify(q?.steps.at(-1))).toContain('Answered from the record: FB-37');
    const [delivery] = await rows<{ status: string }>(
      sql`SELECT status FROM rocketchat_question_deliveries WHERE question_id = ${id}::uuid`,
    );
    expect(delivery?.status).toBe('delivered');
    // settled: the next sweep owes it nothing and asks nobody
    await drain(new Date());
    expect(posted).toEqual([]);
  });

  it('refuses an answer from the record that names no source, and records nothing', async () => {
    const id = await parked('Which font does the footer use?');
    const outcome: string[] = [];
    model.act = async (t) => {
      if (!t.tools) return { reply: OPENER };
      const r = await t.tools.execute('answer_from_record', JSON.stringify({ answer: 'Inter' }));
      outcome.push(r.content[0]?.text ?? '');
      return { reply: 'Chân trang dùng phông chữ nào ạ?' };
    };
    await drain(new Date());
    expect(JSON.parse(outcome[0] ?? '{}').refused[0].code).toBe('QUESTION_SOURCE_REQUIRED');
    expect((await statusOf(id))?.status).toBe('open');
  });
});

describe('a round that needs the owner is asked once, in a thread, in the room language', () => {
  it('posts the question inside the day thread, never at the top level, with the room language', async () => {
    const id = await parked('Should the banner rotate or stay still?');
    asks('Banner trên trang chủ nên tự chuyển hay đứng yên ạ?');
    await drain(new Date());
    const askTurn = model.turns.find((t) => t.tools);
    expect(askTurn?.replyLanguage).toBe('vi');
    const question = posted.find((p) => p.text.startsWith('Banner'));
    expect(question?.tmid).toBeDefined();
    expect(topLevel().every((p) => p.text === OPENER)).toBe(true);
    expect(await threadOf(id)).toBe(question?.tmid);
  });

  it('puts two rounds of the same day in the same thread, and opens it once', async () => {
    const first = await parked('Is the logo blue or green?');
    asks('Logo màu xanh dương hay xanh lá ạ?');
    await drain(new Date());
    const second = await parked('Does the menu stick to the top?');
    asks('Menu có dính trên đầu trang không ạ?');
    await drain(new Date());
    expect(await threadOf(first)).toBeDefined();
    expect(await threadOf(second)).toBe(await threadOf(first));
    expect(topLevel()).toEqual([]);
    const [days] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM rocketchat_daily_threads WHERE connection_id = ${connection.id}::uuid`,
    );
    expect(days?.n).toBe(1);
  });

  it('opens a new day thread the next day', async () => {
    const id = await parked('Do we keep the dark mode toggle?');
    asks('Mình giữ nút chế độ tối không ạ?');
    const tomorrow = new Date(Date.now() + 86_400_000);
    await drain(tomorrow);
    expect(topLevel().map((p) => p.text)).toEqual([OPENER]);
    expect(await threadOf(id)).toBe(`POST-${postIds.next - 1}`);
  });

  it('never asks the same round twice, nor the same question re-parked on the issue', async () => {
    const id = await parked('Which payment provider goes first?');
    asks('Cổng thanh toán nào làm trước ạ?');
    await drain(new Date());
    expect(posted.filter((p) => p.text.startsWith('Cổng'))).toHaveLength(1);
    posted.length = 0;
    model.turns.length = 0;
    await drain(new Date(Date.now() + 3_600_000));
    expect(posted).toEqual([]);
    const again = await parked('Which payment provider goes first?');
    await drain(new Date(Date.now() + 3_600_000));
    expect(posted).toEqual([]);
    expect(model.turns).toEqual([]);
    expect(await threadOf(again)).toBe(await threadOf(id));
  });

  it('refuses a question holding a code by name, and posts the rewrite in plain words', async () => {
    const id = await parked('Which copy goes on the pricing page?');
    model.act = async (t) => {
      if (!t.tools && !t.message.includes('cannot be sent')) return { reply: OPENER };
      return t.message.includes('cannot be sent')
        ? { reply: 'Trang giá dùng nội dung nào ạ?' }
        : { reply: 'ISS-85 is parked: pick option copy.short or copy.long' };
    };
    await drain(new Date());
    const rewrite = model.turns.find((t) => t.message.includes('cannot be sent'));
    expect(rewrite?.message).toContain('issue key "ISS-85"');
    expect(posted.map((p) => p.text)).not.toContain(
      'ISS-85 is parked: pick option copy.short or copy.long',
    );
    expect(posted.find((p) => p.text === 'Trang giá dùng nội dung nào ạ?')?.tmid).toBeDefined();
    expect(await threadOf(id)).toBeDefined();
  });

  it('posts nothing when every attempt keeps a code', async () => {
    const id = await parked('Which domain goes live?');
    model.act = async (t) => ({
      reply: t.tools || t.message.includes('cannot be sent') ? 'Run ISS-85 waits on a1b2c3d' : OPENER,
    });
    await drain(new Date());
    expect(posted.some((p) => /ISS-85|a1b2c3d/.test(p.text))).toBe(false);
    expect(await threadOf(id)).toBeUndefined();
  });
});
