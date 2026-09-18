/**
 * ISS-1088 — what a room that is somebody asking is owed, against a real
 * Postgres: the acknowledgement around the turn, the one status when the
 * answer did not land, the address on the reply, and the rows each leaves.
 *
 * The model and the screen are stubbed; the window, the turn runner, the
 * transcript and the participants are real.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screenPasses } from '../../src/messaging/screen-passes.fixture.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const runExternalChatTurn = vi.fn();
vi.mock('../../src/assistant/external-chat.js', () => ({
  runExternalChatTurn: (...a: unknown[]) => runExternalChatTurn(...a),
}));
vi.mock('../../src/messaging/reply-screen.js', () => ({
  screenReplyAtDoor: screenPasses,
}));

let harness: TestDatabase;
let store: typeof import('../../src/conversations/store.js');
let ports: typeof import('../../src/conversations/ports.js');
let collect: typeof import('../../src/conversations/collect-inbound.js');
let windows: typeof import('../../src/conversations/windows.js');
let participants: typeof import('../../src/conversations/participants.js');
let routeWindow: typeof import('../../src/conversations/route-window.js').routeWindow;
let statuses: typeof import('../../src/conversations/fallback-replies.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  store = await import('../../src/conversations/store.js');
  ports = await import('../../src/conversations/ports.js');
  collect = await import('../../src/conversations/collect-inbound.js');
  windows = await import('../../src/conversations/windows.js');
  participants = await import('../../src/conversations/participants.js');
  statuses = await import('../../src/conversations/fallback-replies.js');
  ({ routeWindow } = await import('../../src/conversations/route-window.js'));
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let projectId: string;
const acks: unknown[] = [];
const deliveries: Array<{ text: string; opts: unknown }> = [];

/** A transport that records what it is asked and addresses like Rocket.Chat does. */
const recording = {
  adapter: 'rocketchat' as const,
  async deliver(_venue: unknown, message: { text: string }, opts?: { addressee?: string | null }) {
    const text = opts?.addressee ? `@${opts.addressee} ${message.text}` : message.text;
    deliveries.push({ text, opts });
    return {
      messageId: `rc-out-${deliveries.length}`,
      ...(text !== message.text ? { deliveredText: text } : {}),
    };
  },
  async fetchHistory() {
    return [];
  },
  async acknowledge(_venue: unknown, ack: unknown) {
    acks.push(ack);
  },
};

const answered = (reply: string) => ({
  conversationId: 'ignored',
  assistantMessageId: null,
  reply,
  terminal: 'done' as const,
  error: null,
  iterations: 1,
  toolCalls: [],
  progress: null,
});

beforeEach(async () => {
  await truncateAll(harness.db);
  acks.length = 0;
  deliveries.length = 0;
  runExternalChatTurn.mockReset();
  ports.clearConversationTransports();
  ports.registerConversationTransport(recording);
  ownerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
});

const venue = () => ({
  adapter: 'rocketchat' as const,
  externalId: `chat.example.co ${randomUUID().slice(0, 8)}`,
  shape: 'group' as const,
  projectId,
});

async function say(v: ReturnType<typeof venue>, who: string, text: string, id: string) {
  const out = await collect.collectInboundMessage({
    ports: {
      ...recording,
      resolveVenue: async () => v,
      resolveSpeaker: async () => ({
        linked: false as const,
        refusal: { code: 'X', message: 'unlinked' },
      }),
    } as never,
    frame: {},
    message: text,
    speakerKey: `u-${who}`,
    speakerLabel: who,
    externalMessageId: id,
    manySpeakersPrincipalUserId: ownerId,
  });
  if (out.kind !== 'collected') throw new Error('not collected');
  return out;
}

/** Make every collected message old enough for the receipt floor, then claim the room's window. */
async function claim(conversationId: string) {
  await harness.db.execute(
    sql`UPDATE conversation_messages SET created_at = now() - interval '10 seconds' WHERE conversation_id = ${conversationId}`,
  );
  const [window] = await windows.claimDueWindows({
    adapter: 'rocketchat',
    claimant: 'test-core',
    limit: 10,
    settleMs: 0,
    holdMs: 0,
  });
  if (!window) throw new Error('no window to claim');
  return window;
}

const route = (window: Awaited<ReturnType<typeof claim>>) =>
  routeWindow({
    window,
    manySpeakersPrincipalUserId: ownerId,
    inputs: () => ({ door: 'chat-sync', handleName: 'Babo' }),
  });

