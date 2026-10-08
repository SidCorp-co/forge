/**
 * A chat turn that runs past its first ceiling posts what it has and keeps working (chat mining
 * 2026-10-07, the top harm: 38 of 304 people's turns, 18 of 41 in October, hit the 90 s ceiling and
 * the person got nothing; a long issue spec was the common case, 18 of 46 failed). The asks are the
 * production ones, anonymised. The model is the one thing scripted: it reads the issue, writes to
 * it, then keeps thinking past the ceiling, as the timed-out turns did.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { and, asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Round = (
  signal: AbortSignal | undefined,
) => Promise<{ tool: { name: string; args: unknown } } | { text: string }>;
const script: { rounds: Round[]; at: number; firstCallAt: number | null } = {
  rounds: [],
  at: 0,
  firstCallAt: null,
};

/** A measured figure, kept where CHAT_TURN_MEASURE_OUT names a file to keep it in. */
function measured(line: string): void {
  const out = process.env.CHAT_TURN_MEASURE_OUT;
  if (out) appendFileSync(out, `${new Date().toISOString()} ${line}\n`);
}

const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openChat: async () => ({
    model: 'scripted',
    provider: {
      id: 'scripted',
      defaultModel: 'scripted',
      async *stream(req: { signal?: AbortSignal }) {
        script.firstCallAt ??= Date.now();
        const round = script.rounds[script.at++];
        if (!round) {
          yield { type: 'chunk', text: 'Xong.' };
          yield { type: 'done' };
          return;
        }
        try {
          const said = await round(req.signal);
          if ('tool' in said) {
            yield {
              type: 'tool_call',
              id: `call-${script.at}`,
              name: said.tool.name,
              arguments: JSON.stringify(said.tool.args),
            };
          } else {
            yield { type: 'chunk', text: said.text };
          }
          yield { type: 'done' };
        } catch (err) {
          yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  }),
}));

const { db } = await import('../../src/db/client.js');
const { conversationMessages } = await import('../../src/db/schema-conversations.js');
const { runConversationTurn } = await import('../../src/assistant/turn-runner.js');
const { webConversationTurn } = await import('../../src/assistant/web-turn-inputs.js');
const { ConversationProgress } = await import('../../src/assistant/conversation-progress.js');
const { api, userToken } = await import('../helpers/api.js');
const { createTestIssue, createTestProject, createTestUser } = await import(
  '../helpers/factories.js'
);

let token = '';
let projectId = '';
let owner = '';

interface Tracker {
  reads: number;
  comments: number;
  knowledge: number;
  memory: number;
  readMs: number;
}

/** The project's tools as the model reaches them, with the latency a read pays on dev. */
function trackerTools(t: Tracker, readLatencyMs = 0) {
  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
  return {
    tools: ['forge', 'forge_knowledge', 'forge_memory'].map((name) => ({
      type: 'function' as const,
      function: { name, description: name, parameters: { type: 'object' } },
    })),
    ranAs: () => owner,
    async execute(name: string, argsJson: string) {
      const args = JSON.parse(argsJson) as { argv?: string[]; action?: string };
      const started = Date.now();
      try {
        if (name === 'forge_knowledge') {
          t.knowledge += 1;
          await new Promise((r) => setTimeout(r, readLatencyMs));
          return text('knowledge: the export screen lists every column the customer filters on');
        }
        if (name === 'forge_memory') {
          t.memory += 1;
          await new Promise((r) => setTimeout(r, readLatencyMs));
          return text('memory: specs are written as rules, fields and situations');
        }
        if (args.argv?.[0] === 'comment') {
          t.comments += 1;
          return text('{"exitCode":0,"stdout":"Commented on ISS-61"}');
        }
        t.reads += 1;
        return text('ISS-61 · draft · Export screen spec is still general');
      } finally {
        t.readMs += Date.now() - started;
      }
    },
  };
}

const AUTHORITY = () => ({
  userId: owner,
  projectId,
  origin: 'message' as const,
  viaTokenId: null,
  grant: null,
  fence: null,
  scopes: [],
  grantEpoch: 0,
});

async function openRoom(title: string) {
  const res = await api(token, 'POST', '/api/conversations', { projectId, title, people: [] });
  expect(res.status).toBe(201);
  return res.body as unknown as { id: string; externalId: string; shape: 'direct' | 'group' };
}

