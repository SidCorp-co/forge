import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { warmColdRooms } from '../../src/support/index.js';
import { roomWithSession } from '../../src/support/room-session.js';
import { ensureSupportRoom } from '../../src/support/rooms.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/rooms.ts
// @direct-test-of packages/core/src/support/warm.ts
// @direct-test-of packages/core/src/support/store.ts
// @direct-test-of packages/core/src/support/dispatch.ts
// @direct-test-of packages/core/src/integrations/rocketchat/room-routing.ts
// @direct-test-of packages/core/src/db/schema-support.ts
//
// ISS-933, as forge-core-61 read it live: a room stayed held by a switched-off binding, so an active
// binding naming the same rid on the same bot was never placed and its users went unanswered
// (sidcorp-mail's inactive 325f2300 holding sid-desk's group; adminhub-fe's inactive 19fed7ab holding
// Forge-Communicate). A binding switched off, or no longer naming a room, lets the room go; the sweep
// places every active binding naming a room, two of them on one rid included; and a room its binding
// now declares under another kind is re-declared (orbit's OrbitInternal, support to agent).

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const w = new SupportWorld();
let chat: StandInRocketChat;
let other = '';
let connectionId = '';
const binding = { a: '', b: '' };
const SUPPORT = { product: 'Catalog, the shop back office' };

interface Held {
  id: string;
  binding: string;
  kind: string;
  session: string | null;
}

/** The rooms held on `rid`, by binding. */
async function heldOn(rid: string): Promise<Held[]> {
  return rows<Held>(sql`
    SELECT id, binding_id AS binding, kind, session_id AS session FROM support_rooms
     WHERE rid = ${rid} ORDER BY created_at`);
}

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

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  other = (await createTestProject(w.ownerId)).id;
  await addProjectMember(other, w.ownerId, 'owner');
  // one bot, two projects: sidcorp-mail's binding (a) and sid-desk's (b)
  const rc = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Support bot',
    config: { serverUrl: chat.serverUrl },
    secrets: { authToken: chat.bot.authToken, userId: chat.bot.userId },
    bindings: [
      {
        projectId: w.projectId,
        role: 'service',
        target: { provider: 'rocketchat', rids: [chat.rid], support: SUPPORT },
      },
      {
        projectId: other,
        role: 'service',
        target: { provider: 'rocketchat', rids: [chat.rid2], support: SUPPORT },
      },
    ],
  });
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  connectionId = String((rc.body.connection as { id: string }).id);
  const pairs = await rows<{ id: string; project_id: string }>(sql`
    SELECT id, project_id FROM integration_bindings WHERE connection_id = ${connectionId}::uuid`);
  binding.a = String(pairs.find((p) => p.project_id === w.projectId)?.id);
  binding.b = String(pairs.find((p) => p.project_id === other)?.id);
  await sweep();
  expect((await heldOn(chat.rid)).map((r) => r.binding)).toEqual([binding.a]);
}, 120_000);

afterAll(() => w.stop());

describe('a room is held by the bindings that answer it (ISS-933)', () => {
  it('places an active binding on a rid a switched-off binding held, and releases the old one', async () => {
    const [before] = await heldOn(chat.rid);
    expect(before?.session, 'held with a session').not.toBeNull();
    await setBinding(binding.a, false, { rids: [chat.rid], support: SUPPORT });
    await setBinding(binding.b, true, { rids: [chat.rid], support: SUPPORT });
    await sweep();
    const held = await heldOn(chat.rid);
    const placed = held.find((r) => r.binding === binding.b);
    expect(placed, 'the active binding is placed').toBeDefined();
    expect(placed?.session).not.toBeNull();
    const released = held.find((r) => r.binding === binding.a);
    expect(released?.session, 'the switched-off binding holds no session').toBeNull();
  });

  it('gives a released room no session back, whether a message or a declaration reaches it', async () => {
    // a message waiting on the room, or a sweep that read its binding on just before it was switched
    // off, reaches it after the release: neither hands the session back
    const [room] = (await heldOn(chat.rid)).filter((r) => r.binding === binding.a);
    expect(room?.session).toBeNull();
    expect((await roomWithSession(String(room?.id)))?.sessionId, 'by a message').toBeNull();
    const declared = await ensureSupportRoom({
      projectId: w.projectId,
      bindingId: binding.a,
      connectionId,
      rid: chat.rid,
      room: { kind: 'support', support: SUPPORT },
    });
    expect(declared.sessionId, 'by a declaration').toBeNull();
    const [after] = (await heldOn(chat.rid)).filter((r) => r.binding === binding.a);
    expect(after?.session, 'still released').toBeNull();
  });

  it('releases a rid a binding stops naming', async () => {
    await setBinding(binding.b, true, { rids: [chat.rid2], support: SUPPORT });
    await sweep();
    const dropped = (await heldOn(chat.rid)).find((r) => r.binding === binding.b);
    expect(dropped?.session, 'no longer named, no session').toBeNull();
    const named = (await heldOn(chat.rid2)).find((r) => r.binding === binding.b);
    expect(named?.session).not.toBeNull();
  });

  it('places two active bindings naming one rid, each with its own session', async () => {
    await setBinding(binding.a, true, { rids: [chat.rid3], support: SUPPORT });
    await setBinding(binding.b, true, { rids: [chat.rid3], support: SUPPORT });
    await sweep();
    const held = await heldOn(chat.rid3);
    expect(held.map((r) => r.binding).sort()).toEqual([binding.a, binding.b].sort());
    expect(held.every((r) => r.session !== null)).toBe(true);
    expect(new Set(held.map((r) => r.session)).size).toBe(2);
  });

  it('re-declares a room held as support that its binding now names as an agent room', async () => {
    const [before] = (await heldOn(chat.rid3)).filter((r) => r.binding === binding.a);
    expect(before?.kind).toBe('support');
    await setBinding(binding.a, true, {
      rids: [chat.rid3],
      agent: { product: 'Catalog, the shop back office', readers: 'team' },
    });
    await sweep();
    const [after] = (await heldOn(chat.rid3)).filter((r) => r.binding === binding.a);
    expect(after?.id, 'the same room, re-declared').toBe(before?.id);
    expect(after?.kind).toBe('agent');
    expect(after?.session, 'its session re-placed').not.toBeNull();
    expect(after?.session).not.toBe(before?.session);
    const [marker] = await rows<{ agent: string | null }>(sql`
      SELECT metadata->'channelAgent'->>'bindingId' AS agent FROM agent_sessions
       WHERE id = ${String(after?.session)}::uuid`);
    expect(marker?.agent, 'a channel agent session').toBe(binding.a);
  });
});