async function roomWithTwoPeople(v = venue()) {
  const room = await store.openConversation(v);
  const [handle] = await participants.roomHandles(room.id);
  if (!handle?.handle) throw new Error('the room opened with no named handle');
  await say(v, 'alice', `@${handle.handle} why is CI red?`, 'rc-ask-1');
  await say(v, 'bob', 'lunch?', 'rc-bob-1');
  return { room, v, handle: handle.handle };
}

describe('an explicit request in a room of two people', () => {
  it('is acknowledged around the turn, answered to the asker, and posts no status (criteria 2, 7, 8, 20)', async () => {
    const { room } = await roomWithTwoPeople();
    runExternalChatTurn.mockResolvedValue(answered('the build is green'));
    expect(await participants.personCount(room.id)).toBe(2);

    const routed = await route(await claim(room.id));
    expect(routed.decision).toBe('answered');
    expect(acks).toEqual([
      { kind: 'working', on: true },
      { kind: 'received', messageId: 'rc-ask-1', on: true },
      { kind: 'working', on: false },
      { kind: 'received', messageId: 'rc-ask-1', on: false },
    ]);
    expect(deliveries).toEqual([
      { text: '@alice the build is green', opts: { addressee: 'alice' } },
    ]);
    const rows = await store.readMessages(room.id, 10);
    const assistant = rows.filter((r) => r.role === 'assistant');
    expect(assistant.map((r) => r.content)).toEqual(['@alice the build is green']);
    expect(deliveries.some((d) => d.text.includes('chưa'))).toBe(false);
  });

  it('a failed turn ends as a named silence and posts the nothing-posted status into the asker’s thread, once (criteria 9, 10, 15, 19)', async () => {
    const { room } = await roomWithTwoPeople();
    runExternalChatTurn.mockRejectedValue(new Error('provider exploded'));

    const window = await claim(room.id);
    const routed = await route(window);
    expect(routed).toMatchObject({
      decision: 'nothing-to-say',
      detail: {
        reason: 'turn-failed',
        status: { status: 'nothing-posted', anchor: 'rc-ask-1', delivered: true },
      },
    });
    expect(deliveries).toEqual([
      { text: statuses.nothingPostedStatus('Babo'), opts: { anchor: 'rc-ask-1' } },
    ]);
    expect(acks.slice(-2)).toEqual([
      { kind: 'working', on: false },
      { kind: 'received', messageId: 'rc-ask-1', on: false },
    ]);
    const rows = await store.readMessages(room.id, 10);
    const assistant = rows.filter((r) => r.role === 'assistant');
    expect(assistant.map((r) => [r.content, r.silenceReason])).toEqual([
      ['', 'turn-failed'],
      [statuses.nothingPostedStatus('Babo'), null],
    ]);
    // the status row carries the window's key and the decision, so a re-claim finds it and neither answers again nor posts twice
    expect(
      await store.deliveredDecisionUnderKey(room.id, windows.windowDeliveryKey(window.id)),
    ).toBe('nothing-to-say');
    const [closed] = await harness.db.execute<{ decision: string }>(
      sql`SELECT decision FROM conversation_windows WHERE id = ${window.id}`,
    );
    expect(closed?.decision).toBe('nothing-to-say');
  });
});

describe('unsolicited speech in a room', () => {
  it('is neither acknowledged nor given a status, however the turn ends (criteria 5, 13)', async () => {
    const v = venue();
    const room = await store.openConversation(v);
    await say(v, 'alice', 'the build is red again', 'rc-1');
    await say(v, 'bob', 'yeah', 'rc-2');
    runExternalChatTurn.mockRejectedValue(new Error('provider exploded'));
    const routed = await route(await claim(room.id));
    expect(routed.decision).toBe('nothing-to-say');
    expect(acks).toEqual([]);
    expect(deliveries).toEqual([]);
  });

  it('a reply from one person alone carries no address (criterion 20)', async () => {
    const v = venue();
    const room = await store.openConversation(v);
    const [handle] = await participants.roomHandles(room.id);
    await say(v, 'alice', `@${handle?.handle} status?`, 'rc-1');
    runExternalChatTurn.mockResolvedValue(answered('all green'));
    await route(await claim(room.id));
    expect(deliveries).toEqual([{ text: 'all green', opts: { addressee: null } }]);
  });
});
