/**
 * ISS-981 — what one tick of the comment drain does, and what it refuses to do.
 *
 * The delivery record itself is `rocketchat-comment-mirror-e2e.test.ts`; these
 * are the shape of a tick: which projects it resolves, how much of a backlog it
 * takes, and what stops two workers opening two roots for one issue. Every
 * assertion reads the row or the posted message back — a second root and a
 * starved project are both invisible from a drain's own result.
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
let nextMessageId: string | null = null;
let postCount = 0;
let postThrows: Error | null = null;
let atPostTime: (() => Promise<void>) | null = null;

vi.mock('../../src/integrations/rocketchat/outbound.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/integrations/rocketchat/outbound.js')>();
  return {
    ...actual,
    sendFixedReply: vi.fn(
      async (transport: { rid: string; tmid?: string }, text: string, proof: unknown) => {
        if (proof !== actual.FIXED_REPLY_CONSTANT && !(proof as { ok?: boolean })?.ok) {
          throw new Error('unscreened text reached the outbound door');
        }
        if (atPostTime) await atPostTime();
        if (postThrows) throw postThrows;
        postCount += 1;
        posts.push({ rid: transport.rid, tmid: transport.tmid, text });
        return { messageId: nextMessageId ?? `posted-${postCount}` };
      },
    ),
  };
});

let harness: TestDatabase;
let mirror: typeof import('../../src/integrations/rocketchat/comment-mirror.js');
let store: typeof import('../../src/integrations/store.js');
let comments: typeof import('../../src/comments/service.js');
let db: typeof import('../../src/db/client.js').db;
let schema: typeof import('../../src/db/schema.js');
let rcSchema: typeof import('../../src/db/schema-rocketchat.js');

let projectId: string;
let ownerId: string;
let issueId: string;
let seq = 0;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  mirror = await import('../../src/integrations/rocketchat/comment-mirror.js');
  store = await import('../../src/integrations/store.js');
  comments = await import('../../src/comments/service.js');
  schema = await import('../../src/db/schema.js');
  rcSchema = await import('../../src/db/schema-rocketchat.js');
  ({ db } = await import('../../src/db/client.js'));
});

afterAll(async () => {
  await harness?.cleanup();
});

/** The watermark the migration seeds is re-seeded here, since truncateAll clears it. */
async function seedWatermark(since: Date = new Date(Date.now() - 60_000)): Promise<void> {
  await db
    .insert(rcSchema.rocketchatCommentMirrorState)
    .values({ only: true, since })
    .onConflictDoUpdate({ target: rcSchema.rocketchatCommentMirrorState.only, set: { since } });
}

