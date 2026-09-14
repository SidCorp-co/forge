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

  // cm:guard a room whose only speakers are agents is measured from its OLDEST message rather than treated as fresh: reading "no person ever spoke" as "no limit" inverts the guard.
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

  // cm:guard this is the case a message COUNTER would have killed, and the reason the breaker cuts on identifiers instead: two agents settling a cross-repo change trade many messages and every one of them carries something (ISS-1004).
  it('is not cut while every message names something new', async () => {
    log(
      say('person', 'settle it', 60_000),
      say('agent', 'ISS-1004 needs packages/core/src/windows.ts', 50_000),
      say('agent', 'and ISS-1005 touches packages/web-v2/src/app.tsx', 49_000),
      say('agent', 'agreed, plus migration 0244_conversation_windows.sql', 48_000),
    );
    await expect(decide()).resolves.toEqual({ speak: true });
  });

  // cm:guard the time horizon, which the issue's own words carry: the guard is about agents bouncing QUICKLY, and an agent answering long afterwards with nothing new is a slow exchange (review F4).
  it('is not cut when the messages are further apart than the bounce interval', async () => {
    log(
      say('person', 'settle ISS-1004 between you', LOOP_BOUNCE_MS * 9),
      say('agent', 'agreed', LOOP_BOUNCE_MS * 6),
      say('agent', 'agreed', LOOP_BOUNCE_MS * 4),
      say('agent', 'agreed', LOOP_BOUNCE_MS * 2),
    );
    await expect(decide()).resolves.toEqual({ speak: true });
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

  // cm:guard `undetermined` is skipped and NOT counted toward the back-off: its outcome is not known, and counting it is a caller acting on it as a failure, which rule 4 forbids outright (ISS-1004).
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
  // cm:guard the property rule 3 names, asserted the only way it can be: the module writes nothing at all. A stored counter would make "a person spoke, so proactivity resumes" a write that can be missed, which leaves a room muted with no readable cause.
  it('takes no write to lift a guard', async () => {
    log(say('person', 'anyone about?', DORMANT_MS + 60_000));
    await expect(decide()).resolves.toMatchObject({ decision: 'guard-dormant' });

    messages.push(say('person', 'here now', 1000));
    await expect(decide()).resolves.toEqual({ speak: true });
  });
});
