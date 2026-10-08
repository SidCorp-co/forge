/**
 * ISS-277 probe P7, over every kind of reply a turn ends in. In a two-person web room the owner
 * asks; the colleague writes while the turn answering the owner is still out; the turn's reply calls
 * `await_reply`. The question was put to the owner, so the owner reads Waiting on you and the
 * colleague reads Done. The third independent judge found the opposite at 133dc2f: the wait went to
 * the newest person who wrote before the reply row, so the colleague (off to lunch) was told the
 * agent waited on them and the owner, who was asked, read Done.
 *
 * Both messages go through the real send route: the owner's opens the window its turn answers, the
 * colleague's opens a window of its own and is routed after, under the group room's hearing rules
 * (dev.123): heard and declined, left out as addressed to a person, or a stop request quieting the
 * room. The owner's turn ends three ways: a delivered reply, a partial reply and its continuation
 * (dev.129), and a failure whose report is posted (dev.139). The model is the one thing scripted;
 * the continued case also gives the turn a short first ceiling and a comment, since a group room
 * hears a partial only from a turn that already changed something in it: since REQ-30 BC-4 that
 * comment is held for the owner's go-ahead (ISS-439), and the card it puts in the room is the change.
 */

import { asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Attempt = {
  reply: string;
  ask?: boolean;
  write?: boolean;
  during?: () => Promise<void>;
  throws?: boolean;
};
const race: { attempts: Attempt[]; continues: boolean } = { attempts: [], continues: false };

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatModelName: () => 'scripted',
}));

vi.mock('../../src/assistant/external-chat.js', () => ({
  runExternalChatTurn: async (args: {
    conversationId: string;
    tools?: { execute: (name: string, argsJson: string) => Promise<unknown> };
  }) => {
    const a = race.attempts.shift();
    if (!a) throw new Error('race: no model attempt was scripted for this turn');
    if (a.write)
      await args.tools?.execute('forge', JSON.stringify({ argv: ['comment', 'ISS-61', 'noted'] }));
    if (a.ask) await args.tools?.execute('await_reply', '{}');
    if (a.during) await a.during();
    if (a.throws) throw new Error('race: the provider failed after the turn asked');
    const calls = [
      ...(a.write ? [{ name: 'forge', arguments: '{}' }] : []),
      ...(a.ask ? [{ name: 'await_reply', arguments: '{}' }] : []),
    ];
    return {
      conversationId: args.conversationId,
      reply: a.reply,
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: calls,
      progress: null,
    };
  },
}));

// the continued case only: a first ceiling short enough to outrun, and a comment the turn can write
vi.mock('../../src/assistant/web-turn-inputs.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/assistant/web-turn-inputs.js')>();
  const { mergeToolsets } = await import('../../src/assistant/tools/mcp-adapter.js');
  const comment = {
    tools: [
      {
        type: 'function' as const,
        function: { name: 'forge', description: 'forge', parameters: { type: 'object' } },
      },
    ],
    ranAs: () => null,
    execute: async () => ({
      content: [{ type: 'text' as const, text: '{"exitCode":0,"stdout":"Commented on ISS-61"}' }],
    }),
  };
  return {
    ...real,
    webConversationTurn: (args: Parameters<typeof real.webConversationTurn>[0]) => {
      const inputs = real.webConversationTurn(args);
      if (!race.continues) return inputs;
      const prepare = inputs.prepare;
      return {
        ...inputs,
        budget: { partialAfterMs: 400, ceilingMs: 30_000 },
        ...(prepare
          ? {
              prepare: async (ctx: Parameters<typeof prepare>[0]) => {
                const t = await prepare(ctx);
                return { ...t, tools: t.tools ? mergeToolsets(comment, t.tools) : comment };
              },
            }
          : {}),
      };
    },
  };
});

const { db } = await import('../../src/db/client.js');
const { conversationMessages } = await import('../../src/db/schema-conversations.js');
const { claimDueWindows, claimOf } = await import('../../src/conversations/index.js');
const { routeWebWindow } = await import('../../src/assistant/conversation-send.js');
const { api, userToken } = await import('../helpers/api.js');
const { addProjectMember, createTestProject, createTestUser } = await import(
  '../helpers/factories.js'
);

let projectId = '';
let ownerToken = '';
let colleagueToken = '';
let colleague = '';

interface Room {
  id: string;
  externalId: string;
  shape: 'direct' | 'group';
}

const QUESTION = 'Should REQ-9 cover archived rows as well, or only the live ones?';

/** What the colleague writes while the owner's turn is out, and how the room hears it. */
const COLLEAGUE = {
  heard: { says: 'I am off to lunch, back at two', model: [{ reply: '' }] as Attempt[] },
  addressedToAPerson: { says: '@sam can you cover the review while I am out?', model: [] },
  stopRequest: { says: 'stop replying', model: [] },
} as const;

