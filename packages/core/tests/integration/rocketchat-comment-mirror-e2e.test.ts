/**
 * ISS-981 — an issue's comments and a room thread are one conversation.
 *
 * Every assertion reads the row back rather than trusting a return value: a
 * comment marked delivered that was never posted, a room message that became
 * two comments, and a mirrored comment that echoed back into the room it came
 * from are the three failures this lane exists to catch, and none of them is
 * visible from a function's own result.
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
// cm:guard read DURING the post, which is the only moment that can tell a comment marked delivered before it succeeded from one marked after: every state once the call returns is identical either way, and a process that dies here is what the at-least-once rule is about (ISS-981 criteria 30, 31).
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
        postCount += 1;
        posts.push({ rid: transport.rid, tmid: transport.tmid, text });
        return { messageId: nextMessageId ?? `posted-${postCount}` };
      },
    ),
  };
});

let harness: TestDatabase;
let mirror: typeof import('../../src/integrations/rocketchat/comment-mirror.js');
let inbound: typeof import('../../src/integrations/rocketchat/comment-inbound.js');
let registry: typeof import('../../src/integrations/rocketchat/thread-registry.js');
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
  inbound = await import('../../src/integrations/rocketchat/comment-inbound.js');
  registry = await import('../../src/integrations/rocketchat/thread-registry.js');
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
    environment: 'prod',
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

// cm:guard reads the owed comment through a check rather than a non-null assertion: `a!` under `biome check --write` becomes `a?`, which turns "this test is about the one owed comment" into a silent pass over an empty list.
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
const commentRows = async () =>
  db.select().from(schema.comments).where(eq(schema.comments.issueId, issueId));

describe('what a room is owed', () => {
  it('owes a comment written after the watermark, and posts it into a thread it opens', async () => {
    await bindRoom();
    const commentId = await comment('the first word');

    const owed = await mirror.owedComments();
    expect(owed.map((o) => o.commentId)).toEqual([commentId]);

    expect(await mirror.deliverOwedComment(onlyOwed(owed))).toBe('delivered');

    expect(posts).toHaveLength(2);
    expect(posts[0]?.text).toContain(`ISS-${700 + seq}`);
    expect(posts[0]?.text).toContain('Rooms and issues');
    expect(posts[0]?.tmid).toBeUndefined();
    expect(posts[1]?.text).toBe('the first word');
    expect(posts[1]?.tmid).toBe(posts[0] && 'posted-1');

    const [row] = await mirrorRows();
    expect(row?.status).toBe('delivered');
    expect(row?.direction).toBe('outbound');
  });

  it('owes nothing written before the watermark', async () => {
    await bindRoom();
    const commentId = await comment('old news');
    await db
      .update(schema.comments)
      .set({ createdAt: new Date(Date.now() - 3600_000) })
      .where(eq(schema.comments.id, commentId));

    expect(await mirror.owedComments()).toEqual([]);
  });

  it('keeps owing a comment far older than any retry interval', async () => {
    await bindRoom();
    await seedWatermark(new Date(Date.now() - 86_400_000));
    const commentId = await comment('delayed but not lost');
    await db
      .update(schema.comments)
      .set({ createdAt: new Date(Date.now() - 3600_000) })
      .where(eq(schema.comments.id, commentId));

    expect((await mirror.owedComments()).map((o) => o.commentId)).toEqual([commentId]);
  });

  it('owes a comment whose author agency is absent, like any other', async () => {
    await bindRoom();
    const commentId = randomUUID();
    await db.insert(schema.comments).values({
      id: commentId,
      issueId,
      authorId: ownerId,
      authorDeviceId: null,
      body: 'written by the kernel',
      parentId: null,
    });

    expect((await mirror.owedComments()).map((o) => o.commentId)).toEqual([commentId]);
  });

  it('leaves a comment owed when no room is bound, and delivers it once one is', async () => {
    const commentId = await comment('waiting for a room');
    expect(await mirror.deliverOwedComment(onlyOwed(await mirror.owedComments()))).toBe(
      'undeliverable',
    );
    expect(posts).toHaveLength(0);

    await bindRoom();
    const after = await mirror.owedComments();
    expect(after.map((o) => o.commentId)).toEqual([commentId]);
    expect(await mirror.deliverOwedComment(onlyOwed(after))).toBe('delivered');
    expect(posts.filter((p) => p.text === 'waiting for a room')).toHaveLength(1);
  });
});

describe('a comment the screen refuses', () => {
  it('is refused terminally rather than retried until it quietly stops being owed', async () => {
    await bindRoom();
    await comment('@all drop everything');

    expect(await mirror.deliverOwedComment(onlyOwed(await mirror.owedComments()))).toBe('refused');
    expect(posts).toHaveLength(0);

    const [row] = await mirrorRows();
    expect(row?.status).toBe('refused');
    expect(row?.lastError).toContain('addresses the whole room');

    // cm:guard the row must leave the owed set NOW, not after eight more posts: a retryable refusal ends with the comment dropped and nobody told, which is the failure this asserts against (ISS-981).
    expect(await mirror.owedComments()).toEqual([]);
  });

  it('does not open a thread for a comment it refuses', async () => {
    await bindRoom();
    await comment('@here look at this');
    await mirror.drainCommentMirror();
    expect(await threadRows()).toHaveLength(0);
  });
});

describe('one thread per issue', () => {
  it('posts a later comment into the thread the first one opened', async () => {
    await bindRoom();
    await mirror.drainCommentMirror();
    await comment('first');
    await mirror.drainCommentMirror();
    await comment('second');
    await mirror.drainCommentMirror();

    expect(await threadRows()).toHaveLength(1);
    const roots = posts.filter((p) => p.tmid === undefined);
    expect(roots).toHaveLength(1);
    const [thread] = await threadRows();
    expect(posts.filter((p) => p.text === 'second')[0]?.tmid).toBe(thread?.tmid);
  });

  it('leaves one live thread when the root posted but its row never committed', async () => {
    await bindRoom();
    await comment('the one that raced');
    atPostTime = async () => {
      atPostTime = null;
      throw new Error('died after the server took the root');
    };
    const first = await mirror.owedComments();
    expect(await mirror.deliverOwedComment(onlyOwed(first))).toBe('failed');
    expect(await threadRows()).toHaveLength(0);

    await db
      .update(rcSchema.rocketchatCommentMirrors)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) });
    const retry = await mirror.owedComments();
    expect(await mirror.deliverOwedComment(onlyOwed(retry))).toBe('delivered');

    // cm:guard one LIVE row, which the partial unique makes structural rather than incidental.
    expect(await threadRows()).toHaveLength(1);
  });

  it('retires the old thread and opens a new one when the project is rebound', async () => {
    await bindRoom('room-1');
    await comment('before the move');
    await mirror.drainCommentMirror();
    const [firstThread] = await threadRows();
    expect(firstThread?.rid).toBe('room-1');

    await db.delete(schema.integrationBindings);
    await bindRoom('room-2');
    await comment('after the move');
    await mirror.drainCommentMirror();

    const rows = await threadRows();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.retiredAt === null).map((r) => r.rid)).toEqual(['room-2']);
    expect(posts.filter((p) => p.text === 'after the move')[0]).toBeDefined();
  });
});

describe('nothing echoes', () => {
  it('never posts back a comment the mirror itself wrote from the room', async () => {
    const connectionId = await bindRoom();
    const written = await inbound.writeMirroredComment({
      issueId,
      authorId: ownerId,
      connectionId,
      externalMessageId: 'rc-1',
      body: 'typed in the room',
    });
    expect(written.created).toBe(true);

    expect((await mirror.owedComments()).map((o) => o.commentId)).not.toContain(written.commentId);
    await mirror.drainCommentMirror();
    expect(posts.filter((p) => p.text === 'typed in the room')).toHaveLength(0);
  });
});

describe('inbound is exactly once', () => {
  it('writes one comment for a message delivered twice, and resolves the second to the first', async () => {
    const connectionId = await bindRoom();
    const first = await inbound.writeMirroredComment({
      issueId,
      authorId: ownerId,
      connectionId,
      externalMessageId: 'rc-dup',
      body: 'said once',
    });
    const second = await inbound.writeMirroredComment({
      issueId,
      authorId: ownerId,
      connectionId,
      externalMessageId: 'rc-dup',
      body: 'said once',
    });

    expect(second.created).toBe(false);
    expect(second.commentId).toBe(first.commentId);
    expect(await commentRows()).toHaveLength(1);
  });

  it('authors the comment as the mapped user, not the bot', async () => {
    const connectionId = await bindRoom();
    const written = await inbound.writeMirroredComment({
      issueId,
      authorId: ownerId,
      connectionId,
      externalMessageId: 'rc-2',
      body: 'by a person',
    });
    const [row] = await commentRows();
    expect(row?.id).toBe(written.commentId);
    expect(row?.authorId).toBe(ownerId);
    expect(row?.authorAgency).toBe('human');
  });
});

describe('the registry names one subject', () => {
  it('refuses a second subject for one room triple', async () => {
    const connectionId = await bindRoom();
    const other = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${other}, ${projectId}, ${8000 + seq}, 'Another', 'open', ${ownerId})
    `);
    await registry.registerThread({ issueId }, { connectionId, rid: 'room-1', tmid: 'shared' });
    await registry.registerThread(
      { issueId: other },
      { connectionId, rid: 'room-1', tmid: 'shared' },
    );

    const subject = await registry.subjectForThread({
      connectionId,
      rid: 'room-1',
      tmid: 'shared',
    });
    expect(subject).toEqual({ kind: 'issue', issueId, retired: false });
  });

  it('refuses a row naming neither subject', async () => {
    const connectionId = await bindRoom();
    await expect(
      db.execute(sql`
        INSERT INTO rocketchat_question_threads (connection_id, rid, tmid)
        VALUES (${connectionId}, 'room-1', 'no-subject')
      `),
    ).rejects.toThrow();
  });

  it('refuses a row naming both subjects', async () => {
    const connectionId = await bindRoom();
    await expect(
      db.execute(sql`
        INSERT INTO rocketchat_question_threads (connection_id, rid, tmid, issue_id, question_id)
        VALUES (${connectionId}, 'room-1', 'both', ${issueId}, ${randomUUID()})
      `),
    ).rejects.toThrow();
  });

  it('still resolves a retired thread, so a reply there can be refused by name', async () => {
    const connectionId = await bindRoom();
    await registry.registerThread({ issueId }, { connectionId, rid: 'room-1', tmid: 'old' });
    await registry.retireIssueThread(issueId);

    expect(await registry.subjectForThread({ connectionId, rid: 'room-1', tmid: 'old' })).toEqual({
      kind: 'issue',
      issueId,
      retired: true,
    });
    expect(await registry.liveThreadForIssue(issueId)).toBeNull();
  });
});

describe('the claim is written before the post', () => {
  it('marks a comment claimed, never delivered, while its post is in flight', async () => {
    await bindRoom();
    await comment('in flight');
    let seen: { status: string } | undefined;
    atPostTime = async () => {
      [seen] = await mirrorRows();
    };
    await mirror.deliverOwedComment(onlyOwed(await mirror.owedComments()));
    expect(seen?.status).toBe('claimed');
  });

  it('re-posts rather than losing a comment whose delivered mark never landed', async () => {
    await bindRoom();
    await comment('must not vanish');
    postThrows = new Error('the mark never landed');
    expect(await mirror.deliverOwedComment(onlyOwed(await mirror.owedComments()))).toBe('failed');

    postThrows = null;
    await db
      .update(rcSchema.rocketchatCommentMirrors)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) });
    const retry = await mirror.owedComments();
    expect(retry).toHaveLength(1);
    expect(await mirror.deliverOwedComment(onlyOwed(retry))).toBe('delivered');
    expect(posts.filter((p) => p.text === 'must not vanish')).toHaveLength(1);
  });
});