async function said(conversationId: string) {
  return db
    .select({ content: conversationMessages.content, seq: conversationMessages.seq })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        eq(conversationMessages.role, 'assistant'),
      ),
    )
    .orderBy(asc(conversationMessages.seq));
}

async function turn(args: {
  room: Awaited<ReturnType<typeof openRoom>>;
  message: string;
  tools: ReturnType<typeof trackerTools> | null;
  budget?: { partialAfterMs: number; ceilingMs: number };
  fallbacks?: 'post' | 'silence';
}) {
  const venue = {
    adapter: 'web' as const,
    externalId: args.room.externalId,
    shape: args.room.shape,
    projectId,
  };
  const inputs = webConversationTurn({
    project: { id: projectId, slug: 'continues', name: 'Continues' },
    handleName: 'forge',
    askedBy: null,
    window: {
      venue,
      conversationId: args.room.id,
      windowId: randomUUID(),
      deliveryKey: `window:${randomUUID()}`,
      mode: 'assistant',
      question: args.message,
      images: [],
      conversationContext: async () => null,
      reserve: async () => true,
    },
    progress: new ConversationProgress(args.room.id, randomUUID()),
    externalStop: new AbortController().signal,
  });
  const tools = args.tools;
  return runConversationTurn({
    ...inputs,
    ...(tools ? { prepare: async () => ({ tools }) } : {}),
    venue,
    authority: AUTHORITY(),
    speakerUserId: owner,
    speakerKey: owner,
    message: args.message,
    replyLanguage: 'vi',
    deliveryKey: `window:${randomUUID()}`,
    ...(args.budget ? { budget: args.budget } : {}),
    ...(args.fallbacks ? { fallbacks: args.fallbacks } : {}),
  });
}

beforeAll(async () => {
  owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  await createTestIssue(projectId, owner, 61, { status: 'draft', createdAt: new Date() });
});

describe('a turn past its first ceiling posts what it did, and the rest in the same thread', () => {
  const SPEC_ASK =
    'Viết spec chi tiết cho ISS-61: cần cụ thể thêm rule, field, situation do vẫn còn general';

  it('posts a partial naming the write it made, then the finished answer as a second message', async () => {
    const t: Tracker = { reads: 0, comments: 0, knowledge: 0, memory: 0, readMs: 0 };
    script.at = 0;
    script.rounds = [
      async () => ({ tool: { name: 'forge', args: { argv: ['issue', 'ISS-61'] } } }),
      async () => ({
        tool: { name: 'forge', args: { argv: ['comment', 'ISS-61', '-'], body: '## Rules\n- …' } },
      }),
      async (signal) => {
        await sleep(900, signal);
        return { text: 'Đã bổ sung rule, field và tình huống vào ISS-61 dưới dạng bình luận.' };
      },
    ];
    const room = await openRoom('spec past the ceiling');
    const outcome = await turn({
      room,
      message: SPEC_ASK,
      tools: trackerTools(t),
      budget: { partialAfterMs: 400, ceilingMs: 10_000 },
    });
    expect(outcome.kind).toBe('delivered');
    const continuation = outcome.kind === 'delivered' ? outcome.continuation?.rest : undefined;
    expect(continuation, 'the turn outran its first ceiling and must keep working').toBeDefined();

    const partial = await said(room.id);
    expect(partial).toHaveLength(1);
    expect(partial[0]?.content).toContain('đang làm tiếp');
    expect(partial[0]?.content).toContain('ISS-61');
    expect(partial[0]?.content).toContain('comment');

    expect(await continuation).toMatchObject({ kind: 'delivered' });
    const both = await said(room.id);
    expect(both).toHaveLength(2);
    expect(both[1]?.content).toContain('Đã bổ sung rule');
    expect(t.comments, 'the write the partial named is not made again').toBe(1);
  });

  it('a rest that runs out its own ceiling says so in the thread instead of going silent', async () => {
    const t: Tracker = { reads: 0, comments: 0, knowledge: 0, memory: 0, readMs: 0 };
    script.at = 0;
    script.rounds = [
      async () => ({ tool: { name: 'forge', args: { argv: ['issue', 'ISS-61'] } } }),
      async (signal) => {
        await sleep(60_000, signal);
        return { text: 'never' };
      },
    ];
    const room = await openRoom('rest past its ceiling');
    const outcome = await turn({
      room,
      message: SPEC_ASK,
      tools: trackerTools(t),
      budget: { partialAfterMs: 300, ceilingMs: 1200 },
    });
    const continuation = outcome.kind === 'delivered' ? outcome.continuation?.rest : undefined;
    expect(continuation).toBeDefined();
    await continuation;
    const both = await said(room.id);
    expect(both).toHaveLength(2);
    expect(both[0]?.content).toContain('forge ["issue","ISS-61"]');
    expect(both[1]?.content).toContain(
      'forge chưa trả lời xong trong thời gian cho phép của một lượt. (ASSISTANT_TURN_TIMED_OUT)', // i18n-allow: the Vietnamese report under test
    );
    expect(both[1]?.content).toContain('forge ["issue","ISS-61"]');
  });

  it('a room that may stay silent hears no partial from a turn that only read', async () => {
    const t: Tracker = { reads: 0, comments: 0, knowledge: 0, memory: 0, readMs: 0 };
    script.at = 0;
    script.rounds = [
      async () => ({ tool: { name: 'forge', args: { argv: ['issue', 'ISS-61'] } } }),
      async (signal) => {
        await sleep(60_000, signal);
        return { text: 'never' };
      },
    ];
    const room = await openRoom('quiet room past the ceiling');
    const outcome = await turn({
      room,
      message: SPEC_ASK,
      tools: trackerTools(t),
      budget: { partialAfterMs: 300, ceilingMs: 10_000 },
      fallbacks: 'silence',
    });
    expect(outcome).toMatchObject({ kind: 'failed', code: 'ASSISTANT_TURN_TIMED_OUT' });
    expect(await said(room.id)).toHaveLength(0);
  });

  it('a turn that answers inside its first ceiling posts one message, as before', async () => {
    const t: Tracker = { reads: 0, comments: 0, knowledge: 0, memory: 0, readMs: 0 };
    script.at = 0;
    script.rounds = [
      async () => ({ tool: { name: 'forge', args: { argv: ['issue', 'ISS-61'] } } }),
      async () => ({ text: 'ISS-61 vẫn là bản nháp, chưa ai nhận.' }),
    ];
    const room = await openRoom('inside the ceiling');
    const outcome = await turn({
      room,
      message: 'ISS-61 sao rồi?',
      tools: trackerTools(t),
      budget: { partialAfterMs: 5000, ceilingMs: 10_000 },
    });
    expect(outcome).toMatchObject({ kind: 'delivered' });
    expect(outcome.kind === 'delivered' && outcome.continuation).toBeFalsy();
    expect(await said(room.id)).toHaveLength(1);
  });
});

