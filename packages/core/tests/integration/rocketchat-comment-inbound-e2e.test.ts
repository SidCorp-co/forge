/**
 * ISS-981 — a room reply becoming a comment, and the registry that decides whose.
 *
 * The outbound half is `rocketchat-comment-mirror-e2e.test.ts`; these are the
 * writes, which are exactly-once, and the registry the two halves share. Every
 * assertion reads the row back rather than trusting a return value: a room
 * message that became two comments, and a comment nobody announced, are both
 * invisible from a function's own result.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
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
let inbound: typeof import('../../src/integrations/rocketchat/comment-inbound.js');
let registry: typeof import('../../src/integrations/rocketchat/thread-registry.js');
let store: typeof import('../../src/integrations/store.js');
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
  inbound = await import('../../src/integrations/rocketchat/comment-inbound.js');
  registry = await import('../../src/integrations/rocketchat/thread-registry.js');
  store = await import('../../src/integrations/store.js');
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

const commentRows = async () =>
  db.select().from(schema.comments).where(eq(schema.comments.issueId, issueId));

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

describe('the announcement is claimed, not receipted', () => {
  it('lets exactly one of two racing redeliveries announce the comment', async () => {
    const connectionId = await bindRoom();
    const written = await inbound.writeMirroredComment({
      issueId,
      authorId: ownerId,
      connectionId,
      externalMessageId: 'rc-race',
      body: 'said once',
    });

    // cm:guard both claims run against the SAME null, which is the race: a receipt written after the emit lets both of them announce, and two `commentCreated` for one sentence is the agent acting twice on its own echo (ISS-981 criteria 10, 11).
    const claim = async () =>
      (
        await db
          .update(rcSchema.rocketchatCommentMirrors)
          .set({ announcedAt: new Date() })
          .where(
            and(
              eq(rcSchema.rocketchatCommentMirrors.commentId, written.commentId),
              isNull(rcSchema.rocketchatCommentMirrors.announcedAt),
            ),
          )
          .returning({ commentId: rcSchema.rocketchatCommentMirrors.commentId })
      ).length;

    const [a, b] = await Promise.all([claim(), claim()]);
    expect((a ?? 0) + (b ?? 0)).toBe(1);
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
    await registry.retireIssueThread(issueId, { connectionId, rid: 'room-1', tmid: 'old' });

    expect(await registry.subjectForThread({ connectionId, rid: 'room-1', tmid: 'old' })).toEqual({
      kind: 'issue',
      issueId,
      retired: true,
    });
    expect(await registry.liveThreadForIssue(issueId)).toBeNull();
  });
});

describe('an announcement is owed until it is made', () => {
  it('leaves the announcement owed when the first delivery never made it', async () => {
    const connectionId = await bindRoom();
    const written = await inbound.writeMirroredComment({
      issueId,
      authorId: ownerId,
      connectionId,
      externalMessageId: 'rc-unannounced',
      body: 'nobody was told',
    });
    expect(written.announcementOwed).toBe(true);

    // cm:guard the redelivery must still owe it: reading `created: false` as proof the bus was told is how a committed comment never reaches the parked session it was written to wake (ISS-981 criterion 12).
    const again = await inbound.writeMirroredComment({
      issueId,
      authorId: ownerId,
      connectionId,
      externalMessageId: 'rc-unannounced',
      body: 'nobody was told',
    });
    expect(again.created).toBe(false);
    expect(again.announcementOwed).toBe(true);
    expect(again.commentId).toBe(written.commentId);
  });

  it('stops owing it once it has been made', async () => {
    const connectionId = await bindRoom();
    const written = await inbound.writeMirroredComment({
      issueId,
      authorId: ownerId,
      connectionId,
      externalMessageId: 'rc-announced',
      body: 'the bus was told',
    });
    await db
      .update(rcSchema.rocketchatCommentMirrors)
      .set({ announcedAt: new Date() })
      .where(eq(rcSchema.rocketchatCommentMirrors.commentId, written.commentId));

    const again = await inbound.writeMirroredComment({
      issueId,
      authorId: ownerId,
      connectionId,
      externalMessageId: 'rc-announced',
      body: 'the bus was told',
    });
    expect(again.announcementOwed).toBe(false);
  });
});

describe('an unannounced comment is announced by the drain', () => {
  function recordingBus() {
    const seen: Array<{ commentId: string; actor: string }> = [];
    return {
      seen,
      bus: {
        emit: async (topic: string, p: { commentId: string; actor: { type: string } }) => {
          if (topic === 'commentCreated')
            seen.push({ commentId: p.commentId, actor: p.actor.type });
        },
      } as unknown as import('../../src/pipeline/hooks.js').HooksBus,
    };
  }

  async function unannounced(externalMessageId: string): Promise<string> {
    const connectionId = await bindRoom();
    const written = await inbound.writeMirroredComment({
      issueId,
      authorId: ownerId,
      connectionId,
      externalMessageId,
      body: 'nobody was told',
    });
    return written.commentId;
  }

  it('announces a comment whose announcer died before emitting', async () => {
    const commentId = await unannounced('rc-drain');
    const { seen, bus } = recordingBus();

    expect(await inbound.drainOwedAnnouncements(bus)).toBe(1);
    // cm:guard the actor must be `user` or `answer-resume.ts` returns early and the parked session is never woken — the whole point of announcing this at all (ISS-981 criteria 5, 12).
    expect(seen).toEqual([{ commentId, actor: 'user' }]);

    const [row] = await db
      .select()
      .from(rcSchema.rocketchatCommentMirrors)
      .where(eq(rcSchema.rocketchatCommentMirrors.commentId, commentId));
    expect(row?.announcedAt).not.toBeNull();
  });

  it('leaves an announced comment alone', async () => {
    const commentId = await unannounced('rc-done');
    await db
      .update(rcSchema.rocketchatCommentMirrors)
      .set({ announcedAt: new Date() })
      .where(eq(rcSchema.rocketchatCommentMirrors.commentId, commentId));

    const { seen, bus } = recordingBus();
    expect(await inbound.drainOwedAnnouncements(bus)).toBe(0);
    expect(seen).toEqual([]);
  });

  it('waits out a live lease and takes over an expired one', async () => {
    const commentId = await unannounced('rc-leased');
    await db
      .update(rcSchema.rocketchatCommentMirrors)
      .set({ announceLeaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(rcSchema.rocketchatCommentMirrors.commentId, commentId));

    const live = recordingBus();
    expect(await inbound.drainOwedAnnouncements(live.bus)).toBe(0);
    expect(live.seen).toEqual([]);

    await db
      .update(rcSchema.rocketchatCommentMirrors)
      .set({ announceLeaseUntil: new Date(Date.now() - 1_000) })
      .where(eq(rcSchema.rocketchatCommentMirrors.commentId, commentId));

    // cm:guard the lease EXPIRING is what makes the emit at-least-once: without it an announcer that died holding the claim leaves the comment unannounced for ever, and the reply the parked session was waiting for is never heard (ISS-981 criterion 12).
    const after = recordingBus();
    expect(await inbound.drainOwedAnnouncements(after.bus)).toBe(1);
    expect(after.seen.map((e) => e.commentId)).toEqual([commentId]);
  });
});
