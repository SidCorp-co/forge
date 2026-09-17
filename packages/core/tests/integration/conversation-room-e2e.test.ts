/**
 * ISS-1087 — what a room keeps for itself, against a real Postgres: the reply
 * column, the handle's own message ids (stamped and backfilled), the address
 * lookup they serve, and the room's presence over the HTTP surface.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
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
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
let store: typeof import('../../src/conversations/store.js');
let transcript: typeof import('../../src/conversations/transcript.js');
let collect: typeof import('../../src/conversations/collect-inbound.js');
let signUserToken: (userId: string) => Promise<string>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  store = await import('../../src/conversations/store.js');
  transcript = await import('../../src/conversations/transcript.js');
  collect = await import('../../src/conversations/collect-inbound.js');
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  const { conversationRoutes } = await import('../../src/assistant/conversation-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/conversations', conversationRoutes);
  app.onError(errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let projectId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
});

const auth = async (userId: string) => ({ authorization: `Bearer ${await signUserToken(userId)}` });
async function member(role: 'viewer' | 'member' | 'admin') {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  await createTestProjectMember(harness.db, { projectId, userId: user.id, role });
  return user.id;
}
const venue = (externalId = `chat.example.co ${randomUUID()}`) => ({
  adapter: 'rocketchat' as const,
  externalId,
  shape: 'group' as const,
  projectId,
});
const room = () => store.openConversation(venue());
const patch = async (id: string, who: string, body: unknown) =>
  app.request(`/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { ...(await auth(who)), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the reply column and the handle’s own ids', () => {
  it('exists nullable and reads null on a message that replied to nothing (criterion 8)', async () => {
    const cols = await harness.db.execute(
      sql`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'conversation_messages' AND column_name = 'reply_to_external_id'`,
    );
    expect((cols[0] as { is_nullable: string } | undefined)?.is_nullable).toBe('YES');
    const c = await room();
    const [row] = await store.appendMessages({
      conversationId: c.id,
      messages: [{ role: 'user', content: 'hello', authorLabel: 'alice', authorKey: 'u1' }],
    });
    expect(row?.replyToExternalId).toBeNull();
  });

  it('is collected from the inbound frame (criteria 9, 11)', async () => {
    const v = venue();
    const ports = {
      adapter: 'rocketchat' as const,
      resolveVenue: async () => v,
      resolveSpeaker: async () => ({
        linked: false as const,
        refusal: { code: 'X', message: 'unlinked' },
      }),
      deliver: async () => ({ messageId: null }),
      fetchHistory: async () => [],
    };
    const quoting = await collect.collectInboundMessage({
      ports: ports as never,
      frame: {},
      message: 'still wrong',
      speakerKey: 'u1',
      externalMessageId: 'rc-2',
      replyToExternalId: 'rc-bot-1',
      manySpeakersPrincipalUserId: ownerId,
    });
    const plain = await collect.collectInboundMessage({
      ports: ports as never,
      frame: {},
      message: 'hello',
      speakerKey: 'u1',
      externalMessageId: 'rc-3',
      manySpeakersPrincipalUserId: ownerId,
    });
    expect(quoting.kind).toBe('collected');
    const rows = await store.readMessages(
      (quoting as { conversationId: string }).conversationId,
      10,
    );
    expect(rows.map((r) => [r.externalId, r.replyToExternalId])).toEqual([
      ['rc-2', 'rc-bot-1'],
      ['rc-3', null],
    ]);
    expect(plain.kind).toBe('collected');
  });

  it('stamps a delivered reply with the transport’s id (criterion 12)', async () => {
    const c = await room();
    await transcript.recordDeliveredReply({
      conversationId: c.id,
      projectId,
      text: 'the build is green',
      receipt: { messageId: 'rc-bot-9' },
      deliveryKey: 'window:w1',
    });
    const [row] = await store.readMessages(c.id, 1);
    expect(row).toMatchObject({ role: 'assistant', externalId: 'rc-bot-9' });
  });

  // cm:guard the backfill is the migration's own statement, run against a row shaped like the ones written before ISS-1087: a proof with a messageId and a null external_id (criterion 12).
  it('backfills the id from the proof for rows written before the column carried it (criterion 12)', async () => {
    const c = await room();
    await store.appendMessages({
      conversationId: c.id,
      messages: [
        {
          role: 'assistant',
          content: 'older reply',
          deliveryProof: { messageId: 'rc-bot-old', deliveryKey: 'window:w0' },
        },
      ],
    });
    const migration = readFileSync(
      new URL('../../drizzle/migrations/0265_room_presence_and_reply_to.sql', import.meta.url),
      'utf8',
    );
    const backfill = migration
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .find((s) => s.startsWith('UPDATE "conversation_messages"'));
    expect(backfill).toBeDefined();
    await harness.db.execute(sql.raw(backfill as string));
    const [row] = await store.readMessages(c.id, 1);
    expect(row?.externalId).toBe('rc-bot-old');
  });

  it('answers which reply targets are the handle’s, and not a person’s (criterion 13)', async () => {
    const c = await room();
    await transcript.recordDeliveredReply({
      conversationId: c.id,
      projectId,
      text: 'answer',
      receipt: { messageId: 'rc-bot-9' },
    });
    await store.appendMessages({
      conversationId: c.id,
      messages: [{ role: 'user', content: 'hi', authorLabel: 'alice', externalId: 'rc-alice-1' }],
    });
    const sent = await store.assistantSentExternalIds('rocketchat', [
      'rc-bot-9',
      'rc-alice-1',
      'rc-nobody',
    ]);
    expect([...sent]).toEqual(['rc-bot-9']);
  });
});

describe('a room’s presence over HTTP', () => {
  it('stores a subset of the five keys and answers the row with it (criterion 1)', async () => {
    const c = await room();
    const who = await member('member');
    const res = await patch(c.id, who, { presence: { backoffAfter: 1, answerInGroup: 'tool' } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { presence: unknown }).presence).toEqual({
      backoffAfter: 1,
      answerInGroup: 'tool',
    });
    expect((await store.getConversation(c.id))?.presence).toEqual({
      backoffAfter: 1,
      answerInGroup: 'tool',
    });
  });

  it('clears the override with null (criterion 2)', async () => {
    const c = await room();
    const who = await member('member');
    await patch(c.id, who, { presence: { loopLimit: 2 } });
    const res = await patch(c.id, who, { presence: null });
    expect(res.status).toBe(200);
    expect((await store.getConversation(c.id))?.presence).toBeNull();
  });

  it('refuses heartbeat by name, listing the five room keys (criterion 3)', async () => {
    const c = await room();
    const who = await member('member');
    const res = await patch(c.id, who, { presence: { heartbeat: { enabled: true } } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string }; message?: string };
    const text = JSON.stringify(body);
    expect(text).toMatch(/`heartbeat` is a handle's own and is not set on a room/);
    expect(text).toMatch(/dormantMs, backoffAfter, loopBounceMs, loopLimit, answerInGroup/);
    expect((await store.getConversation(c.id))?.presence).toBeNull();
  });

  it('refuses a value outside its bounds naming the key and the bounds (criterion 4)', async () => {
    const c = await room();
    const who = await member('member');
    const res = await patch(c.id, who, { presence: { dormantMs: 1 } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(
      /presence.dormantMs must be between 60000 and 2592000000/,
    );
  });

  it('refuses a viewer setting it', async () => {
    const c = await room();
    const viewer = await member('viewer');
    const res = await patch(c.id, viewer, { presence: { loopLimit: 2 } });
    expect(res.status).toBe(403);
  });
});
