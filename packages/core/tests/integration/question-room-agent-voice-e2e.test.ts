// @direct-test-of packages/core/src/assistant/chat-room/question-delivery.ts
// @direct-test-of packages/core/src/assistant/chat-room/question-inbound.ts
// @direct-test-of packages/core/src/assistant/chat-room/question-voice.ts
// @direct-test-of packages/core/src/assistant/chat-room/question-answer-tool.ts
// ISS-857 (owner ruling agent-is-the-voice, 2026-11-01): a parked run's question reaches a chat
// room through the room's own agent, which asks it in its own words; core posts no round, no
// option code and no outcome line. A plain answer ("cái thứ hai") is recorded when the agent cites
// the person's message to `answer_question`, and core answers as the linked person through the
// real `answerAs`. The model and the chat server are the only stand-ins: the question, its
// delivery ledger, the thread registry and the recorded answer are the real rows.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';

interface TurnArgs {
  projectId: string;
  message: string;
  tools?: {
    tools: { function: { name: string } }[];
    execute(
      name: string,
      argsJson: string,
    ): Promise<{ content: { text: string }[]; isError?: boolean }>;
  };
}
/** The model: each test says what the room's agent does with the turn it is handed. */
const model = vi.hoisted(() => ({
  turns: [] as TurnArgs[],
  results: [] as string[],
  act: null as null | ((t: TurnArgs) => Promise<{ reply: string; error?: string }>),
}));
const posted = vi.hoisted(() => [] as { text: string; tmid: string | undefined }[]);
/** Every post gets its own id, as the chat server gives it: a thread root is never reused. */
const postIds = vi.hoisted(() => ({ next: 0 }));
const speakers = vi.hoisted(() => new Map<string, string>());

