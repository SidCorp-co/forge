/**
 * ISS-1001 — a conversation's scope is the projects of the agents in it, read
 * at the moment of the read.
 *
 * Every claim here is about a join against a real Postgres, so nothing is
 * mocked: a revocation is an actual DELETE on `project_members` between two
 * calls, and the only evidence that a revoked reader is shut out is the second
 * call refusing. A mocked membership would prove the mock.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

// cm:guard ONE harness for the whole file: `db/client.ts` binds to DATABASE_URL at import time, so a second setupTestDatabase() puts the fixtures on one database and the code under test on another.
let harness: TestDatabase;
let scope: typeof import('../../src/conversations/scope.js');
let participants: typeof import('../../src/conversations/participants.js');
let store: typeof import('../../src/conversations/store.js');
let handles: typeof import('../../src/conversations/handles.js');
let turns: typeof import('../../src/assistant/conversation-turn.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  scope = await import('../../src/conversations/scope.js');
  participants = await import('../../src/conversations/participants.js');
  store = await import('../../src/conversations/store.js');
  handles = await import('../../src/conversations/handles.js');
  turns = await import('../../src/assistant/conversation-turn.js');
}, 120_000);

/** Independent pools, so a writer here is a writer Postgres sees as a stranger. */
const clients: Sql[] = [];
function independent(): ReturnType<typeof drizzle> {
  const client = postgres(harness.url, { max: 2, onnotice: () => {} });
  clients.push(client);
  return drizzle(client, {});
}

afterAll(async () => {
  for (const c of clients) await c.end({ timeout: 5 }).catch(() => {});
  if (harness) await harness.cleanup();
});

let ownerId: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectA = (
    await createTestProject(harness.db, ownerId, { slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
  projectB = (
    await createTestProject(harness.db, ownerId, { slug: `beta-${randomUUID().slice(0, 8)}` })
  ).id;
});

/** A room the adapter opened, with the project's handle already in it. */
async function openRoom(projectId: string, externalId = `chat.example.co ${randomUUID()}`) {
  return store.openConversation({
    adapter: 'rocketchat',
    externalId,
    shape: 'group',
    projectId,
  });
}

describe('a conversation takes its scope from the agents in it', () => {
  it('is about the project of the handle that opened it, and nothing else', async () => {
    const room = await openRoom(projectA);
    expect(await scope.derivedScope(room.id)).toEqual([projectA]);
  });

  it('widens when a second project handle joins', async () => {
    const room = await openRoom(projectA);
    const second = await harness.db.transaction(async (tx) =>
      handles.resolveProjectHandle(tx as never, projectB),
    );
    await participants.addHandle({
      conversationId: room.id,
      handleUserId: second.userId,
      projectId: projectB,
      actorUserId: ownerId,
    });
    expect(await scope.derivedScope(room.id)).toEqual([projectA, projectB].sort());
  });
});

describe('who may read a conversation', () => {
  it('admits a reader holding a role on every project in the room', async () => {
    const room = await openRoom(projectA);
    await expect(scope.assertConversationReadable(room.id, ownerId)).resolves.toEqual([projectA]);
  });

  it('refuses a reader holding a role on none of them, naming the project', async () => {
    const room = await openRoom(projectA);
    const stranger = await createTestUser(harness.db);
    await expect(scope.assertConversationReadable(room.id, stranger.id)).rejects.toMatchObject({
      status: 403,
      cause: { code: 'CONVERSATION_OUT_OF_SCOPE' },
    });
  });

  // cm:guard this is the empty-scope hole held open as a test: the check is "a role on every project in the set", and an `every` over nothing is TRUE — so a room with no handle must be refused by name.
  // cm:guard the room is emptied by STAMPING the handle gone, not by deleting its membership. Since ISS-1003 a revoke no longer empties a scope — that was the defect — so a test that reached the empty set through `project_members` would now be measuring nothing while still passing its assertion about a room it never emptied.
  it('refuses a room that is about no project rather than granting it to everyone', async () => {
    const room = await openRoom(projectA);
    const [handle] = await participants.listParticipants(room.id);
    await harness.db.execute(
      sql`UPDATE conversation_participants SET removed_at = now() WHERE id = ${handle?.id}`,
    );
    const stranger = await createTestUser(harness.db);
    for (const reader of [ownerId, stranger.id]) {
      await expect(scope.assertConversationReadable(room.id, reader)).rejects.toMatchObject({
        status: 403,
        cause: { code: 'CONVERSATION_NO_SCOPE' },
      });
    }
    // cm:why a caller naming NO user is refused one step earlier and by its own code — it forgot, rather than being a person without a role; both are 403 and neither reads the room
    await expect(scope.assertConversationReadable(room.id, null)).rejects.toMatchObject({
      status: 403,
      cause: { code: 'CONVERSATION_NO_AUTHORITY' },
    });
  });

  it('refuses a reader who holds a role on only one of two projects in the room', async () => {
    const room = await openRoom(projectA);
    const second = await harness.db.transaction(async (tx) =>
      handles.resolveProjectHandle(tx as never, projectB),
    );
    await participants.addHandle({
      conversationId: room.id,
      handleUserId: second.userId,
      projectId: projectB,
      actorUserId: ownerId,
    });
    const partial = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, {
      projectId: projectA,
      userId: partial.id,
      role: 'member',
    });
    await expect(scope.assertConversationReadable(room.id, partial.id)).rejects.toMatchObject({
      cause: { code: 'CONVERSATION_OUT_OF_SCOPE' },
    });
  });

  it('lets a revocation between two reads change the answer', async () => {
    const room = await openRoom(projectA);
    const reader = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, {
      projectId: projectA,
      userId: reader.id,
      role: 'member',
    });
    await expect(scope.assertConversationReadable(room.id, reader.id)).resolves.toEqual([projectA]);

    await harness.db.execute(
      sql`DELETE FROM project_members WHERE user_id = ${reader.id} AND project_id = ${projectA}`,
    );

    await expect(scope.assertConversationReadable(room.id, reader.id)).rejects.toMatchObject({
      cause: { code: 'CONVERSATION_OUT_OF_SCOPE' },
    });
  });
});

