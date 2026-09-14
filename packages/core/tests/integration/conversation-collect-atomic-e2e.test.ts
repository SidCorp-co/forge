/**
 * ISS-1004 criterion 2 — the collected message and its window commit together,
 * or neither does.
 *
 * It has a file of its own because the only way to prove it is to make the
 * SECOND write fail after the first has succeeded, and the only injection point
 * between them is the window module itself. A test that mocked it alongside the
 * others would take the window rows out of every case in that file; here it
 * takes them out of one.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

vi.mock('../../src/conversations/windows.js', () => ({
  openOrExtendWindow: async () => {
    throw new Error('the window could not be written');
  },
}));

let harness: TestDatabase;
let store: typeof import('../../src/conversations/store.js');
let collect: typeof import('../../src/conversations/collect-inbound.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  store = await import('../../src/conversations/store.js');
  collect = await import('../../src/conversations/collect-inbound.js');
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let projectId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
});

// cm:guard the planted failure, and the reason the whole thing is one transaction: without it the message commits and its window does not, so the room holds a question nothing knows it owes an answer to — a silence with no owner, which is exactly what the window row exists to remove (ISS-1004 review F3).
it('leaves no message behind when its window cannot be written', async () => {
  const externalId = `chat.example.co ${randomUUID()}`;
  const ports = {
    adapter: 'rocketchat' as const,
    resolveVenue: async () => ({
      adapter: 'rocketchat' as const,
      externalId,
      shape: 'group' as const,
      projectId,
    }),
    resolveSpeaker: async () => ({ linked: true as const, userId: ownerId }),
    deliver: async () => ({ messageId: null }),
    fetchHistory: async () => [],
  };

  await expect(
    collect.collectInboundMessage({
      ports: ports as never,
      frame: {},
      message: 'why is CI red?',
      speakerKey: 'rc-user-1',
      manySpeakersPrincipalUserId: ownerId,
    }),
  ).rejects.toThrow(/the window could not be written/);

  const conversation = await store.findConversation('rocketchat', externalId);
  expect(conversation).not.toBeNull();
  expect(await store.readMessages(conversation?.id as string, 10)).toEqual([]);
});
