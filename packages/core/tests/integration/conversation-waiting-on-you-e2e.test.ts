/**
 * ISS-277: a room waits on the person only when the agent's last reply was recorded as awaiting
 * their answer: its turn called `await_reply` and the text delivered was the model's own. Passes 1
 * and 2 read a question out of the reply's prose, and two independent judges each found replies
 * that ended on a question mark without waiting on anyone (a question followed by the list that
 * answers it, an echoed question, a URL ending in `?`). Every such case is here, as a reply with no
 * record, and reads Done; every real question is here as a recorded one, and reads Waiting on you.
 *
 * The rooms are shaped as production shapes them: the web transport is registered (helpers/api.ts),
 * so a web room with two people is `group`, listed to every project reader, and the per-viewer rule
 * is what keeps the question off a reader it was not put to.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const model: { reply: string; ask: boolean } = { reply: '', ask: false };

// the model is the one thing a real turn here does not run: it answers with the scripted text and,
// where the script says so, calls the `await_reply` it was offered, as a model would
vi.mock('../../src/assistant/external-chat.js', () => ({
  runExternalChatTurn: async (args: {
    conversationId: string;
    tools?: { execute: (name: string, argsJson: string) => Promise<unknown> };
  }) => {
    if (model.ask) await args.tools?.execute('await_reply', '{}');
    return {
      conversationId: args.conversationId,
      reply: model.reply,
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: model.ask ? [{ name: 'await_reply', arguments: '{}' }] : [],
      progress: null,
    };
  },
}));

const { db } = await import('../../src/db/client.js');
const { conversationMessages } = await import('../../src/db/schema-conversations.js');
const { runConversationTurn } = await import('../../src/assistant/turn-runner.js');
const { webConversationTurn } = await import('../../src/assistant/web-turn-inputs.js');
const { ConversationProgress } = await import('../../src/assistant/conversation-progress.js');
const { api, userToken } = await import('../helpers/api.js');
const { refusedByDb } = await import('../helpers/ecosystem-world.js');
const { addProjectMember, createTestProject, createTestUser } = await import(
  '../helpers/factories.js'
);

let token = '';
let projectId = '';
let owner = '';
let colleague = '';
let colleagueToken = '';
let otherAgent = '';
let watcher = '';
let watcherToken = '';
let outsider = '';
let outsiderToken = '';

/** A said message; a `user` one is the owner's unless `by` names another author. */
type Said = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  silence?: string;
  by?: string | null;
  /** The turn that wrote this agent reply called `await_reply`. */
  asks?: boolean;
};

interface Room {
  id: string;
  externalId: string;
  shape: 'direct' | 'group';
}

async function open(title: string, people: string[] = []): Promise<Room> {
  const res = await api(token, 'POST', '/api/conversations', { projectId, title, people });
  expect(res.status).toBe(201);
  return res.body as unknown as Room;
}

async function room(title: string, said: Said[], people: string[] = []): Promise<string> {
  const { id } = await open(title, people);
  for (const [i, m] of said.entries()) {
    const author = m.role === 'user' ? (m.by === undefined ? owner : m.by) : null;
    await db.execute(sql`
      INSERT INTO conversation_messages
        (conversation_id, seq, role, content, silence_reason, author_user_id, awaits_reply)
      VALUES (${id}, ${i + 1}, ${m.role}, ${m.content}, ${m.silence ?? null}, ${author},
        ${m.asks === true})
    `);
  }
  return id;
}

async function listed(as = token): Promise<Map<string, string | null>> {
  const res = await api(as, 'GET', `/api/conversations?projectId=${projectId}`);
  expect(res.status).toBe(200);
  const items = res.body.items as { id: string; threadStatus: string | null }[];
  return new Map(items.map((r) => [r.id, r.threadStatus]));
}

async function detailed(id: string, as = token): Promise<string | null> {
  const res = await api(as, 'GET', `/api/conversations/${id}`);
  expect(res.status).toBe(200);
  return res.body.threadStatus as string | null;
}