async function open(title: string): Promise<Room> {
  const res = await api(ownerToken, 'POST', '/api/conversations', {
    projectId,
    title,
    people: [colleague],
  });
  expect(res.status).toBe(201);
  const room = res.body as unknown as Room;
  expect(room.shape).toBe('group');
  return room;
}

async function send(token: string, room: Room, content: string): Promise<void> {
  const res = await api(token, 'POST', `/api/conversations/${room.id}/messages`, { content });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

/** Route whatever window the room still owes, as the next send or the recovery drain would. */
async function routeOwed(room: Room): Promise<void> {
  const [window] = await claimDueWindows({
    adapter: 'web',
    claimant: 'race-probe',
    limit: 1,
    venuePrefixes: [room.externalId],
    settleMs: 0,
  });
  if (!window) return;
  const claim = claimOf(window);
  if (claim) await routeWebWindow(window, claim);
}

async function rows(id: string) {
  return db
    .select({
      seq: conversationMessages.seq,
      role: conversationMessages.role,
      content: conversationMessages.content,
      silence: conversationMessages.silenceReason,
      awaits: conversationMessages.awaitsReply,
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, id))
    .orderBy(asc(conversationMessages.seq));
}

async function statusOf(id: string, token: string) {
  const list = await api(token, 'GET', `/api/conversations?projectId=${projectId}`);
  expect(list.status).toBe(200);
  const listed = (list.body.items as { id: string; threadStatus: string }[]).find(
    (r) => r.id === id,
  )?.threadStatus;
  const detail = await api(token, 'GET', `/api/conversations/${id}`);
  expect(detail.status).toBe(200);
  return { list: listed, room: detail.body.threadStatus as string };
}

async function readings(id: string) {
  return { owner: await statusOf(id, ownerToken), colleague: await statusOf(id, colleagueToken) };
}

const waitingOnOwner = {
  owner: { list: 'waiting_on_you', room: 'waiting_on_you' },
  colleague: { list: 'done', room: 'done' },
};

beforeAll(async () => {
  const owner = (await createTestUser({ verified: true })).id;
  ownerToken = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  colleague = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, colleague);
  colleagueToken = await userToken(colleague);
});

describe('P7: the colleague writes while the turn answering the owner is out', () => {
  for (const [hearing, c] of Object.entries(COLLEAGUE)) {
    it(`a delivered reply that asked waits on the owner, not the colleague (${hearing})`, async () => {
      race.continues = false;
      const room = await open(`delivered ${hearing}`);
      race.attempts = [
        { reply: QUESTION, ask: true, during: () => send(colleagueToken, room, c.says) },
        ...c.model,
      ];
      await send(ownerToken, room, 'Draft REQ-9 for the export screen');
      await routeOwed(room);
      const said = await rows(room.id);
      expect(said.map((m) => m.content)).toContain(c.says);
      expect(said.at(-1)?.content === QUESTION || said.at(-1)?.silence !== null).toBe(true);
      expect(race.attempts).toEqual([]);
      expect(await readings(room.id), JSON.stringify(said)).toEqual(waitingOnOwner);
    });

    it(`the continuation of a partial reply that asked waits on the owner, not the colleague (${hearing})`, async () => {
      race.continues = true;
      const room = await open(`continued ${hearing}`);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      race.attempts = [{ reply: QUESTION, ask: true, write: true, during: () => held }, ...c.model];
      await send(ownerToken, room, 'Draft REQ-9 for the export screen');
      // the partial is out and the window it answered is closed; the colleague writes now
      await send(colleagueToken, room, c.says);
      await routeOwed(room);
      release();
      await vi.waitFor(
        async () => expect((await rows(room.id)).some((m) => m.content === QUESTION)).toBe(true),
        { timeout: 20_000, interval: 100 },
      );
      const said = await rows(room.id);
      const asked = said.findIndex((m) => m.content === QUESTION);
      expect(said.findIndex((m) => m.content === c.says)).toBeLessThan(asked);
      expect(said.filter((m) => m.role === 'assistant' && !m.silence).length).toBeGreaterThan(1);
      expect(race.attempts).toEqual([]);
      expect(await readings(room.id), JSON.stringify(said)).toEqual(waitingOnOwner);
    });

    it(`a turn that failed after asking waits on nobody (${hearing})`, async () => {
      race.continues = false;
      const room = await open(`failed ${hearing}`);
      race.attempts = [
        {
          reply: QUESTION,
          ask: true,
          throws: true,
          during: () => send(colleagueToken, room, c.says),
        },
        ...c.model,
      ];
      await send(ownerToken, room, 'Draft REQ-9 for the export screen');
      await routeOwed(room);
      const said = await rows(room.id);
      expect(said.some((m) => m.content === QUESTION)).toBe(false);
      expect(said.some((m) => m.awaits)).toBe(false);
      expect(race.attempts).toEqual([]);
      expect(await readings(room.id), JSON.stringify(said)).toEqual({
        owner: { list: 'done', room: 'done' },
        colleague: { list: 'done', room: 'done' },
      });
    });
  }
});
