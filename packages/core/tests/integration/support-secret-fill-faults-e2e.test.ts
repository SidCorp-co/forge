/**
 * A secret's fill is told or left open, never marked and untold (ISS-1348, cleanup be0527ad): the
 * asks of a slot are filled in the transaction that writes their thread's note, so a fault leaves
 * them open for the event's retry; and a one-time write URL that sets an integration's credential
 * emits its fill fact inside that write, so a failed emit sets nothing behind the URL it gives back.
 * Each fault is one that is no refusal, as a dropped database connection is.
 *
 * @direct-test-of packages/core/src/support/secret-receipts.ts
 * @direct-test-of packages/core/src/support/secret-write.ts
 * @direct-test-of packages/core/src/support/secret-asks.ts
 * @direct-test-of packages/core/src/integrations/credential-write.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
  return { note: false, emit: false };
});

vi.mock('../../src/support/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/support/store.js')>();
  return {
    ...real,
    insertAction: (...args: Parameters<typeof real.insertAction>) => {
      const note = (args[0].input as { note?: unknown } | null)?.note;
      if (faults.note && typeof note === 'string' && note.includes('now holds a value')) {
        throw new Error('Connection terminated unexpectedly');
      }
      return real.insertAction(...args);
    },
  };
});
vi.mock('../../src/support/secret-asks.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/support/secret-asks.js')>();
  return {
    ...real,
    emitSlotFilled: (...args: Parameters<typeof real.emitSlotFilled>) => {
      if (faults.emit) throw new Error('Connection terminated unexpectedly');
      return real.emitSlotFilled(...args);
    },
  };
});

import { app } from '../../src/index.js';
import { connectionSlotKey } from '../../src/integrations/credential-write.js';
import { recordAsk } from '../../src/support/secret-asks.js';
import { tellSlotFilled } from '../../src/support/secret-receipts.js';
import { type RoomRow, roomsOfProject } from '../../src/support/store.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const w = new SupportWorld();
let chat: StandInRocketChat;
let room: RoomRow;

/** An ask of the room for `slot`, as support.secret_link records it. */
async function asked(
  thread: string,
  kind: 'variable' | 'integration',
  slot: Record<string, string>,
  slotKey: string,
  presign = false,
) {
  return recordAsk(
    {
      id: randomUUID(),
      projectId: w.projectId,
      roomId: room.id,
      thread,
      kind,
      slot,
      slotKey,
      link: 'https://forge.test/secrets',
      why: 'planted for the fault',
      shape: null,
      example: null,
      askedFor: null,
    },
    presign,
  );
}

/** Every note core handed the session in `thread` saying a slot was filled. */
const toldIn = async (thread: string) =>
  (
    await rows<{ note: string }>(sql`
      SELECT input->>'note' AS note FROM support_actions
       WHERE room_id = ${room.id}::uuid AND thread = ${thread} AND kind = 'message_in' AND actor_kind = 'core'`)
  )
    .map((r) => r.note)
    .filter((n) => n.includes('now holds a value'));

const filledAt = async (id: string) =>
  (
    await rows<{ at: Date | null }>(
      sql`SELECT filled_at AS at FROM support_secret_asks WHERE id = ${id}::uuid`,
    )
  )[0]?.at ?? null;

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  await w.bind();
  const [declared] = await roomsOfProject(w.projectId);
  if (!declared) throw new Error('the room was not declared');
  room = declared;
});

afterAll(() => w.stop());

describe('a secret fill is told or left open, never marked and untold', () => {
  it('leaves the asks open where telling their thread fails, and tells it once on the retry', async () => {
    const thread = `t-${randomUUID().slice(0, 8)}`;
    const key = `variable:${w.projectId}:staging:RETRY_TOKEN`;
    const first = await asked(
      thread,
      'variable',
      { environment: 'staging', key: 'RETRY_TOKEN' },
      key,
    );
    const second = await asked(
      thread,
      'variable',
      { environment: 'staging', key: 'RETRY_TOKEN' },
      key,
    );
    const fact = {
      projectId: w.projectId,
      slot: key,
      fingerprint: 'fp-retry-0001',
      via: 'page' as const,
      by: null,
      at: new Date().toISOString(),
    };
    faults.note = true;
    try {
      await expect(tellSlotFilled(fact)).rejects.toThrow('Connection terminated');
    } finally {
      faults.note = false;
    }
    // [FILLED_UNTOLD] before the fix: the asks were marked filled before their thread was told
    expect([await filledAt(first.row.id), await filledAt(second.row.id)]).toEqual([null, null]);
    await tellSlotFilled(fact);
    expect(await filledAt(first.row.id)).not.toBeNull();
    expect(await filledAt(second.row.id)).not.toBeNull();
    // one thread, two asks: told once
    expect(await toldIn(thread)).toHaveLength(1);
  });

  it('sets no credential where its fill fact cannot be written, so the URL given back sets it after', async () => {
    const thread = `t-${randomUUID().slice(0, 8)}`;
    const { token } = await asked(
      thread,
      'integration',
      { connection: w.rcConnectionId, provider: 'rocketchat' },
      connectionSlotKey(w.rcConnectionId),
      true,
    );
    const put = async () => {
      const res = await app.fetch(
        new Request(`http://forge.test/api/secret-writes/${token}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'user-agent': 'curl/8.5.0' },
          // the bot's own token, so the room's bot still signs in once it is set
          body: chat.bot.authToken,
        }),
      );
      return res.status;
    };
    const updated = async () =>
      (
        await rows<{ at: string }>(
          sql`SELECT updated_at::text AS at FROM integration_connections WHERE id = ${w.rcConnectionId}::uuid`,
        )
      )[0]?.at;
    const before = await updated();
    faults.emit = true;
    try {
      expect(await put()).toBe(500);
    } finally {
      faults.emit = false;
    }
    // [SET_BEHIND_GIVEN_BACK] before the fix: the credential was written, and its URL given back
    expect(await updated()).toBe(before);
    expect(await put()).toBe(200);
    expect(await updated()).not.toBe(before);
    await settleOutbox();
    await expect.poll(async () => (await toldIn(thread)).length).toBe(1);
  });
});
