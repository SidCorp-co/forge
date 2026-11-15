// @direct-test-of packages/core/src/support/shared-group.ts
// @direct-test-of packages/core/src/support/inbound.ts
// @direct-test-of packages/core/src/support/turn-retry.ts
// @direct-test-of packages/core/src/support/dispatch.ts
// @direct-test-of packages/core/src/support/store.ts

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { supportActions } from '../../src/db/schema-support.js';
import { warmColdRooms } from '../../src/support/index.js';
import { roomById } from '../../src/support/store.js';
import { tellUnanswered } from '../../src/support/turn-retry.js';
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

/** Wait until the room's session replied in the thread after the message: the thread is its now. */
const repliedAfter = (roomId: string, messageId: string) =>
  expect
    .poll(
      async () =>
        (
          await rows(sql`
            SELECT 1 FROM support_actions r, support_actions m
             WHERE m.room_id = ${roomId}::uuid AND m.kind = 'message_in' AND m.external_id = ${messageId}
               AND r.room_id = m.room_id AND r.thread = m.thread AND r.kind = 'reply'
               AND r.created_at > m.created_at`)
        ).length,
      { timeout: 20_000 },
    )
    .toBe(1);

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

  // ISS-1243, sid-email thread zUTf: sid-desk had replied there once, so every later message of it
  // was handed to it as well as to sidcorp-mail, which had taken the thread over; and when a turn
  // failed, sid-desk posted a failure line for a mail request that was not its own
  it('leaves a thread to the binding whose session replied in it last: the other keeps it as context and posts no failure line', async () => {
    const thread = await w.chat.say(w.chat.bob, `@${deskSlug} the desk printer is offline`);
    await settled(thread);
    await handedAs(room.desk, thread, 'you');
    await repliedAfter(room.desk, thread);
    // the mail project is named in the thread and answers there: the thread is mail's now
    const named = await w.chat.say(w.chat.bob, `@${mailSlug} and my mailbox is full`, thread);
    await settled(named);
    await handedAs(room.mail, named, 'you');
    await repliedAfter(room.mail, named);
    const later = await w.chat.say(w.chat.bob, 'still full this morning', thread);
    const got = await settled(later);
    await handedAs(room.mail, later, 'nobody');
    await repliedAfter(room.mail, later);
    // [SHARED_THREAD_HANDED_TWICE] before the fix: the desk session was handed it too
    expect(got.desk?.handed).toBe(false);
    // naming the desk hands it the thread's message again, whoever holds the thread
    const deskAgain = await w.chat.say(w.chat.bob, `@${deskSlug} is the printer back?`, thread);
    await settled(deskAgain);
    await handedAs(room.desk, deskAgain, 'you');
    await repliedAfter(room.desk, deskAgain);
    // the desk replied last now: an unaddressed message is the desk's, and mail keeps it as context
    const deskHeld = await w.chat.say(w.chat.bob, 'it printed one page', thread);
    const held = await settled(deskHeld);
    await handedAs(room.desk, deskHeld, 'nobody');
    expect(held.mail?.handed).toBe(false);
    // a turn of mail that failed on the desk's thread posts no failure line for it
    const desk = await roomById(room.mail);
    const taken = await db
      .select()
      .from(supportActions)
      .where(and(eq(supportActions.roomId, room.mail), eq(supportActions.externalId, deskHeld)));
    expect(taken).toHaveLength(1);
    const linesBefore = (await chat.botLines()).length;
    await tellUnanswered(desk as NonNullable<typeof desk>, taken, 'the turn failed (test)');
    const [failed] = await rows<{ output: Record<string, unknown> }>(sql`
      SELECT output FROM support_actions
       WHERE room_id = ${room.mail}::uuid AND kind = 'refused' AND tool = 'turn_failed'
         AND output->'messages' ? ${String(taken[0]?.id)}`);
    expect(failed?.output).toMatchObject({ posted: false, waitsOnAnswer: true, roomLineWhy: null });
    expect((await chat.botLines()).length).toBe(linesBefore);
  });

  it('takes a save of the binding answering every message beside one answering only mentions, and refuses a second answerer', async () => {
    const save = async (projectId: string, patch: Record<string, unknown>) => {
      const [b] = await rows<{ id: string }>(sql`
        SELECT id FROM integration_bindings WHERE project_id = ${projectId}::uuid`);
      const path = `/api/projects/${projectId}/bindings/${String(b?.id)}`;
      const got = await api(w.owner, 'GET', path);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      const document = got.body.document as { target: Record<string, unknown> };
      return api(w.owner, 'PUT', path, {
        baseRevision: got.body.revision,
        document: { ...document, target: { ...document.target, ...patch } },
      });
    };
    // the ruling as configured on dev: sidcorp-mail's binding saved beside sid-desk's mentions-only one
    const mailSaved = await save(mail, { support: { product: 'Mail, every message' } });
    expect(mailSaved.status, JSON.stringify(mailSaved.body)).toBe(200);
    // the mention-only project made a second answerer of every message is refused by name
    const deskEvery = await save(w.projectId, { support: { product: 'Desk' } });
    expect(deskEvery.status).toBe(422);
    expect(JSON.stringify(deskEvery.body)).toContain('SUPPORT_ROOM_ANSWERED_TWICE');
  });
});