beforeAll(async () => {
  owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  colleague = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, colleague);
  colleagueToken = await userToken(colleague);
  otherAgent = (await createTestUser({ kind: 'agent' })).id;
  watcher = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, watcher, 'viewer');
  watcherToken = await userToken(watcher);
  outsider = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, outsider);
  outsiderToken = await userToken(outsider);
});

describe('the rooms these cases run in are shaped as production shapes them', () => {
  it('a web room with two people is a group room, listed to a project member outside it', async () => {
    const two = await open('two people', [colleague]);
    expect(two.shape).toBe('group');
    expect((await listed(outsiderToken)).has(two.id)).toBe(true);
    const one = await open('one person');
    expect(one.shape).toBe('direct');
    expect((await listed(outsiderToken)).has(one.id)).toBe(false);
  });
});

// real questions, each recorded as awaiting an answer by the turn that asked it
describe('an agent reply recorded as awaiting an answer', () => {
  const asked = {
    plain: 'I drafted REQ-1 from what you described.\n\nShall I file it as written?',
    options: 'Which one should I use?\n\n- CSV\n- XLSX',
    quotedWord: 'Do you mean "export"?',
    afterAQuote: 'You wrote:\n\n> export everything\n\nShall I include archived rows too?',
    vietnamese: 'Mình đã soạn REQ-1. Bạn có đồng ý không?', // i18n-allow: the owner's own language in the FB-88 evidence
    noQuestionMark: 'I drafted REQ-1. Please confirm before I file it.',
  };

  for (const [shape, content] of Object.entries(asked)) {
    it(`reads waiting on you in the list and on the room: ${shape}`, async () => {
      const id = await room(shape, [
        { role: 'user', content: 'Draft REQ-1 for the export screen' },
        { role: 'assistant', content, asks: true },
      ]);
      expect((await listed()).get(id)).toBe('waiting_on_you');
      expect(await detailed(id)).toBe('waiting_on_you');
    });
  }

  it('still waits when the agent then chose to say nothing', async () => {
    const id = await room('asked then silent', [
      { role: 'user', content: 'Draft REQ-1' },
      { role: 'assistant', content: asked.plain, asks: true },
      { role: 'assistant', content: '', silence: 'nothing-to-say' },
    ]);
    expect((await listed()).get(id)).toBe('waiting_on_you');
  });

  it('stops waiting once the person answered', async () => {
    const id = await room('replied', [
      { role: 'assistant', content: asked.plain, asks: true },
      { role: 'user', content: 'Đồng ý' }, // i18n-allow: the owner's reply in the FB-88 evidence
    ]);
    expect((await listed()).get(id)).not.toBe('waiting_on_you');
  });

  it('stops waiting once the agent wrote a reply that awaits nothing', async () => {
    const id = await room('moved on', [
      { role: 'user', content: 'Draft REQ-1' },
      { role: 'assistant', content: asked.plain, asks: true },
      { role: 'assistant', content: 'REQ-1 is filed.' },
    ]);
    expect((await listed()).get(id)).toBe('done');
  });

  it('refuses the record on a row that is not the agent speaking', async () => {
    const id = await room('a person cannot await', []);
    await refusedByDb(
      db.execute(sql`
        INSERT INTO conversation_messages (conversation_id, seq, role, content, awaits_reply)
        VALUES (${id}, 1, 'user', 'Shall I?', true)
      `),
      /conversation_messages_awaits_reply_agent/,
    );
    await refusedByDb(
      db.execute(sql`
        INSERT INTO conversation_messages
          (conversation_id, seq, role, content, silence_reason, awaits_reply)
        VALUES (${id}, 1, 'assistant', '', 'nothing-to-say', true)
      `),
      /conversation_messages_awaits_reply_agent/,
    );
  });
});

