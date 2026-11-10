import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createChatSessionRow } from '../../src/agent-sessions/chat-turn.js';
import { mintPat } from '../../src/credentials/pat.js';
import { turnTokenNameFor } from '../../src/credentials/pat-format.js';
import { runWithPatScope } from '../../src/credentials/pat-scope.js';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { DIRECT_TURN_KEY, directAskerOf } from '../../src/support/direct-asker.js';
import { openSessionTurn } from '../../src/support/session-turns.js';
import type { RoomRow } from '../../src/support/store.js';
import { turnOfRequest } from '../../src/support/turn-of-act.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

// @direct-test-of packages/core/src/support/session-turns.ts
// @direct-test-of packages/core/src/db/schema-support-turns.ts
// @direct-test-of packages/core/src/support/turn-of-act.ts
// @direct-test-of packages/core/src/support/direct-asker.ts
//
// ISS-1202: a room's session holds one token across its turns, so a turn is no longer its token.
// What bounded a turn by its token is bounded by the turn's own row: a direct message's sender is
// acted as only in the turn it was handed in, never in a later turn on the same token, nor between
// turns. A person's chat turn token (ISS-17) is still revoked when its turn stops.

let owner = '';
let projectId = '';
let deviceId = '';

beforeAll(async () => {
  owner = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  await addProjectMember(projectId, owner, 'owner');
  deviceId = await createTestDevice(owner);
}, 120_000);

const setStatus = (sessionId: string, status: string) =>
  withKernelMarker(db, (tx) =>
    tx.execute(sql`UPDATE agent_sessions SET status = ${status} WHERE id = ${sessionId}::uuid`),
  );

const liveTokens = (sessionId: string) =>
  rows<{ id: string }>(sql`
    SELECT id FROM personal_access_tokens
     WHERE name = ${turnTokenNameFor(sessionId)} AND revoked_at IS NULL`);

describe("ISS-1202: a turn of a room's session is its own row, not its token", () => {
  it('acts as the sender of a direct message only in the turn it was handed in', async () => {
    const session = await createChatSessionRow({ projectId, userId: owner, title: 'room' });
    const token = await mintPat({
      userId: owner,
      name: turnTokenNameFor(session.id),
      permissions: ['projects:write'],
      projectIds: [projectId],
      scopes: ['read', 'write'],
    });
    const room = { sessionId: session.id } as RoomRow;
    const message = '11111111-2222-4333-8444-555555555555';
    const asSession = <T>(fn: () => Promise<T>) =>
      runWithPatScope({ projectIds: [projectId], tokenId: token.row.id }, fn);

    const first = await openSessionTurn(session.id);
    await db.execute(sql`
      UPDATE agent_sessions
         SET metadata = jsonb_build_object(${DIRECT_TURN_KEY}::text,
               jsonb_build_object('id', ${message}::text, 'userId', ${owner}::text,
                                  'label', 'Owner', 'turnId', ${first}::text))
       WHERE id = ${session.id}::uuid`);
    expect(await asSession(() => turnOfRequest())).toEqual({
      sessionId: session.id,
      turnId: first,
    });
    const inTurn = await asSession(() => directAskerOf(room, message));
    expect(inTurn.ok, JSON.stringify(inTurn)).toBe(true);

    // the next turn runs on the same token: it names no direct message an earlier turn was handed
    const second = await openSessionTurn(session.id);
    expect(second).not.toBe(first);
    const later = await asSession(() => directAskerOf(room, message));
    expect(later.ok).toBe(false);
    expect(JSON.stringify(later)).toContain('OPS_ASKER_MESSAGE_UNKNOWN');

    // between turns the session's token names the session and no turn, and no direct message
    await setStatus(session.id, 'running');
    await setStatus(session.id, 'completed');
    const spans = await rows<{ id: string; ended: boolean }>(sql`
      SELECT id, ended_at IS NOT NULL AS ended FROM support_session_turns
       WHERE session_id = ${session.id}::uuid ORDER BY started_at`);
    expect(spans).toEqual([
      { id: first, ended: true },
      { id: second, ended: true },
    ]);
    expect(await asSession(() => turnOfRequest())).toEqual({
      sessionId: session.id,
      turnId: null,
    });
    const between = await asSession(() => directAskerOf(room, message));
    expect(between.ok).toBe(false);
  });

  it("revokes a person's chat turn token when its turn stops (ISS-17)", async () => {
    const session = await createChatSessionRow({ projectId, userId: owner, title: 'person' });
    // minted as `mintSessionCredential` names it: the person's turn token of this session
    await mintPat({
      userId: owner,
      name: turnTokenNameFor(session.id),
      permissions: ['projects:read'],
      projectIds: [projectId],
      scopes: ['read'],
      deviceId,
    });
    await setStatus(session.id, 'running');
    expect(await liveTokens(session.id)).toHaveLength(1);
    await setStatus(session.id, 'completed');
    expect(await liveTokens(session.id)).toHaveLength(0);
  });
});
