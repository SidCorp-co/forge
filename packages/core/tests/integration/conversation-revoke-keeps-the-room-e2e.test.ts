/**
 * ISS-1003 — what revoking an agent's authority may NOT do.
 *
 * Its own file, and not another describe in `conversation-scope-e2e`, because
 * it is a different claim: that one is about what a room's scope IS, this one
 * is about what must survive an act that changes nothing in the room. The two
 * were read off one record and that is exactly what went wrong — a revoke
 * removed the agent's authority and, as a side effect nobody asked for, emptied
 * the scope of every room where that agent was the only handle. An empty scope
 * is refused to every reader and a room's last handle may not be removed, so
 * the room became unreadable by everyone, including whoever revoked.
 *
 * Real Postgres, because the whole claim is about a DELETE on one table not
 * reaching a column on another.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
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

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  scope = await import('../../src/conversations/scope.js');
  participants = await import('../../src/conversations/participants.js');
  store = await import('../../src/conversations/store.js');
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectA = (
    await createTestProject(harness.db, ownerId, { slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
  projectB = (
    await createTestProject(harness.db, ownerId, { slug: `beta-${randomUUID().slice(0, 8)}` })
  ).id;
});

/** A room the adapter opened, with the project's handle already in it. */
async function openRoom(projectId: string) {
  return store.openConversation({
    adapter: 'rocketchat',
    externalId: `chat.example.co ${randomUUID()}`,
    shape: 'group',
    projectId,
  });
}

describe('removing an agent’s authority', () => {
  // cm:guard this asserted the OPPOSITE until ISS-1003 — that a revoke narrowed the scope to nothing — and the flip is the defect being fixed rather than a relaxed expectation. Scope was read off `project_members`, the row a revoke deletes, so revoking an agent emptied the scope of every room where it was the only handle; an empty scope is refused to every reader and the last handle may not be removed, so the room became unreadable by everyone and repairable by nobody. Removing authority is a security action that must always succeed, and it may not also close a room. Point `derivedScope` back at `project_members` and this case goes red.
  it('keeps its scope when a handle loses its project role, and reports the handle unreachable', async () => {
    const room = await openRoom(projectA);
    const [handle] = await participants.listParticipants(room.id);
    expect(await scope.derivedScope(room.id)).toEqual([projectA]);
    expect(handle?.projectId).toBe(projectA);

    await harness.db.execute(
      sql`DELETE FROM project_members WHERE user_id = ${handle?.userId} AND project_id = ${projectA}`,
    );

    expect(await scope.derivedScope(room.id)).toEqual([projectA]);
    await expect(scope.assertConversationReadable(room.id, ownerId)).resolves.toEqual([projectA]);
    const [after] = await participants.listParticipants(room.id);
    expect(after?.reachable).toBe(false);
  });

  // cm:guard the OTHER half of what a revoke must not do: an agent given a second project membership after it joined a room must not widen that room, because the row records the project the handle was added FOR and not the set the agent happens to hold. Derive the scope from memberships again and this goes red with projectB in the set (ISS-1003 criterion 21).
  it('does not widen when the handle is later given a second project membership', async () => {
    const room = await openRoom(projectA);
    const [handle] = await participants.listParticipants(room.id);
    await createTestProjectMember(harness.db, {
      projectId: projectB,
      userId: handle?.userId as string,
      role: 'member',
    });
    expect(await scope.derivedScope(room.id)).toEqual([projectA]);
  });
});

describe('the opening door checks the one thing it can', () => {
  // cm:guard `attachOpeningHandle` authorizes nobody by design — a message arriving opens the room and there is no caller to hold a role. That is not a licence to write ANY project into the participant: `project_id` is what `derivedScope` reads, so a handle recorded against a project it is no member of gives the room a scope its only handle can never act within, and no later reader compares the two. Found by review, F1. Drop the membership check and this goes green while writing that room.
  it('refuses to record a handle against a project it is not a member of', async () => {
    const roomA = await openRoom(projectA);
    const [handle] = await participants.listParticipants(roomA.id);
    const roomB = await openRoom(projectB);

    await expect(
      participants.attachOpeningHandle(
        harness.db as never,
        roomB.id,
        handle?.userId as string,
        projectB,
      ),
    ).rejects.toThrow(/not of/);

    const rows = await participants.listParticipants(roomB.id);
    expect(rows.some((r) => r.userId === handle?.userId)).toBe(false);
  });
});