// every false wait the two independent judges reproduced, as a reply nobody recorded as asking
describe('an agent reply not recorded as awaiting an answer reads done, whatever its text', () => {
  const notAsking = {
    // the first judge, at b1ba727
    rhetorical: 'Why does this matter? Because the token expires, so the job now refreshes it.',
    quoted: 'I recorded your question "Can we ship on Friday?" in REQ-2.',
    ternary: 'Changed the default:\n\n```ts\nconst v = ok ? a : b;\n```',
    placeholder: 'The lookup now binds its id:\n\n```sql\nSELECT * FROM jobs WHERE id = ?\n```',
    // the second judge, at 9cabc03
    answeringList:
      'Why did the deploy fail?\n\n- The token had expired.\n- The retry was disabled.',
    boldQuestionThenReasons:
      '**Why did it fail?**\n\n- The token had expired.\n- The retry was disabled.',
    numberedAnswers: 'What changed?\n\n1. The export now streams.\n2. The row limit is 10,000.',
    headingQuestion:
      '### Why did the deploy fail?\n\n- The token had expired.\n- The retry was off.',
    unquotedEcho:
      'I passed your other question to the release owner: does the export include archived rows?',
    italicEcho: 'You also asked, and I noted it: *does the export include archived rows?*',
    parenthetical: 'The token is rotated nightly. (Why is my token rejected?)',
    urlEndingInQuestionMark: 'The report is at https://forge.test/reports?',
    indentedSqlNoBlankLine: 'The lookup binds its id:\n    SELECT * FROM jobs WHERE id = ?',
    recordedQuestions: "I added the client's open questions:\n\n- Can we ship?\n- Who signs off?",
    // and a real-looking question the turn did not record: the text is never read
    unrecordedQuestion: 'Shall I file REQ-1 as written?',
  };

  for (const [shape, content] of Object.entries(notAsking)) {
    it(`reads done, not waiting on you: ${shape}`, async () => {
      const id = await room(shape, [
        { role: 'user', content: 'What changed?' },
        { role: 'assistant', content },
      ]);
      expect((await listed()).get(id)).toBe('done');
      expect(await detailed(id)).toBe('done');
    });
  }
});

describe('a question the agent put to one person in a group room', () => {
  it('waits on the person it answered, and not on the other person or a reader outside', async () => {
    const id = await room(
      'asked the colleague',
      [
        { role: 'user', content: 'Draft REQ-4 for the export screen' },
        { role: 'user', content: 'Make it CSV only', by: colleague },
        { role: 'assistant', content: 'Shall I drop XLSX from REQ-4, then?', asks: true },
      ],
      [colleague],
    );
    expect((await listed(colleagueToken)).get(id)).toBe('waiting_on_you');
    expect(await detailed(id, colleagueToken)).toBe('waiting_on_you');
    expect((await listed()).get(id)).toBe('done');
    expect(await detailed(id)).toBe('done');
    expect((await listed(outsiderToken)).get(id)).toBe('done');
  });

  it('reads past another agent to the person it answered', async () => {
    const id = await room(
      'asked the owner past an agent',
      [
        { role: 'user', content: 'Draft REQ-5' },
        { role: 'user', content: 'Noted from the release agent.', by: otherAgent },
        { role: 'assistant', content: 'Shall I file REQ-5?', asks: true },
      ],
      [colleague],
    );
    expect((await listed()).get(id)).toBe('waiting_on_you');
    expect((await listed(colleagueToken)).get(id)).toBe('done');
  });

  it('waits on every person in the room when no person has spoken yet, and on nobody outside it', async () => {
    const id = await room(
      'asked the room',
      [{ role: 'assistant', content: 'Who owns REQ-6?', asks: true }],
      [colleague],
    );
    expect((await listed()).get(id)).toBe('waiting_on_you');
    expect((await listed(colleagueToken)).get(id)).toBe('waiting_on_you');
    expect((await listed(outsiderToken)).get(id)).toBe('done');
    expect(await detailed(id, outsiderToken)).toBe('done');
  });
});

