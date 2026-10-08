/**
 * One user is in a room once, as a person or as a handle. Read at 52dc85659, a person add that met
 * the same user as the room's handle was dropped by `onConflictDoNothing`, so a token held by the
 * project's own agent opened a room (201) it sat in only as the handle, and was then refused that
 * same room 403 as "not one of its people" (ISS-441, seen live on forge-dev). The add that meets the
 * other role is now refused by name, and nothing is written.
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

const { db } = await import('../../src/db/client.js');
const { addHandle, addPerson } = await import('../../src/conversations/participants.js');
const { mintPat } = await import('../../src/credentials/pat.js');
const { isRefusal } = await import('../../src/lib/refusal.js');
const { api, userToken } = await import('../helpers/api.js');
const { createTestProject, createTestUser } = await import('../helpers/factories.js');

let owner = '';
let ownerToken = '';
let projectId = '';
let handleUserId = '';

async function roomCount(): Promise<number> {
  const [row] = (await db.execute(
    sql`SELECT count(DISTINCT conversation_id)::int AS n FROM conversation_participants WHERE project_id = ${projectId}`,
  )) as unknown as { n: number }[];
  return row?.n ?? 0;
}

beforeAll(async () => {
  owner = (await createTestUser({ verified: true })).id;
  ownerToken = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  // the first room a person opens mints the project's agent, which every room then holds as its handle
  const opened = await api(ownerToken, 'POST', '/api/conversations', { projectId, people: [] });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const read = await api(
    ownerToken,
    'GET',
    `/api/conversations/${(opened.body as { id: string }).id}`,
  );
  const participants = (read.body as { participants: { kind: string; userId: string }[] })
    .participants;
  handleUserId = participants.find((p) => p.kind === 'handle')?.userId ?? '';
  expect(handleUserId).not.toBe('');
});

describe('the project agent opening a room with its own token', () => {
  it('is refused by name at create, and no room is left behind', async () => {
    const token = (
      await mintPat({
        permissions: ['*'],
        userId: handleUserId,
        name: 'project agent',
        projectIds: [projectId],
        grantEpoch: 99,
      })
    ).plaintext;
    const before = await roomCount();
    const opened = await api(token, 'POST', '/api/conversations', { projectId, people: [] });
    expect(opened.status, JSON.stringify(opened.body)).toBe(422);
    expect((opened.body as { error: { code: string } }).error.code).toBe('PARTICIPANT_KIND_TAKEN');
    expect(JSON.stringify(opened.body)).toContain('as the handle of its project');
    expect(await roomCount()).toBe(before);
  });

  it('still lets a person open a room and post in it', async () => {
    const opened = await api(ownerToken, 'POST', '/api/conversations', { projectId, people: [] });
    expect(opened.status).toBe(201);
    const read = await api(
      ownerToken,
      'GET',
      `/api/conversations/${(opened.body as { id: string }).id}`,
    );
    expect(read.status).toBe(200);
  });
});

describe('adding a user to a room it is already in', () => {
  async function freshRoom(): Promise<string> {
    const opened = await api(ownerToken, 'POST', '/api/conversations', { projectId, people: [] });
    return (opened.body as { id: string }).id;
  }

  it('as a person, where it is the handle, is refused by name', async () => {
    const room = await freshRoom();
    const refused = await addPerson({
      conversationId: room,
      userId: handleUserId,
      actorUserId: owner,
    }).catch((err: unknown) => err);
    expect(isRefusal(refused, 'PARTICIPANT_KIND_TAKEN'), String(refused)).toBe(true);
  });

  it('as a handle, where it is a person, is refused by name', async () => {
    const room = await freshRoom();
    await db.execute(sql`
      UPDATE conversation_participants SET removed_at = now()
      WHERE conversation_id = ${room} AND user_id = ${handleUserId}
    `);
    await addPerson({ conversationId: room, userId: handleUserId, actorUserId: owner });
    const refused = await addHandle({
      conversationId: room,
      handleUserId,
      projectId,
      actorUserId: owner,
    }).catch((err: unknown) => err);
    expect(isRefusal(refused, 'PARTICIPANT_KIND_TAKEN'), String(refused)).toBe(true);
  });

  it('in the role it already holds, changes nothing and is not refused', async () => {
    const room = await freshRoom();
    await addPerson({ conversationId: room, userId: owner, actorUserId: owner });
    const [row] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM conversation_participants
      WHERE conversation_id = ${room} AND user_id = ${owner} AND removed_at IS NULL
    `)) as unknown as { n: number }[];
    expect(row?.n).toBe(1);
  });
});