describe('preparing a turn, measured on a local turn', () => {
  it('a room does not pay twice for the knowledge and memory it already read', async () => {
    const t: Tracker = { reads: 0, comments: 0, knowledge: 0, memory: 0, readMs: 0 };
    const room = await openRoom('repeat reads');
    const reading: Round[] = [
      async () => ({
        tool: { name: 'forge_knowledge', args: { action: 'search', query: 'export' } },
      }),
      async () => ({ tool: { name: 'forge_memory', args: { action: 'search', query: 'spec' } } }),
      async () => ({ text: 'Màn export lọc theo từng cột khách dùng.' }),
    ];
    const timings: number[] = [];
    for (const ask of ['Màn export lọc theo gì?', 'Còn cột ngày thì sao?']) {
      script.at = 0;
      script.rounds = reading;
      const before = t.readMs;
      expect(await turn({ room, message: ask, tools: trackerTools(t, 400) })).toMatchObject({
        kind: 'delivered',
      });
      timings.push(t.readMs - before);
    }
    measured(
      `knowledge+memory read time: first turn ${timings[0]} ms, second turn ${timings[1]} ms`,
    );
    expect(t.knowledge, 'the second turn reads knowledge from the room').toBe(1);
    expect(t.memory, 'the second turn reads memory from the room').toBe(1);
  });

  it('reaches the model within a bounded preparation on the real web inputs', async () => {
    const room = await openRoom('real preparation');
    const prep: number[] = [];
    for (const ask of ['Dự án đang thế nào?', 'Có gì mới không?', 'Còn gì chặn không?']) {
      script.at = 0;
      script.rounds = [async () => ({ text: 'Không có gì chặn.' })];
      script.firstCallAt = null;
      const started = Date.now();
      await turn({ room, message: ask, tools: null });
      prep.push((script.firstCallAt ?? Date.now()) - started);
    }
    measured(`preparation before the model's first request: ${prep.join(', ')} ms`);
    expect(Math.max(...prep)).toBeLessThan(3000);
  });
});
