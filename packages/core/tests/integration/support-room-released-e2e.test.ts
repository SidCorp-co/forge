import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { warmColdRooms } from '../../src/support/index.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/rooms.ts
// @direct-test-of packages/core/src/support/read.ts
// @direct-test-of packages/core/src/support/turns.ts
// @direct-test-of packages/core/src/support/channel-store.ts
// @direct-test-of packages/core/src/support/replay.ts
// @direct-test-of packages/core/src/support/warm.ts
// @direct-test-of packages/core/src/integrations/rocketchat/missed-messages.ts
//
// ISS-933, round 2, as forge-core-61 read it live. A room released by a binding switched off still
// read as held, and as broken, in its old project: sidcorp-mail listed sid-email with BINDING_OFF and
// SESSION_NOT_LISTENING after sid-desk took it (VISION state-never-lies). And a person's message
// written while the room had no placement reached nobody: jarvis asked @babo in sid-email at 16:31Z
// on 2026-11-03, and the session placed at 03:35Z got only its warm-up. A placed room now reads what
// its group said since Forge last recorded a message there, within a day, and hands it on once.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const w = new SupportWorld();
let chat: StandInRocketChat;
let other = '';
const binding = { a: '', b: '' };
const SUPPORT = { product: 'Catalog, the shop back office' };
const JARVIS = { userId: 'u-jarvis', username: 'jarvis' };

const setBinding = (id: string, active: boolean, config: Record<string, unknown>) =>
  rows(sql`
    UPDATE integration_bindings
       SET active = ${active}, config = ${JSON.stringify(config)}::jsonb
     WHERE id = ${id}::uuid`);

/** The sweep, as its process timer runs it. */
async function sweep(): Promise<void> {
  await settleOutbox();
  await warmColdRooms();
}

const read = async (projectId: string, path: string) => {
  const got = await api(w.owner, 'GET', `/api/projects/${projectId}/support/${path}`);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return got.body as Record<string, unknown>;
};

const turnsCarrying = (id: string) =>
  w.box.asked().filter((t) => t.messages.some((m) => m.message === id));

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  other = (await createTestProject(w.ownerId)).id;
  await addProjectMember(other, w.ownerId, 'owner');
  // one bot, two projects: sidcorp-mail's binding (a) holds the group; sid-desk's (b) has its own
  const rc = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Support bot',
    config: { serverUrl: chat.serverUrl },
    secrets: { authToken: chat.bot.authToken, userId: chat.bot.userId },
    bindings: [
      {
        projectId: other,
        role: 'service',
        target: { provider: 'rocketchat', rids: [chat.rid], support: SUPPORT },
      },
      {
        projectId: w.projectId,
        role: 'service',
        target: { provider: 'rocketchat', rids: [chat.rid2], support: SUPPORT },
      },
    ],
  });
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  const connectionId = String((rc.body.connection as { id: string }).id);
  const pairs = await rows<{ id: string; project_id: string }>(sql`
    SELECT id, project_id FROM integration_bindings WHERE connection_id = ${connectionId}::uuid`);
  binding.a = String(pairs.find((p) => p.project_id === other)?.id);
  binding.b = String(pairs.find((p) => p.project_id === w.projectId)?.id);
  await sweep();
  await w.settleWarm();
  const held = (await read(other, 'rooms')).rooms as { rid: string }[];
  expect(held.map((r) => r.rid)).toEqual([chat.rid]);
}, 120_000);

afterAll(() => w.stop());

describe('a released room reads as no room the project holds (ISS-933)', () => {
  it('leaves a room its binding switched off out of the rooms, turns and channels reads', async () => {
    await setBinding(binding.a, false, { rids: [chat.rid], support: SUPPORT });
    await sweep();
    const rooms = (await read(other, 'rooms')).rooms as { rid: string; health: unknown }[];
    expect(rooms, 'no held room, so no unhealthy one').toEqual([]);
    const turns = (await read(other, 'turns')) as { rooms?: unknown[] };
    expect(turns.rooms ?? []).toEqual([]);
    const channels = (await read(other, 'channels')).channels as { rid: string }[];
    expect(channels.map((c) => c.rid)).not.toContain(chat.rid);
  });
});

describe('a placed room is handed what its group said while nothing answered it (ISS-933)', () => {
  it('hands a person’s message written while unplaced to the session once, and nothing else', async () => {
    const now = Date.now();
    const asked = chat.wroteWhileAway(
      chat.rid,
      JARVIS,
      '@supportbot đơn hàng 1453 của tôi đâu rồi?',
      new Date(now - 60 * 60_000),
    );
    const app = chat.wroteWhileAway(
      chat.rid,
      JARVIS,
      'Báo cáo tự động',
      new Date(now - 50 * 60_000),
      {
        bot: true,
      },
    );
    const own = chat.wroteWhileAway(
      chat.rid,
      { userId: chat.bot.userId, username: 'supportbot' },
      'Mình đã nhận',
      new Date(now - 40 * 60_000),
    );
    const stale = chat.wroteWhileAway(
      chat.rid,
      JARVIS,
      'Câu hỏi từ hôm kia',
      new Date(now - 30 * 60 * 60_000),
    );
    // sid-desk's binding now names the group: placed on the next sweep
    await setBinding(binding.b, true, { rids: [chat.rid], support: SUPPORT });
    await sweep();
    await expect.poll(() => turnsCarrying(asked).length, { timeout: 20_000 }).toBe(1);
    for (const id of [app, own, stale]) {
      expect(turnsCarrying(id), `${id} is not handed on`).toEqual([]);
    }
    const [recorded] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_actions a JOIN support_rooms r ON r.id = a.room_id
       WHERE r.rid = ${chat.rid} AND a.kind = 'message_in' AND a.external_id = ${asked}`);
    expect(recorded?.n).toBe(1);
    // the next sweeps and a binding change hand it on no more
    await w.settleWarm();
    await sweep();
    await sweep();
    await w.settleWarm();
    expect(turnsCarrying(asked).length).toBe(1);
  });
});