describe('an open questionnaire batch', () => {
  it('waits on a reader who may answer it, and not on one who may not', async () => {
    const id = await room('batch', [{ role: 'user', content: 'Clarify REQ-7' }], [watcher]);
    const requirementId = randomUUID();
    await db.execute(sql`
      INSERT INTO requirements (id, project_id, req_seq, title)
      VALUES (${requirementId}, ${projectId}, 7, 'REQ-7')
    `);
    await db.execute(sql`
      INSERT INTO questionnaire_batches
        (project_id, conversation_id, requirement_id, title, round, status, posted_by, posted_agency)
      VALUES (${projectId}, ${id}, ${requirementId}, 'Clarify REQ-7', 1, 'open', ${owner}, 'human')
    `);
    expect((await listed()).get(id)).toBe('waiting_on_you');
    expect((await listed(watcherToken)).get(id)).toBe('done');
    expect(await detailed(id, watcherToken)).toBe('done');
  });
});

// the record is written by the turn itself: a real turn with the Forge UI's own inputs, delivered
// through the registered web transport and recorded by `recordDeliveredReply`, only the model scripted
describe('a web turn records whether its reply awaits an answer', () => {
  async function turn(title: string, script: { reply: string; ask: boolean }): Promise<string> {
    const r = await open(title);
    await db.execute(sql`
      INSERT INTO conversation_messages (conversation_id, seq, role, content, author_user_id)
      VALUES (${r.id}, 1, 'user', 'Draft REQ-8 for the export screen', ${owner})
    `);
    model.reply = script.reply;
    model.ask = script.ask;
    const venue = { adapter: 'web' as const, externalId: r.externalId, shape: r.shape, projectId };
    const inputs = webConversationTurn({
      project: { id: projectId, slug: 'waiting', name: 'Waiting' },
      handleName: 'forge',
      askedBy: null,
      window: {
        venue,
        conversationId: r.id,
        windowId: randomUUID(),
        deliveryKey: `window:${randomUUID()}`,
        mode: 'assistant',
        question: 'Draft REQ-8 for the export screen',
        images: [],
        conversationContext: async () => null,
        reserve: async () => true,
      },
      progress: new ConversationProgress(r.id, randomUUID()),
      externalStop: new AbortController().signal,
    });
    const outcome = await runConversationTurn({
      ...inputs,
      venue,
      authority: {
        userId: owner,
        projectId,
        origin: 'message',
        viaTokenId: null,
        grant: null,
        fence: null,
        scopes: [],
        grantEpoch: 0,
      },
      speakerUserId: owner,
      speakerKey: owner,
      message: 'Draft REQ-8 for the export screen',
      questionAlreadyRecorded: true,
    });
    expect(outcome.kind).toBe('delivered');
    return r.id;
  }

  async function newestAwaits(id: string): Promise<boolean | undefined> {
    const [newest] = await db
      .select({ awaitsReply: conversationMessages.awaitsReply })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, id),
          eq(conversationMessages.role, 'assistant'),
        ),
      )
      .orderBy(desc(conversationMessages.seq))
      .limit(1);
    return newest?.awaitsReply;
  }

  it('a turn whose model called await_reply writes a reply that waits on the person', async () => {
    const id = await turn('turn asked', {
      reply: 'I drafted REQ-8. Shall I file it as written?',
      ask: true,
    });
    expect(await newestAwaits(id)).toBe(true);
    expect((await listed()).get(id)).toBe('waiting_on_you');
  });

  it('a turn whose model did not call it writes a reply that waits on nobody, question mark or not', async () => {
    const id = await turn('turn answered', {
      reply: 'Why did the deploy fail?\n\n- The token had expired.\n- The retry was disabled.',
      ask: false,
    });
    expect(await newestAwaits(id)).toBe(false);
    expect((await listed()).get(id)).toBe('done');
  });
});
