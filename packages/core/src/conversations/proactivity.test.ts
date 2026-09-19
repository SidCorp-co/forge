/**
 * The three guards, over a message log and a set of window decisions.
 *
 * The DB reads are stubbed and the log is handed in, because what is under test
 * is the judgement and not the query: each case is a room in a state, and the
 * assertion is which of the three — or none — that state is.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const messages: Array<Record<string, unknown>> = [];
vi.mock('./store.js', () => ({
  readMessages: async () => messages,
}));

const decisions: Array<{ decision: string; closedAt: Date }> = [];
vi.mock('./windows.js', () => ({
  recentDecisions: async () => decisions,
}));

/** Who is an agent, by `users.kind`. */
const agents = new Set<string>();
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [...agents].map((id) => ({ id })),
      }),
    }),
  },
}));

const { BACKOFF_AFTER, DORMANT_MS, LOOP_BOUNCE_MS, LOOP_LIMIT, decideProactivity } = await import(
  './proactivity.js'
);

const NOW = new Date('2026-09-14T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let seq = 0;
function say(
  who: 'person' | 'agent' | 'assistant',
  content: string,
  msAgo: number,
): Record<string, unknown> {
  const id = who === 'agent' ? 'agent-user' : 'person-user';
  if (who === 'agent') agents.add(id);
  return {
    id: `m${seq}`,
    seq: seq++,
    role: who === 'assistant' ? 'assistant' : 'user',
    authorUserId: who === 'assistant' ? 'handle-user' : id,
    authorLabel: who,
    content,
    images: [],
    externalId: null,
    deliveryProof: null,
    silenceReason: null,
    createdAt: ago(msAgo),
  };
}

function log(...rows: Array<Record<string, unknown>>): void {
  messages.length = 0;
  messages.push(...rows);
}

beforeEach(() => {
  messages.length = 0;
  decisions.length = 0;
  agents.clear();
  agents.add('agent-user');
  seq = 0;
});

const decide = () => decideProactivity({ conversationId: 'c1', now: NOW });

describe('a room nobody has spoken in', () => {
  it('stops being spoken to past the dormancy window', async () => {
    log(say('person', 'anyone about?', DORMANT_MS + 60_000));
    await expect(decide()).resolves.toMatchObject({ speak: false, decision: 'guard-dormant' });
  });

  it('is spoken to again the moment a person says anything', async () => {
    log(say('person', 'anyone about?', DORMANT_MS + 60_000), say('person', 'still here', 1000));
    await expect(decide()).resolves.toEqual({ speak: true });
  });

  it('counts a room with no person in it at all', async () => {
    log(say('agent', 'ISS-1', DORMANT_MS + 60_000));
    await expect(decide()).resolves.toMatchObject({ decision: 'guard-dormant' });
  });
});

describe('agents bouncing', () => {
  const bounce = (msAgo: number) => say('agent', 'agreed, sounds right', msAgo);

  it('is cut once enough of them introduce nothing new', async () => {
    log(
      say('person', 'settle ISS-1004 between you', 60_000),
      ...Array.from({ length: LOOP_LIMIT }, (_, i) => bounce(50_000 - i * 1000)),
    );
    await expect(decide()).resolves.toMatchObject({ speak: false, decision: 'guard-agent-loop' });
  });

  it('is not cut while every message names something new', async () => {
    log(
      say('person', 'settle it', 60_000),
      say('agent', 'ISS-1004 needs packages/core/src/windows.ts', 50_000),
      say('agent', 'and ISS-1005 touches packages/web-v2/src/app.tsx', 49_000),
      say('agent', 'agreed, plus migration 0244_conversation_windows.sql', 48_000),
    );
    await expect(decide()).resolves.toEqual({ speak: true });
  });

  it('is not cut while every message names a new doubled-underscore token', async () => {
    log(
      say('person', 'settle it', 60_000),
      ...Array.from({ length: LOOP_LIMIT }, (_, i) =>
        say('agent', `next is w${i}__window`, 50_000 - i * 1000),
      ),
    );
    await expect(decide()).resolves.toEqual({ speak: true });
  });

  it('is not cut when the messages are further apart than the bounce interval', async () => {
    log(
      say('person', 'settle ISS-1004 between you', LOOP_BOUNCE_MS * 9),
      say('agent', 'agreed', LOOP_BOUNCE_MS * 6),
      say('agent', 'agreed', LOOP_BOUNCE_MS * 4),
      say('agent', 'agreed', LOOP_BOUNCE_MS * 2),
    );
    await expect(decide()).resolves.toEqual({ speak: true });
  });

  it('is cut when the agents keep repeating an identifier one of them introduced', async () => {
    log(
      say('person', 'settle it', 60_000),
      say('agent', 'ISS-42 is the one', 50_000),
      say('agent', 'yes, ISS-42', 49_000),
      say('agent', 'ISS-42 indeed', 48_000),
      say('agent', 'ISS-42 it is', 47_000),
    );
    await expect(decide()).resolves.toMatchObject({ speak: false, decision: 'guard-agent-loop' });
  });

  it('is cut for a burst that happened long before the window was routed', async () => {
    const old = LOOP_BOUNCE_MS * 20;
    log(
      say('person', 'settle ISS-1004 between you', old + 60_000),
      ...Array.from({ length: LOOP_LIMIT }, (_, i) => bounce(old + 3000 - i * 1000)),
    );
    await expect(decide()).resolves.toMatchObject({ speak: false, decision: 'guard-agent-loop' });
  });

  it('is lifted by a person speaking between the agents', async () => {
    log(
      ...Array.from({ length: LOOP_LIMIT }, (_, i) => bounce(50_000 - i * 1000)),
      say('person', 'hold on', 1000),
    );
    await expect(decide()).resolves.toEqual({ speak: true });
  });
});

describe('a room where nothing has been worth saying', () => {
  const quiet = (n: number) => ({ decision: 'nothing-to-say', closedAt: ago(n * 1000) });

  it('backs off once the run reaches the limit', async () => {
    log(say('person', 'chatter', 60_000));
    decisions.push(...Array.from({ length: BACKOFF_AFTER }, (_, i) => quiet(i + 1)));
    await expect(decide()).resolves.toMatchObject({ speak: false, decision: 'guard-backoff' });
  });

  it('does not back off one window short of the limit', async () => {
    log(say('person', 'chatter', 60_000));
    decisions.push(...Array.from({ length: BACKOFF_AFTER - 1 }, (_, i) => quiet(i + 1)));
    await expect(decide()).resolves.toEqual({ speak: true });
  });

  it('is reset by a window that did answer', async () => {
    log(say('person', 'chatter', 60_000));
    decisions.push(
      { decision: 'answered', closedAt: ago(500) },
      ...Array.from({ length: BACKOFF_AFTER }, (_, i) => quiet(i + 1)),
    );
    await expect(decide()).resolves.toEqual({ speak: true });
  });

  it('stays backed off while no person has spoken since it fired', async () => {
    log(say('person', 'chatter', 60_000));
    decisions.push(
      { decision: 'guard-backoff', closedAt: ago(500) },
      ...Array.from({ length: BACKOFF_AFTER - 1 }, (_, i) => quiet(i + 1)),
    );
    await expect(decide()).resolves.toMatchObject({ speak: false, decision: 'guard-backoff' });
  });

  it('does not count an undetermined window against the room', async () => {
    log(say('person', 'chatter', 60_000));
    decisions.push(
      { decision: 'undetermined', closedAt: ago(500) },
      ...Array.from({ length: BACKOFF_AFTER - 1 }, (_, i) => quiet(i + 1)),
    );
    await expect(decide()).resolves.toEqual({ speak: true });
  });
});

describe('nothing is stored', () => {
  it('takes no write to lift a guard', async () => {
    log(say('person', 'anyone about?', DORMANT_MS + 60_000));
    await expect(decide()).resolves.toMatchObject({ decision: 'guard-dormant' });

    messages.push(say('person', 'here now', 1000));
    await expect(decide()).resolves.toEqual({ speak: true });
  });
});

describe('a room whose handle asked to back off sooner', () => {
  const quiet = (n: number) => ({ decision: 'nothing-to-say', closedAt: ago(n * 1000) });
  const thresholds = {
    dormantMs: DORMANT_MS,
    backoffAfter: 1,
    loopBounceMs: LOOP_BOUNCE_MS,
    loopLimit: LOOP_LIMIT,
  };

  it('backs off after ONE quiet window where the default needs three', async () => {
    log(say('person', 'chatter', 60_000));
    decisions.push(quiet(1));
    await expect(decide()).resolves.toEqual({ speak: true });
    await expect(
      decideProactivity({ conversationId: 'c1', now: NOW, thresholds }),
    ).resolves.toMatchObject({ speak: false, decision: 'guard-backoff' });
  });

  it('goes dormant sooner when told to', async () => {
    log(say('person', 'chatter', 2 * 60 * 60 * 1000));
    await expect(decide()).resolves.toEqual({ speak: true });
    await expect(
      decideProactivity({
        conversationId: 'c1',
        now: NOW,
        thresholds: { ...thresholds, backoffAfter: BACKOFF_AFTER, dormantMs: 60 * 60 * 1000 },
      }),
    ).resolves.toMatchObject({ speak: false, decision: 'guard-dormant' });
  });
});
