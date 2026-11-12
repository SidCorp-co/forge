// @direct-test-of packages/core/src/support/shared-group.ts
// @direct-test-of packages/core/src/support/inbound.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { warmColdRooms } from '../../src/support/index.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { addProjectMember, bindTestRunner, createTestProject, rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

// ISS-1220, owner 2026-11-12: #sid-email is sidcorp-mail's room, and sid-desk acts there only when
// it is named. One bot, two projects, both bindings naming the one group (ISS-933): the group's own
// project hears every message; the other answers only mentions. A mention of the bot is a mention
// of both, so a project is addressed by its own name, and a message naming one is the other's
// context only.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const w = new SupportWorld();
let chat: StandInRocketChat;
let mail = '';
const room = { mail: '', desk: '' };
let deskSlug = '';
let mailSlug = '';

/** No turn runs on the box. */
const idle = () => expect.poll(() => w.box.idle(), { timeout: 20_000 }).toBe(true);

/** How a project's room recorded one member message: kept, handed to its session, and for whom. */
async function recordOf(
  roomId: string,
  messageId: string,
): Promise<{ handed: boolean; to: string | null } | null> {
  const [row] = await rows<{ handed: boolean; to: string | null }>(sql`
    SELECT COALESCE(output, '{}'::jsonb) ? 'path' AS handed, input->>'addressed' AS "to"
      FROM support_actions
     WHERE room_id = ${roomId}::uuid AND kind = 'message_in' AND external_id = ${messageId}`);
  return row ?? null;
}

/** Wait until the room's session was handed the message, as addressed `to`. */
const handedAs = (roomId: string, id: string, to: string) =>
  expect.poll(() => recordOf(roomId, id), { timeout: 20_000 }).toEqual({ handed: true, to });

/** Wait until both rooms recorded the message and no turn runs, then read each room's record. */
async function settled(id: string) {
  await expect
    .poll(async () => Boolean((await recordOf(room.mail, id)) && (await recordOf(room.desk, id))), {
      timeout: 20_000,
    })
    .toBe(true);
  await idle();
  return { mail: await recordOf(room.mail, id), desk: await recordOf(room.desk, id) };
}

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  mail = (await createTestProject(w.ownerId)).id;
  await addProjectMember(mail, w.ownerId, 'owner');
  await bindTestRunner(mail, w.box.deviceId);
  await rows(sql`UPDATE runners SET last_seen_at = now() WHERE device_id = ${w.box.deviceId}`);
  const rc = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Support bot',
    config: { serverUrl: chat.serverUrl },
    secrets: { authToken: chat.bot.authToken, userId: chat.bot.userId },
    bindings: [
      {
        projectId: mail,
        role: 'service',
        target: { provider: 'rocketchat', rids: [chat.rid], support: { product: 'Mail' } },
      },
      {
        projectId: w.projectId,
        role: 'service',
        target: {
          provider: 'rocketchat',
          rids: [chat.rid],
          support: { product: 'Desk', answers: 'mentions' },
        },
      },
    ],
  });
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  await settleOutbox();
  const { startRocketChatManager } = await import('../../src/integrations/rocketchat/index.js');
  await startRocketChatManager();
  await warmColdRooms();
  await w.settleWarm();
  const held = await rows<{ id: string; project_id: string; slug: string }>(sql`
    SELECT r.id, r.project_id, p.slug FROM support_rooms r JOIN projects p ON p.id = r.project_id
     WHERE r.rid = ${chat.rid}`);
  room.mail = String(held.find((r) => r.project_id === mail)?.id);
  room.desk = String(held.find((r) => r.project_id === w.projectId)?.id);
  mailSlug = String(held.find((r) => r.project_id === mail)?.slug);
  deskSlug = String(held.find((r) => r.project_id === w.projectId)?.slug);
  // each session answers every message it is handed, in its thread
  w.box.finishTurns = true;
  w.box.model = async (turn, act) => {
    w.box.turnEnd = 'completed';
    for (const m of turn.messages) {
      if (m.from === 'forge') continue;
      await act({ action: 'reply', thread: m.thread, text: `Answered ${m.message}` });
    }
  };
}, 120_000);

afterAll(() => w.stop());

describe('a group two projects share on one bot (ISS-1220)', () => {
  it('hands a message naming nobody to the group’s own project, and the mention-only one keeps it as context', async () => {
    const id = await w.chat.say(w.chat.bob, 'đơn hàng 1453 của tôi đâu rồi?');
    const got = await settled(id);
    await handedAs(room.mail, id, 'nobody');
    expect(got.desk?.handed).toBe(false);
  });

  it('hands a message naming the mention-only project to it alone, as addressed to it', async () => {
    const id = await w.chat.say(w.chat.bob, `@${deskSlug} the desk queue is stuck`);
    const got = await settled(id);
    await handedAs(room.desk, id, 'you');
    expect(got.mail).toEqual({ handed: false, to: null });
  });

  it('leaves a bare mention of the shared bot to the group’s own project', async () => {
    const id = await w.chat.say(w.chat.bob, '@supportbot where is my parcel?');
    const got = await settled(id);
    await handedAs(room.mail, id, 'you');
    expect(got.desk?.handed).toBe(false);
  });

  it('hands a message naming the group’s own project to it, and not the mention-only one', async () => {
    const id = await w.chat.say(w.chat.bob, `@${mailSlug} please resend the invoice`);
    const got = await settled(id);
    await handedAs(room.mail, id, 'you');
    expect(got.desk?.handed).toBe(false);
  });

  it('lets each project post into a thread the other recorded first', async () => {
    const thread = await w.chat.say(w.chat.bob, 'the parcel left the depot yesterday');
    await settled(thread);
    for (const projectId of [w.projectId, mail]) {
      const posted = await api(w.owner, 'POST', `/api/projects/${projectId}/support/master-posts`, {
        text: projectId === mail ? 'Noted by the mail desk' : 'Noted by the service desk',
        rid: chat.rid,
        thread,
      });
      expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
    }
  });
});
