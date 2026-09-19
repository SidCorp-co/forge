/**
 * ISS-1001 — the OTHER door into a turn: the venue.
 *
 * `conversation-scope-e2e.test.ts` walks the conversation-id door and is at its
 * file budget; this is the same subject through the door an adapter uses, where
 * the room is named by its transport id and the authority is whatever the caller
 * says it is. The refusals below are the ones that door did not make.
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

let harness: TestDatabase;
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
  participants = await import('../../src/conversations/participants.js');
  store = await import('../../src/conversations/store.js');
  handles = await import('../../src/conversations/handles.js');
  turns = await import('../../src/assistant/conversation-turn.js');
}, 120_000);

afterAll(async () => {
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

describe('a turn opening or resuming a venue', () => {
  it('refuses a named user who holds no member role on the project it names', async () => {
    const stranger = await createTestUser(harness.db);
    const externalId = `chat.example.co ${randomUUID()}`;
    await expect(
      turns.openTurn({
        projectId: projectA,
        adapter: 'rocketchat',
        externalId,
        shape: 'group',
        readerUserId: stranger.id,
      }),
    ).rejects.toMatchObject({ cause: { code: 'CONVERSATION_OUT_OF_SCOPE' } });
    expect(await store.findConversation('rocketchat', externalId)).toBeNull();
  });

  it('refuses a viewer on the project, and admits the same user once a member', async () => {
    const viewer = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, {
      userId: viewer.id,
      projectId: projectA,
      role: 'viewer',
    });
    const externalId = `chat.example.co ${randomUUID()}`;
    await expect(
      turns.openTurn({
        projectId: projectA,
        adapter: 'rocketchat',
        externalId,
        shape: 'group',
        readerUserId: viewer.id,
      }),
    ).rejects.toMatchObject({ cause: { code: 'CONVERSATION_OUT_OF_SCOPE' } });

    await harness.db.execute(
      sql`UPDATE project_members SET role = 'member' WHERE user_id = ${viewer.id} AND project_id = ${projectA}`,
    );
    const turn = await turns.openTurn({
      projectId: projectA,
      adapter: 'rocketchat',
      externalId,
      shape: 'group',
      readerUserId: viewer.id,
    });
    expect(turn.conversationId).toBeTruthy();
  });

  it('refuses a member of the naming project who is a stranger to the room second project', async () => {
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
    const memberOfAOnly = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, {
      userId: memberOfAOnly.id,
      projectId: projectA,
      role: 'member',
    });
    await expect(
      turns.openTurn({
        projectId: projectA,
        adapter: 'rocketchat',
        externalId: room.externalId,
        shape: 'group',
        readerUserId: memberOfAOnly.id,
      }),
    ).rejects.toMatchObject({ cause: { code: 'CONVERSATION_OUT_OF_SCOPE' } });
  });

  it('refuses a turn that names no authority at all, by name, and opens no room', async () => {
    const externalId = `chat.example.co ${randomUUID()}`;
    await expect(
      turns.openTurn({
        projectId: projectA,
        adapter: 'rocketchat',
        externalId,
        shape: 'group',
        readerUserId: null,
      }),
    ).rejects.toMatchObject({ cause: { code: 'CONVERSATION_NO_AUTHORITY' } });
    expect(await store.findConversation('rocketchat', externalId)).toBeNull();
  });
});