vi.mock('../../src/assistant/external-chat.js', () => ({
  runExternalChatTurn: async (args: TurnArgs) => {
    model.turns.push(args);
    const out = model.act ? await model.act(args) : { reply: '' };
    return {
      conversationId: null,
      reply: out.reply,
      terminal: out.error ? 'error' : 'done',
      error: out.error ?? null,
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
    roomForProject: async () => ({ connectionId: connection.id, rid: 'ROOM' }),
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

vi.mock('../../src/assistant/identity/speaker-link.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../src/assistant/identity/speaker-link.js')>();
  return {
    ...real,
    resolveSpeaker: async (ref: { externalId: string }) => {
      const userId = speakers.get(ref.externalId);
      return userId
        ? { linked: true, userId }
        : {
            linked: false,
            refusal: { code: 'SPEAKER_UNLINKED', message: 'Link your account to answer here.' },
          };
    },
  };
});

const connection = vi.hoisted(() => ({ id: '' }));
let projectId = '';
let ownerId = '';
let askerId = '';
let ask: typeof import('../../src/questions/index.js').askQuestion;
let drain: typeof import('../../src/assistant/chat-room/question-delivery.js').drainQuestionDeliveries;
let reply: typeof import('../../src/assistant/chat-room/question-inbound.js').handleQuestionThreadReply;

const option = (id: string, label: string) => ({
  id,
  label,
  authority: 'writer' as const,
  bindsTo: 'project' as const,
  executedBy: 'core' as const,
});

/** A run parked on a choice, owed to the project's room. */
async function parkedChoice(): Promise<string> {
  const id = randomUUID();
  await ask({
    id,
    projectId,
    askedBy: askerId,
    prompt: 'Keep the legacy export or drop it?',
    blockerKind: 'human',
    answer: {
      shape: 'choice',
      options: [option('export.keep', 'Keep it'), option('export.drop', 'Drop it')],
      recommendedOptionId: 'export.keep',
    },
  });
  return id;
}

async function parkedWords(): Promise<string> {
  const id = randomUUID();
  await ask({
    id,
    projectId,
    askedBy: askerId,
    prompt: 'Which roles may see the payroll page?',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the roles' },
  });
  return id;
}

const stepOf = async (questionId: string) => {
  const [row] = await rows<{ steps: Record<string, unknown>[]; status: string }>(
    sql`SELECT steps, status FROM agent_questions WHERE id = ${questionId}::uuid`,
  );
  return { status: row?.status, step: row?.steps[row.steps.length - 1] ?? {} };
};

const threadOf = async (questionId: string) =>
  (
    await rows<{ tmid: string }>(
      sql`SELECT tmid FROM rocketchat_question_threads WHERE question_id = ${questionId}::uuid`,
    )
  )[0]?.tmid;

/** A reply typed in the question's thread by the chat user `userKey`. */
const replyIn = (questionId: string, tmid: string, userKey: string, text: string, id: string) =>
  reply({
    questionId,
    serverUrl: 'https://chat.example.com',
    botName: 'Bao',
    m: { id, rid: 'ROOM', tmid, userId: userKey, username: userKey, text } as never,
    transport: {
      kind: 'rest',
      auth: { serverUrl: 'https://chat.example.com', authToken: 'bot-token', userId: 'BOT' },
      rid: 'ROOM',
      tmid,
    } as never,
  });

/** The core-composed lines the round and its outcomes used to post. */
const CANNED = [
  /parked on a decision/i,
  /Reply in this thread/i,
  /like `\d/,
  /Recorded: /,
  /The run has been woken/,
  /was not recorded —/,
  /named no option/i,
  /no option `/,
];
const expectNoCoreLine = () => {
  for (const p of posted) for (const c of CANNED) expect(p.text).not.toMatch(c);
};

/** Ask through the drain, and the thread the round now lives in. */
async function delivered(questionId: string): Promise<string> {
  model.act = async () => ({ reply: 'Mọi người ơi, mình giữ bản xuất cũ hay bỏ nó đi?' });
  await drain(new Date());
  const tmid = await threadOf(questionId);
  if (!tmid) throw new Error('the round was not threaded');
  model.turns.length = 0;
  posted.length = 0;
  return tmid;
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ({ askQuestion: ask } = await import('../../src/questions/index.js'));
  ({ drainQuestionDeliveries: drain } = await import(
    '../../src/assistant/chat-room/question-delivery.js'
  ));
  ({ handleQuestionThreadReply: reply } = await import(
    '../../src/assistant/chat-room/question-inbound.js'
  ));
  ownerId = (await createTestUser({ verified: true })).id;
  askerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  speakers.set('U-OWNER', ownerId);
  const [conn] = await rows<{ id: string }>(sql`
    INSERT INTO integration_connections (owner_type, owner_id, provider, display_name, config)
    VALUES ('user', ${ownerId}::uuid, 'rocketchat', 'Team bot', '{"serverUrl":"https://chat.example.com"}'::jsonb)
    RETURNING id`);
  connection.id = conn?.id ?? '';
}, 120_000);

afterAll(closeWorld);

beforeEach(() => {
  model.turns.length = 0;
  model.act = null;
  posted.length = 0;
});

describe("a parked run's question is asked by the room's agent", () => {
  it('posts the agent words and nothing core composed, and threads the round under them', async () => {
    const id = await parkedChoice();
    model.act = async () => ({ reply: 'Mọi người ơi, mình giữ bản xuất cũ hay bỏ nó đi?' });
    await drain(new Date());
    const asked = model.turns.filter((t) => t.projectId === projectId);
    expect(asked).toHaveLength(1);
    // the agent is handed the run's words and the options as facts, and no tool to record anything
    expect(asked[0]?.message).toContain('Keep the legacy export or drop it?');
    expect(asked[0]?.message).toContain('Drop it');
    expect(asked[0]?.tools).toBeUndefined();
    expect(posted.map((p) => p.text)).toEqual(['Mọi người ơi, mình giữ bản xuất cũ hay bỏ nó đi?']);
    expectNoCoreLine();
    expect(await threadOf(id)).toBe(`POST-${postIds.next}`);
    const [row] = await rows<{ status: string }>(
      sql`SELECT status FROM rocketchat_question_deliveries WHERE question_id = ${id}::uuid`,
    );
    expect(row?.status).toBe('delivered');
  });

  it('posts nothing when the agent cannot speak, and the round stays owed with why', async () => {
    const id = await parkedChoice();
    model.act = async () => ({ reply: '', error: 'provider down' });
    await drain(new Date());
    expect(posted).toEqual([]);
    expect(await threadOf(id)).toBeUndefined();
    const [row] = await rows<{ status: string; last_error: string }>(
      sql`SELECT status, last_error FROM rocketchat_question_deliveries WHERE question_id = ${id}::uuid`,
    );
    expect(row?.status).not.toBe('delivered');
    expect(row?.last_error).toContain("room's agent did not ask it");
  });
});

describe('a plain answer in the thread is read by the agent and recorded on the cited message', () => {
  it('records "cái thứ hai" as the second option, as the person, and posts only the agent words', async () => {
    const id = await parkedChoice();
    const tmid = await delivered(id);
    const outcomes: string[] = [];
    model.act = async (t) => {
      const result = await t.tools?.execute(
        'answer_question',
        JSON.stringify({ message: 'MSG-2', option: 'export.drop' }),
      );
      outcomes.push(result?.content[0]?.text ?? '');
      return { reply: 'Đã ghi nhận: bỏ bản xuất cũ. Cảm ơn bạn!' };
    };
    await replyIn(id, tmid, 'U-OWNER', 'cái thứ hai', 'MSG-2');
    expect(model.turns).toHaveLength(1);
    expect(model.turns[0]?.message).toContain('cái thứ hai');
    expect(model.turns[0]?.message).toContain('MSG-2');
    expect(model.turns[0]?.tools?.tools.map((x) => x.function.name)).toEqual(['answer_question']);
    expect(JSON.parse(outcomes[0] ?? '{}')).toMatchObject({ recorded: true, option: 'Drop it' });
    const { status, step } = await stepOf(id);
    expect(status).toBe('answered');
    expect(step).toMatchObject({ chosenOptionId: 'export.drop', answeredBy: ownerId });
    expect(posted.map((p) => p.text)).toEqual(['Đã ghi nhận: bỏ bản xuất cũ. Cảm ơn bạn!']);
    expectNoCoreLine();
  });

  it('refuses a citation of any message but the reply, and an option the round lacks', async () => {
    const id = await parkedChoice();
    const tmid = await delivered(id);
    const outcomes: { text: string; isError?: boolean }[] = [];
    model.act = async (t) => {
      for (const args of [
        { message: 'MSG-OTHER', option: 'export.drop' },
        { message: 'MSG-3', option: 'export.archive' },
        { message: 'MSG-3' },
      ]) {
        const r = await t.tools?.execute('answer_question', JSON.stringify(args));
        outcomes.push({
          text: r?.content[0]?.text ?? '',
          ...(r?.isError ? { isError: true } : {}),
        });
      }
      return { reply: 'Bạn muốn giữ hay bỏ bản xuất cũ?' };
    };
    await replyIn(id, tmid, 'U-OWNER', 'hmm, cái kia', 'MSG-3');
    expect(outcomes.every((o) => o.isError)).toBe(true);
    expect(outcomes.map((o) => JSON.parse(o.text).refused[0].code)).toEqual([
      'QUESTION_MESSAGE_UNKNOWN',
      'QUESTION_OPTION_UNKNOWN',
      'QUESTION_OPTION_REQUIRED',
    ]);
    expect((await stepOf(id)).status).toBe('open');
    expect(posted.map((p) => p.text)).toEqual(['Bạn muốn giữ hay bỏ bản xuất cũ?']);
    expectNoCoreLine();
  });

  it('records a round asked in words as the person wrote it, never the agent reading', async () => {
    const id = await parkedWords();
    const tmid = await delivered(id);
    model.act = async (t) => {
      await t.tools?.execute('answer_question', JSON.stringify({ message: 'MSG-4' }));
      return { reply: 'Ghi nhận rồi nhé.' };
    };
    await replyIn(id, tmid, 'U-OWNER', 'Chỉ admin và kế toán', 'MSG-4');
    const { status, step } = await stepOf(id);
    expect(status).toBe('answered');
    expect(step).toMatchObject({ answerText: 'Chỉ admin và kế toán', answeredBy: ownerId });
    expect(posted.map((p) => p.text)).toEqual(['Ghi nhận rồi nhé.']);
  });

  it('hands a closed question to the agent with no tool, to say so in its own words', async () => {
    const id = await parkedChoice();
    const tmid = await delivered(id);
    model.act = async (t) => {
      await t.tools?.execute(
        'answer_question',
        JSON.stringify({ message: 'MSG-5', option: 'export.keep' }),
      );
      return { reply: 'Hai lựa chọn: giữ hay bỏ?' };
    };
    await replyIn(id, tmid, 'U-OWNER', 'cái đầu', 'MSG-5');
    expect((await stepOf(id)).status).toBe('answered');
    posted.length = 0;
    model.turns.length = 0;
    model.act = async () => ({ reply: 'Câu này đã được trả lời rồi bạn nhé.' });
    await replyIn(id, tmid, 'U-OWNER', 'cái thứ hai', 'MSG-6');
    expect(model.turns[0]?.tools).toBeUndefined();
    expect(model.turns[0]?.message).toContain('cannot be answered here');
    expect((await stepOf(id)).step).toMatchObject({ chosenOptionId: 'export.keep' });
    expect(posted.map((p) => p.text)).toEqual(['Câu này đã được trả lời rồi bạn nhé.']);
  });

  it('keeps the unlinked-speaker refusal as the one last-resort line, and runs no turn', async () => {
    const id = await parkedChoice();
    const tmid = await delivered(id);
    await replyIn(id, tmid, 'U-STRANGER', 'cái thứ hai', 'MSG-7');
    expect(model.turns).toHaveLength(0);
    expect(posted.map((p) => p.text)).toEqual(['Link your account to answer here.']);
    expect((await stepOf(id)).status).toBe('open');
  });
});