beforeEach(async () => {
  await truncateAll(harness.db);
  posts.length = 0;
  postCount = 0;
  nextMessageId = null;
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
    VALUES (${issueId}, ${projectId}, ${700 + seq}, 'Rooms and issues', 'in_progress', ${ownerId})
  `);
  await seedWatermark();
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
    role: 'service',
    config: { rids: [rid] },
  });
  return connection.id;
}

async function comment(body = 'a thing worth saying'): Promise<string> {
  const { row } = await comments.insertComment({
    issueId,
    authorId: ownerId,
    authorDeviceId: null,
    authorAgency: 'human',
    body,
    parentId: null,
  });
  return row.id;
}

function onlyOwed(owed: Awaited<ReturnType<typeof mirror.owedComments>>) {
  const one = owed[0];
  if (!one) throw new Error(`expected exactly one owed comment, found ${owed.length}`);
  return one;
}

const mirrorRows = async () => db.select().from(rcSchema.rocketchatCommentMirrors);
const threadRows = async () =>
  db
    .select()
    .from(rcSchema.rocketchatThreads)
    .where(eq(rcSchema.rocketchatThreads.issueId, issueId));

describe('the opening lease, not a lock, is what keeps one root', () => {
  it('opens no second root while another worker holds the opening lease', async () => {
    await bindRoom();
    const first = await comment('first');
    const second = await comment('second');
    const owed = await mirror.owedComments();
    const a = owed.find((o) => o.commentId === first);
    const b = owed.find((o) => o.commentId === second);
    if (!a || !b) throw new Error('both comments should be owed');

    let inner: string | undefined;
    atPostTime = async () => {
      if (inner !== undefined) return;
      inner = 'held';
      atPostTime = null;
      inner = await mirror.deliverOwedComment(b);
    };
    expect(await mirror.deliverOwedComment(a)).toBe('delivered');

    expect(inner).toBe('failed');
    expect(posts.filter((p) => p.tmid === undefined)).toHaveLength(1);
    expect(await threadRows()).toHaveLength(1);
    expect(
      (await mirror.owedComments(new Date(Date.now() + 3_600_000))).map((o) => o.commentId),
    ).toEqual([second]);
  });

  it('opens the root anyway when the lease belongs to a worker that died', async () => {
    const connectionId = await bindRoom();
    await comment('after a crash');
    await db.insert(rcSchema.rocketchatThreadOpenings).values({
      issueId,
      connectionId,
      rid: 'room-1',
      claimedAt: new Date(Date.now() - 600_000),
      expiresAt: new Date(Date.now() - 540_000),
    });

    const owed = await mirror.owedComments();
    expect(await mirror.deliverOwedComment(onlyOwed(owed))).toBe('delivered');
    expect(posts.filter((p) => p.tmid === undefined)).toHaveLength(1);
    expect(await db.select().from(rcSchema.rocketchatThreadOpenings)).toHaveLength(0);
  });
});

describe('the drain is bounded and takes the oldest first', () => {
  it('takes a slice of a backlog and defers the rest to the next tick', async () => {
    await bindRoom();
    const first = await comment('oldest');
    await comment('newer');
    await db
      .update(schema.comments)
      .set({ createdAt: new Date(Date.now() - 30_000) })
      .where(eq(schema.comments.id, first));

    const slice = await mirror.owedComments(new Date(), [projectId], 1);
    expect(slice.map((o) => o.commentId)).toEqual([first]);
    expect(await mirror.owedComments(new Date(), [projectId])).toHaveLength(2);
  });

  it('reads no comment body for a project nobody bound a room to', async () => {
    await comment('one');
    await comment('two');
    expect(await mirror.owedProjects()).toEqual([{ projectId, owed: 2 }]);
    expect(await mirror.owedComments(new Date(), [])).toEqual([]);
  });
});

describe('an unbound project costs one lookup, not one per comment', () => {
  it('counts every comment undeliverable without resolving a room for each', async () => {
    await comment('one');
    await comment('two');
    await comment('three');

    const result = await mirror.drainCommentMirror();
    expect(result.owed).toBe(3);
    expect(result.undeliverable).toBe(3);
    expect(posts).toHaveLength(0);
    expect(await mirrorRows()).toHaveLength(0);
    expect(await mirror.owedComments()).toHaveLength(3);
  });
});

describe('what the review found, and what now holds', () => {
  it('renews its own opening lease while the root post is still in flight', async () => {
    const connectionId = await bindRoom();
    const first = await comment('held past the lease');
    const owed = await mirror.owedComments();

    let leaseAtStart: Date | undefined;
    let leaseAfterRenewal: Date | undefined;
    atPostTime = async () => {
      atPostTime = null;
      const [before] = await db.select().from(rcSchema.rocketchatThreadOpenings);
      leaseAtStart = before?.expiresAt;
      const startedAt = (leaseAtStart as Date).getTime();
      await vi.advanceTimersByTimeAsync(25_000);
      for (let i = 0; i < 50; i += 1) {
        const [after] = await db.select().from(rcSchema.rocketchatThreadOpenings);
        leaseAfterRenewal = after?.expiresAt;
        if (leaseAfterRenewal && leaseAfterRenewal.getTime() > startedAt) break;
        await vi.advanceTimersByTimeAsync(100);
      }
    };

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      expect(await mirror.deliverOwedComment(onlyOwed(owed))).toBe('delivered');
    } finally {
      vi.useRealTimers();
    }

    expect(leaseAtStart).toBeDefined();
    expect(leaseAfterRenewal).toBeDefined();
    expect(leaseAfterRenewal?.getTime()).toBeGreaterThan((leaseAtStart as Date).getTime());
    expect(posts.filter((p) => p.tmid === undefined)).toHaveLength(1);
    void connectionId;
    void first;
  });

  it('refuses to post one room credentials against a thread registered in another', async () => {
    const roomA = await bindRoom('room-a');
    const roomB = (
      await store.createConnection({
        ownerType: 'user',
        ownerId,
        provider: 'rocketchat',
        config: { serverUrl: 'https://chat.example.com' },
        secrets: { authToken: 'tok', userId: 'bot' },
      })
    ).id;
    const owedId = await comment('rebound mid-flight');
    const registry = await import('../../src/integrations/rocketchat/thread-registry.js');

    atPostTime = async () => {
      atPostTime = null;
      await registry.registerThread(
        { issueId },
        { connectionId: roomB, rid: 'room-b', tmid: 'root-in-b' },
      );
    };

    const outcome = await mirror.deliverOwedComment(
      { commentId: owedId, issueId, projectId, body: 'rebound mid-flight', attempts: 0 },
      new Date(),
      { connectionId: roomA, rid: 'room-a' },
    );

    expect(outcome).toBe('failed');
    expect(posts.some((p) => p.tmid === 'root-in-b')).toBe(false);
  });
});