describe('the door a handle comes through', () => {
  it('refuses a handle whose project the adder holds no role on, naming that project', async () => {
    const room = await openRoom(projectA);
    const second = await harness.db.transaction(async (tx) =>
      handles.resolveProjectHandle(tx as never, projectB),
    );
    const outsider = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, {
      projectId: projectA,
      userId: outsider.id,
      role: 'member',
    });
    const refusal = (await participants
      .addHandle({
        conversationId: room.id,
        handleUserId: second.userId,
        projectId: projectB,
        actorUserId: outsider.id,
      })
      .then(() => null)
      .catch((e: unknown) => e)) as { message: string; cause: { code: string } } | null;
    expect(refusal?.cause.code).toBe('HANDLE_PROJECT_FORBIDDEN');
    expect(refusal?.message).toContain(projectB);
    expect(await scope.derivedScope(room.id)).toEqual([projectA]);
  });

  it('refuses a person as a handle', async () => {
    const room = await openRoom(projectA);
    await expect(
      participants.addHandle({
        conversationId: room.id,
        handleUserId: ownerId,
        projectId: projectA,
        actorUserId: ownerId,
      }),
    ).rejects.toMatchObject({ cause: { code: 'HANDLE_NOT_AN_AGENT' } });
  });

  it('refuses a person identified by neither a user nor a key', async () => {
    const room = await openRoom(projectA);
    await expect(
      participants.addPerson({ conversationId: room.id, userId: null, externalKey: null }),
    ).rejects.toMatchObject({ cause: { code: 'PARTICIPANT_UNIDENTIFIED' } });
  });

  it('refuses the removal of the last handle, because the room would become unreadable', async () => {
    const room = await openRoom(projectA);
    const [handle] = await participants.listParticipants(room.id);
    await expect(
      participants.removeParticipant({
        conversationId: room.id,
        participantId: handle?.id ?? '',
      }),
    ).rejects.toMatchObject({ cause: { code: 'CONVERSATION_LAST_HANDLE' } });
    expect(await scope.derivedScope(room.id)).toEqual([projectA]);
  });

  // cm:guard two callers removing a DIFFERENT handle each count two live and each pass `live <= 1`, so an unserialized check commits both and leaves the unreadable room it exists to prevent.
  // cm:why a third connection holds the row until BOTH are waiting: two removals started from JavaScript alone interleave as the event loop pleases and can pass without ever racing.
  it('refuses one of two concurrent removals that would empty the room between them', async () => {
    const room = await openRoom(projectA);
    const second = await harness.db.transaction(async (tx) =>
      handles.resolveProjectHandle(tx as never, projectB),
    );
    await participants.addHandle({
      conversationId: room.id,
      handleUserId: second.userId,
      projectId: projectB,
      actorUserId: ownerId,
    });
    const live = (await participants.listParticipants(room.id)).filter((p) => p.kind === 'handle');
    expect(live).toHaveLength(2);

    const gate = postgres(harness.url, { max: 1, onnotice: () => {} });
    clients.push(gate);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = gate.begin(async (tx) => {
      await tx.unsafe(`SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, [room.id]);
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));

    const a = independent();
    const b = independent();
    const outcomes = Promise.allSettled([
      participants.removeParticipant({
        conversationId: room.id,
        participantId: live[0]?.id ?? '',
        db: a as never,
      }),
      participants.removeParticipant({
        conversationId: room.id,
        participantId: live[1]?.id ?? '',
        db: b as never,
      }),
    ]);
    await new Promise((r) => setTimeout(r, 250));
    release();
    await holding;

    const settled = await outcomes;
    expect(settled.filter((o) => o.status === 'rejected')).toHaveLength(1);
    expect(await scope.derivedScope(room.id)).toHaveLength(1);
  });

  it('allows a handle to leave once a second one is in the room', async () => {
    const room = await openRoom(projectA);
    const [first] = await participants.listParticipants(room.id);
    const second = await harness.db.transaction(async (tx) =>
      handles.resolveProjectHandle(tx as never, projectB),
    );
    await participants.addHandle({
      conversationId: room.id,
      handleUserId: second.userId,
      projectId: projectB,
      actorUserId: ownerId,
    });
    await participants.removeParticipant({
      conversationId: room.id,
      participantId: first?.id ?? '',
    });
    expect(await scope.derivedScope(room.id)).toEqual([projectB]);
  });
});

describe("a project's handle", () => {
  it('is minted once with its two memberships and no access token', async () => {
    const handle = await harness.db.transaction(async (tx) =>
      handles.resolveProjectHandle(tx as never, projectA),
    );
    expect(handle.minted).toBe(true);

    const rows = await harness.db.execute(sql`
      SELECT u.kind, u.password_hash,
        (SELECT count(*)::int FROM organization_members om WHERE om.user_id = u.id) AS orgs,
        (SELECT count(*)::int FROM project_members pm WHERE pm.user_id = u.id) AS projects,
        (SELECT count(*)::int FROM personal_access_tokens t WHERE t.user_id = u.id) AS tokens
      FROM users u WHERE u.id = ${handle.userId}`);
    expect(rows[0]).toMatchObject({
      kind: 'agent',
      password_hash: null,
      orgs: 1,
      projects: 1,
      tokens: 0,
    });
  });

  it('is reused on the next call rather than minted again', async () => {
    const first = await harness.db.transaction(async (tx) =>
      handles.resolveProjectHandle(tx as never, projectA),
    );
    const second = await harness.db.transaction(async (tx) =>
      handles.resolveProjectHandle(tx as never, projectA),
    );
    expect(second).toMatchObject({ userId: first.userId, minted: false });
  });

  it('refuses a project that does not exist rather than minting for it', async () => {
    await expect(
      harness.db.transaction(async (tx) => handles.resolveProjectHandle(tx as never, randomUUID())),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('a turn continuing a conversation by id', () => {
  it('continues one its own project is in', async () => {
    const room = await openRoom(projectA);
    const turn = await turns.openTurn({
      projectId: projectA,
      adapter: 'rocketchat',
      conversationId: room.id,
      readerUserId: ownerId,
    });
    expect(turn.conversationId).toBe(room.id);
  });

  // cm:guard being allowed to READ a room is not the same as a turn belonging to it: naming project B and conversation A passes the read check on A while the toolset is built for B.
  it('refuses a turn arriving under a project the conversation is not about', async () => {
    const room = await openRoom(projectA);
    await expect(
      turns.openTurn({
        projectId: projectB,
        adapter: 'rocketchat',
        conversationId: room.id,
        readerUserId: ownerId,
      }),
    ).rejects.toMatchObject({ cause: { code: 'CONVERSATION_PROJECT_CONFLICT' } });
  });

  it('refuses a turn arriving as a different adapter than the room was opened with', async () => {
    const room = await openRoom(projectA);
    await expect(
      turns.openTurn({
        projectId: projectA,
        adapter: 'web',
        conversationId: room.id,
        readerUserId: ownerId,
      }),
    ).rejects.toMatchObject({ cause: { code: 'CONVERSATION_ADAPTER_CONFLICT' } });
  });

  // cm:guard a turn naming NO authority is refused as that and never as an anonymous caller: one omitted argument in an adapter's runtime silenced every room while the unit suites stayed green
  it('refuses a turn that names no authority at all, by name', async () => {
    const room = await openRoom(projectA);
    await expect(
      turns.openTurn({
        projectId: projectA,
        adapter: 'rocketchat',
        conversationId: room.id,
        readerUserId: null,
      }),
    ).rejects.toMatchObject({ cause: { code: 'CONVERSATION_NO_AUTHORITY' } });
  });

  // cm:guard a persisted turn APPENDS to the room, so it takes `member` and not `viewer` — the threshold the same room's rename and delete already take
  it('refuses a viewer continuing a conversation, and admits a member', async () => {
    const room = await openRoom(projectA);
    const viewer = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, {
      userId: viewer.id,
      projectId: projectA,
      role: 'viewer',
    });

    await expect(
      turns.openTurn({
        projectId: projectA,
        adapter: 'rocketchat',
        conversationId: room.id,
        readerUserId: viewer.id,
      }),
    ).rejects.toMatchObject({ cause: { code: 'CONVERSATION_OUT_OF_SCOPE' } });

    await harness.db.execute(
      sql`UPDATE project_members SET role = 'member' WHERE user_id = ${viewer.id}`,
    );
    const turn = await turns.openTurn({
      projectId: projectA,
      adapter: 'rocketchat',
      conversationId: room.id,
      readerUserId: viewer.id,
    });
    expect(turn.conversationId).toBe(room.id);
  });

  // cm:guard the assistant row is BY the room's handle: the account that spoke is known here, and a transcript whose assistant rows are all by nobody cannot say which handle answered
  it('names the room handle as the author of what the assistant said', async () => {
    const room = await openRoom(projectA);
    const turn = await turns.openTurn({
      projectId: projectA,
      adapter: 'rocketchat',
      conversationId: room.id,
      readerUserId: ownerId,
    });
    const [handle] = await participants.listParticipants(room.id);
    expect(turn.handleUserId).toBe(handle?.userId);

    turns.appendUserMessage(turn, 'asked');
    turns.appendAssistantMessage(turn, 'answered');
    const written = await turns.persistMessages(turn);
    expect(written.map((m) => m.authorUserId)).toEqual([null, handle?.userId]);
  });

  // cm:guard a turn is its question AND its answer or neither: committing the user row and failing on the assistant one leaves a transcript ending on a person waiting (ISS-1001 invariant 7)
  it('commits a turn whole or not at all', async () => {
    const room = await openRoom(projectA);
    const turn = await turns.openTurn({
      projectId: projectA,
      adapter: 'rocketchat',
      conversationId: room.id,
      readerUserId: ownerId,
    });
    turns.appendUserMessage(turn, 'asked');
    // cm:why the CHECK constraint refuses this role, and only the SECOND message carries it
    turn.pending.push({
      role: 'nonsense' as never,
      content: 'answered',
      authorUserId: null,
      authorLabel: null,
      images: [],
      blocks: null,
      deliveryProof: null,
      silenceReason: null,
    });

    await expect(turns.persistMessages(turn)).rejects.toThrow();

    expect(await store.countMessages(room.id)).toBe(0);
    // cm:guard still retryable: the queue is cleared by the commit and not by the attempt
    expect(turn.pending).toHaveLength(2);
  });

  it('refuses a turn that names neither a conversation nor a venue', async () => {
    await expect(
      turns.openTurn({ projectId: projectA, adapter: 'web', readerUserId: ownerId }),
    ).rejects.toMatchObject({ cause: { code: 'CONVERSATION_UNADDRESSED' } });
  });
});
