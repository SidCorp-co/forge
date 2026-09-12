/**
 * ISS-978 — a parked question reaches a room, and the record of that is durable.
 *
 * Every assertion reads the delivery row back rather than trusting the return
 * value: a round marked delivered that was never posted, and a round posted
 * that was never marked, are the two failures this lane exists to catch, and
 * neither is visible from the function's own result.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const posts: Array<{ rid: string; tmid: string | undefined; text: string }> = [];
let nextMessageId: string | null = 'msg-1';
let postThrows: Error | null = null;
// cm:guard read DURING the post, which is the only moment that can tell a round marked complete before it succeeded from one marked after: every state after the call returns is identical either way, and a process that dies here is what the rule is about (ISS-978 criterion 6).
let atPostTime: (() => Promise<void>) | null = null;

vi.mock('../../src/integrations/rocketchat/outbound.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/integrations/rocketchat/outbound.js')>();
  return {
    ...actual,
    sendFixedReply: vi.fn(
      async (transport: { rid: string; tmid?: string }, text: string, proof: unknown) => {
        // cm:guard the mock re-asserts the proof contract the real door enforces, so a caller that stopped screening its text fails here instead of passing because the door was replaced.
        if (proof !== actual.FIXED_REPLY_CONSTANT && !(proof as { ok?: boolean })?.ok) {
          throw new Error('unscreened text reached the outbound door');
        }
        if (atPostTime) await atPostTime();
        if (postThrows) throw postThrows;
        posts.push({ rid: transport.rid, tmid: transport.tmid, text });
        return { messageId: nextMessageId };
      },
    ),
  };
});

let harness: TestDatabase;
let delivery: typeof import('../../src/integrations/rocketchat/question-delivery.js');
let write: typeof import('../../src/questions/write.js');
let store: typeof import('../../src/integrations/store.js');
let db: typeof import('../../src/db/client.js').db;
let rcSchema: typeof import('../../src/db/schema-rocketchat.js');

let projectId: string;
let ownerId: string;
let issueId: string;
let seq = 0;

const OPTIONS = [
  {
    id: '22222222-2222-4222-8222-222222222222',
    label: 'Take the safe path',
    authority: 'writer' as const,
    bindsTo: 'session' as const,
    executedBy: 'agent' as const,
  },
  {
    id: '11111111-1111-4111-8111-111111111111',
    label: 'Drop the column',
    authority: 'admin' as const,
    bindsTo: 'project' as const,
    executedBy: 'human' as const,
  },
];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  delivery = await import('../../src/integrations/rocketchat/question-delivery.js');
  write = await import('../../src/questions/write.js');
  store = await import('../../src/integrations/store.js');
  rcSchema = await import('../../src/db/schema-rocketchat.js');
  ({ db } = await import('../../src/db/client.js'));
});

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  posts.length = 0;
  nextMessageId = 'msg-1';
  postThrows = null;
  atPostTime = null;
  const user = await createTestUser(harness.db, { email: `owner-${randomUUID()}@example.com` });
  ownerId = user.id;
  const project = await createTestProject(harness.db, ownerId);
  projectId = project.id;
  issueId = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, ${900 + seq}, 'A parked issue', 'in_progress', ${ownerId})
  `);
});

async function bindRoom(rid = 'room-1'): Promise<string> {
  const connection = await store.createConnection({
    ownerType: 'user',
    ownerId,
    provider: 'rocketchat',
    config: { serverUrl: 'https://chat.example.com' },
    secrets: { authToken: 'tok', userId: 'bot' },
  });
  await store.createBinding({
    connectionId: connection.id,
    projectId,
    provider: 'rocketchat',
    environment: 'prod',
    config: { rids: [rid] },
  });
  return connection.id;
}

async function ask(over: { blockerKind?: 'human' | 'machine' } = {}) {
  return write.askQuestion({
    id: randomUUID(),
    projectId,
    issueId,
    prompt: 'The migration drops a column. Which way?',
    blockerKind: over.blockerKind ?? 'human',
    options: OPTIONS,
    recommendedOptionId: OPTIONS[0]!.id,
  });
}

const deliveries = async (questionId: string) =>
  db
    .select()
    .from(rcSchema.rocketchatQuestionDeliveries)
    .where(eq(rcSchema.rocketchatQuestionDeliveries.questionId, questionId));

const threadOf = async (questionId: string) =>
  (
    await db
      .select()
      .from(rcSchema.rocketchatQuestionThreads)
      .where(eq(rcSchema.rocketchatQuestionThreads.questionId, questionId))
  )[0] ?? null;

describe('the obligation is derived, not written by the kernel', () => {
  it('owes a round for an open human question the moment it is asked, with no hook fired', async () => {
    await bindRoom();
    const q = await ask();
    // cm:guard nothing has emitted anything — `askQuestion` is the only call made — so an obligation visible here is one derived from the question row itself (ISS-978 criterion 5).
    const owed = await delivery.owedRounds();
    expect(owed.map((o) => o.questionId)).toEqual([q.id]);
    expect(owed[0]?.round).toBe(1);
  });

  it('owes nothing for a machine blocker, which resolves without a person', async () => {
    await bindRoom();
    await ask({ blockerKind: 'machine' });
    expect(await delivery.owedRounds()).toEqual([]);
  });

  it('owes nothing once the round is delivered', async () => {
    await bindRoom();
    const q = await ask();
    await delivery.drainQuestionDeliveries();
    expect(await delivery.owedRounds()).toEqual([]);
    expect((await deliveries(q.id))[0]?.status).toBe('delivered');
  });

  it('owes nothing for a question that is no longer open', async () => {
    await bindRoom();
    const q = await ask();
    await write.voidQuestion({ questionId: q.id, reason: 'the premise moved' });
    expect(await delivery.owedRounds()).toEqual([]);
  });

  it('writes the question row whole while the chat transport is throwing', async () => {
    await bindRoom();
    postThrows = new Error('rocket.chat is down');
    const q = await ask();
    const [row] = await db
      .select()
      .from((await import('../../src/db/schema-questions.js')).agentQuestions)
      .where(eq((await import('../../src/db/schema-questions.js')).agentQuestions.id, q.id));
    expect(row?.status).toBe('open');
    expect(row?.steps).toHaveLength(1);
    expect(posts).toEqual([]);
  });
});

describe('delivering a round', () => {
  it('posts a message naming the issue, the prompt and every option', async () => {
    await bindRoom();
    await ask();
    await delivery.drainQuestionDeliveries();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.rid).toBe('room-1');
    expect(posts[0]?.tmid).toBeUndefined();
    expect(posts[0]?.text).toContain(`ISS-${900 + seq}`);
    expect(posts[0]?.text).toContain('The migration drops a column. Which way?');
    expect(posts[0]?.text).toContain('1. Take the safe path');
    expect(posts[0]?.text).toContain('2. Drop the column');
  });

  it('marks delivered only after the post named a message id, and stores it as the thread', async () => {
    await bindRoom();
    const q = await ask();
    await delivery.drainQuestionDeliveries();
    const [row] = await deliveries(q.id);
    expect(row?.status).toBe('delivered');
    const thread = await threadOf(q.id);
    expect(thread?.tmid).toBe('msg-1');
    expect(thread?.rid).toBe('room-1');
    expect(thread?.connectionId).not.toBeNull();
  });

  it('has not marked the round delivered at the moment the post is made', async () => {
    await bindRoom();
    const q = await ask();
    const seenDuringPost: Array<string | undefined> = [];
    atPostTime = async () => {
      const rows = await deliveries(q.id);
      seenDuringPost.push(rows[0]?.status);
    };
    await delivery.drainQuestionDeliveries();
    expect(seenDuringPost).toHaveLength(1);
    // cm:guard `undefined` is the pass: there must be NO row yet. A row reading `delivered` here is a round a crash would leave marked complete and never posted, which is the whole of the rule (ISS-978 criterion 6).
    // cm:guard `claimed` is the pass and `delivered` is the failure: the row must already exist so a second core instance cannot post the same round, and it must not yet claim success (ISS-978 criteria 5, 6).
    expect(seenDuringPost[0]).toBe('claimed');
    expect((await deliveries(q.id))[0]?.status).toBe('delivered');
  });

  it('leaves the round owed when the post names no message id', async () => {
    await bindRoom();
    nextMessageId = null;
    const q = await ask();
    await delivery.drainQuestionDeliveries();
    const [row] = await deliveries(q.id);
    expect(row?.status).toBe('claimed');
    expect(await threadOf(q.id)).toBeNull();
    expect(row?.lastError).toContain('no message id');
  });

  it('leaves the round owed when the post throws, and retries it on a later drain', async () => {
    await bindRoom();
    postThrows = new Error('rocket.chat is down');
    const q = await ask();
    await delivery.drainQuestionDeliveries();
    let [row] = await deliveries(q.id);
    expect(row?.status).toBe('claimed');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain('rocket.chat is down');

    postThrows = null;
    // cm:guard the later drain is given a clock PAST the backoff this attempt wrote, because the retry is what the row's `next_attempt_at` schedules — a drain at the same instant proves only that the row exists.
    const later = new Date(Date.now() + 10 * 60_000);
    await delivery.drainQuestionDeliveries(later);
    [row] = await deliveries(q.id);
    expect(row?.status).toBe('delivered');
    expect(row?.attempts).toBe(2);
    expect(posts).toHaveLength(1);
  });

  it('posts a follow-up round into the thread the first round opened', async () => {
    await bindRoom();
    const q = await ask();
    await delivery.drainQuestionDeliveries();
    await write.askFollowUp({
      questionId: q.id,
      prompt: 'Neither worked. Which now?',
      options: OPTIONS,
      recommendedOptionId: OPTIONS[0]!.id,
    });
    nextMessageId = 'msg-2';
    await delivery.drainQuestionDeliveries();
    expect(posts).toHaveLength(2);
    expect(posts[1]?.tmid).toBe('msg-1');
    expect(posts[1]?.rid).toBe('room-1');
    expect(posts[1]?.text).toContain('2-1. Take the safe path');
    const rows = await deliveries(q.id);
    expect(rows.map((r) => r.round).sort()).toEqual([1, 2]);
    expect(rows.every((r) => r.status === 'delivered')).toBe(true);
    // cm:guard ONE thread row for the whole question, still naming round one's message: a second row would be a second thread, and "is this reply an answer or a comment?" stops being decidable from the message alone (ISS-978 criterion 9).
    const threads = await db
      .select()
      .from(rcSchema.rocketchatQuestionThreads)
      .where(eq(rcSchema.rocketchatQuestionThreads.questionId, q.id));
    expect(threads).toHaveLength(1);
    expect(threads[0]?.tmid).toBe('msg-1');
  });
});

describe('two core instances draining at once', () => {
  it('posts the round once — the instance that did not claim it finds it held', async () => {
    await bindRoom();
    await ask();
    // cm:guard both instances derive the SAME owed round BEFORE either claims, which is the only arrangement that reaches the claim: derived in sequence, the second finds nothing owed and the conflict predicate is never exercised (ISS-978 criterion 5).
    const [owed] = await delivery.owedRounds();
    expect(owed).toBeDefined();
    const first = await delivery.deliverOwedRound(owed!);
    const second = await delivery.deliverOwedRound(owed!);
    expect(first).toBe('delivered');
    expect(second).toBe('held');
    expect(posts).toHaveLength(1);
  });

  it('leaves nothing owed to a second drain once the first has claimed it', async () => {
    await bindRoom();
    await ask();
    const [owed] = await delivery.owedRounds();
    await delivery.deliverOwedRound(owed!);
    expect((await delivery.drainQuestionDeliveries()).owed).toBe(0);
    expect(posts).toHaveLength(1);
  });
});

describe('a project with no bound room', () => {
  it('is reported to somebody who can bind one, and the round stays owed', async () => {
    const q = await ask();
    await delivery.drainQuestionDeliveries();
    expect(posts).toEqual([]);
    const [row] = await deliveries(q.id);
    expect(row?.status).toBe('undeliverable');
    const notes = await harness.db.execute(
      sql`SELECT user_id, type, title, body FROM notifications WHERE project_id = ${projectId}`,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.user_id).toBe(ownerId);
    expect(String(notes[0]?.body)).toContain('Bind one');
  });

  it('tells them once, not on every retry', async () => {
    await ask();
    await delivery.drainQuestionDeliveries();
    for (let i = 1; i <= 4; i++) {
      await delivery.drainQuestionDeliveries(new Date(Date.now() + i * 60 * 60_000));
    }
    const notes = await harness.db.execute(
      sql`SELECT id FROM notifications WHERE project_id = ${projectId}`,
    );
    // cm:guard `createNotification` inserts unconditionally — `resolutionKey` is what clears a row later, not a dedup key — so five drains against a roomless project would otherwise be five rows in somebody's list (ISS-978 criterion 24).
    expect(notes).toHaveLength(1);
  });

  it('keeps owing the round however long the room takes to arrive', async () => {
    const q = await ask();
    await delivery.drainQuestionDeliveries();
    // cm:guard far past the attempts cap a real failure would hit: what an undeliverable round waits on is a person binding a room, and a capped retry would make a room bound an hour late deliver nothing (ISS-978 criterion 25).
    let clock = Date.now();
    for (let i = 0; i < 12; i++) {
      clock += 60 * 60_000;
      await delivery.drainQuestionDeliveries(new Date(clock));
    }
    expect((await deliveries(q.id))[0]?.attempts).toBeGreaterThan(8);
    await bindRoom('room-eventually');
    clock += 60 * 60_000;
    await delivery.drainQuestionDeliveries(new Date(clock));
    expect(posts).toHaveLength(1);
    expect((await deliveries(q.id))[0]?.status).toBe('delivered');
  });

  it('delivers the already-open question once a room is bound, without it being asked again', async () => {
    const q = await ask();
    await delivery.drainQuestionDeliveries();
    expect(posts).toEqual([]);

    await bindRoom('room-late');
    const later = new Date(Date.now() + 10 * 60_000);
    await delivery.drainQuestionDeliveries(later);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.rid).toBe('room-late');
    const rows = await deliveries(q.id);
    // cm:guard ONE row, still round one: a second round would mean the run was made to ask again, which is exactly what binding a room must not cost (ISS-978 criterion 25).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.round).toBe(1);
    expect(rows[0]?.status).toBe('delivered');
    const [question] = await db
      .select()
      .from((await import('../../src/db/schema-questions.js')).agentQuestions)
      .where(eq((await import('../../src/db/schema-questions.js')).agentQuestions.id, q.id));
    expect(question?.steps).toHaveLength(1);
  });
});

describe('the record lives on its own table', () => {
  it('adds no delivery column to agent_questions', async () => {
    const cols = await harness.db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_questions'`,
    );
    const names = cols.map((c) => String(c.column_name));
    for (const forbidden of ['tmid', 'rid', 'connection_id', 'delivered_at', 'delivery_status']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('keys the thread by the connection, the room and the thread id', async () => {
    const idx = await harness.db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'rcq_threads_room_idx'`,
    );
    expect(idx).toHaveLength(1);
    const def = String(idx[0]?.indexdef);
    expect(def).toContain('UNIQUE');
    expect(def).toContain('connection_id');
    expect(def).toContain('rid');
    expect(def).toContain('tmid');
  });

  it('finds the question a thread belongs to, and only that thread', async () => {
    const connectionId = await bindRoom();
    const q = await ask();
    await delivery.drainQuestionDeliveries();
    expect(
      await delivery.questionForThread({ connectionId, rid: 'room-1', tmid: 'msg-1' }),
    ).toEqual({ questionId: q.id });
    expect(
      await delivery.questionForThread({ connectionId, rid: 'room-1', tmid: 'someone-elses' }),
    ).toBeNull();
    expect(
      await delivery.questionForThread({ connectionId, rid: 'other-room', tmid: 'msg-1' }),
    ).toBeNull();
  });
});
