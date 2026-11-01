// @direct-test-of packages/core/src/support/turns.ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { SupportWorld } from '../helpers/support-world.js';

// REQ-15 BC-10 (ISS-856): GET /api/projects/:id/support/turns says, for each support room of the
// project, whether its session answers now, whether a member's message waits, and when the room
// last moved; and a member's message tells the project room `project.now.changed`, so the bar on
// the project's pages reads it again without polling. The world is support-room-e2e's.

const w = new SupportWorld();
let roomId = '';
let sessionId = '';
let publish: MockInstance;

const turns = async (token = w.owner, id = w.projectId) =>
  api(token, 'GET', `/api/projects/${id}/support/turns`);

const roomTurn = async () => {
  const got = await turns();
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  const rooms = got.body.rooms as Record<string, unknown>[];
  return rooms.find((r) => r.roomId === roomId);
};

beforeAll(async () => {
  await w.start();
  await w.bind();
  const [room] = await w.rooms();
  roomId = String(room?.id);
  sessionId = String(room?.sessionId);
  const { roomManager } = await import('../../src/lib/rooms.js');
  publish = vi.spyOn(roomManager, 'publish');
}, 120_000);

afterAll(() => w.stop());

describe('GET /api/projects/:id/support/turns (REQ-15 BC-10)', () => {
  it('reads a warm room with nothing waiting as quiet, with its last act', async () => {
    await w.untilWarm();
    const turn = await roomTurn();
    expect(turn).toMatchObject({
      roomId,
      rid: w.chat.rid,
      kind: 'support',
      state: 'quiet',
      waiting: 0,
      waitingSince: null,
    });
    expect(turn?.lastActivityAt === null || typeof turn?.lastActivityAt === 'string').toBe(true);
  });

  it('reads the room answering while its turn runs, and tells the project room a message came', async () => {
    publish.mockClear();
    w.box.finishTurns = false;
    const before = Date.now();
    await w.chat.say(w.chat.alice, 'Is the CSV export broken?');
    await expect.poll(async () => (await roomTurn())?.state, { timeout: 15_000 }).toBe('answering');
    const turn = await roomTurn();
    expect(Date.parse(String(turn?.lastActivityAt))).toBeGreaterThanOrEqual(before - 1000);
    await settleOutbox();
    const told = publish.mock.calls.filter(
      ([room, msg]) =>
        room === `project:${w.projectId}` &&
        (msg as { event: string }).event === 'project.now.changed',
    );
    expect(told.map(([, msg]) => (msg as { data: unknown }).data)).toContainEqual({
      projectId: w.projectId,
      source: 'rooms',
    });
  }, 60_000);

  it('reads a message no turn took as waiting, with its count and since, when no session answers', async () => {
    // the room's session is detached, as a binding whose session was never placed leaves it, and
    // two members' messages stand that no turn claimed
    await db.execute(sql`UPDATE support_rooms SET session_id = NULL WHERE id = ${roomId}::uuid`);
    await db.execute(sql`
      INSERT INTO support_actions (room_id, project_id, thread, kind, actor_kind, actor_key, input, external_id, created_at)
      VALUES (${roomId}::uuid, ${w.projectId}::uuid, 'planted-thread', 'message_in', 'member', 'u-alice',
              '{"text":"still there?"}'::jsonb, 'planted-1', now() - interval '2 minutes'),
             (${roomId}::uuid, ${w.projectId}::uuid, 'planted-thread', 'message_in', 'member', 'u-alice',
              '{"text":"hello?"}'::jsonb, 'planted-2', now() + interval '1 second')`);
    const turn = await roomTurn();
    expect(turn).toMatchObject({ state: 'waiting', waiting: 2 });
    const since = Date.parse(String(turn?.waitingSince));
    expect(Date.now() - since).toBeGreaterThanOrEqual(110_000);
    expect(Date.parse(String(turn?.lastActivityAt))).toBeGreaterThan(since);
  });

  it('reads a project with no support room as no rooms, never a failure', async () => {
    const { createTestProject, addProjectMember } = await import('../helpers/factories.js');
    const bare = (await createTestProject(w.ownerId)).id;
    await addProjectMember(bare, w.ownerId, 'owner');
    const got = await turns(w.owner, bare);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ projectId: bare, rooms: [] });
  });

  it('refuses a person who cannot read the project, and a project id that is no uuid', async () => {
    const stranger = await turns(w.stranger);
    expect([403, 404]).toContain(stranger.status);
    expect(JSON.stringify(stranger.body)).not.toContain(roomId);
    // a project id that is no uuid is read as a slug, and none is held by it
    const bad = await api(w.owner, 'GET', '/api/projects/not-a-uuid/support/turns');
    expect(bad.status).toBe(404);
    const query = await api(w.owner, 'GET', `/api/projects/${w.projectId}/support/turns?all=1`);
    expect(query.status).toBe(400);
  });
});
