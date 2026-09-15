// ISS-1034 — the heartbeat tick against a real Postgres: a quiet room whose
// handle asked for one gets exactly one fresh `heartbeat` window over the
// unanswered person messages, the settled window is never reopened, a handle
// with the heartbeat off gets nothing, and two ticks racing on one room open
// one window between them.
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
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
let store: typeof import('../../src/conversations/store.js');
let windows: typeof import('../../src/conversations/windows.js');
let heartbeat: typeof import('../../src/conversations/heartbeat.js');
const clients: Sql[] = [];
function independent(): ReturnType<typeof drizzle> {
  const client = postgres(harness.url, { max: 2, onnotice: () => {} });
  clients.push(client);
  return drizzle(client, {});
}

const NOW = new Date('2026-09-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  store = await import('../../src/conversations/store.js');
  windows = await import('../../src/conversations/windows.js');
  heartbeat = await import('../../src/conversations/heartbeat.js');
}, 120_000);

afterAll(async () => {
  for (const c of clients) await c.end({ timeout: 5 }).catch(() => {});
  if (harness) await harness.cleanup();
});

let projectId: string;
let personId: string;
let handleId: string;
let conversationId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const person = await createTestUser(harness.db);
  personId = person.id;
  const handle = await createTestUser(harness.db);
  handleId = handle.id;
  projectId = (
    await createTestProject(harness.db, personId, { slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
  await createTestProjectMember(harness.db, { userId: handleId, projectId, role: 'member' });
  const conversation = await store.openConversation({
    adapter: 'rocketchat',
    externalId: `chat.example.co ${randomUUID()}`,
    shape: 'group',
    projectId,
  });
  conversationId = conversation.id;
  await harness.db.execute(sql`
    INSERT INTO conversation_participants (conversation_id, kind, user_id, project_id)
    VALUES (${conversationId}, 'handle', ${handleId}, ${projectId})
  `);
});

async function self(presence: Record<string, unknown>) {
  await harness.db.execute(sql`
    INSERT INTO agent_selves (user_id, presence) VALUES (${handleId}, ${JSON.stringify(presence)}::jsonb)
    ON CONFLICT (user_id) DO UPDATE SET presence = excluded.presence
  `);
}
async function say(who: 'person' | 'agent', content: string, msAgo: number) {
  const row = await store.appendMessage({
    conversationId,
    role: who === 'agent' ? 'assistant' : 'user',
    content,
    authorUserId: who === 'agent' ? handleId : personId,
  });
  await harness.db.execute(
    sql`UPDATE conversation_messages SET created_at = ${ago(msAgo).toISOString()}::timestamptz WHERE id = ${row.id}`,
  );
  return row;
}
/** A settled inbound window over `seq`, closed under `decision` an hour ago. */
async function settled(seq: number, decision: 'nothing-to-say' | 'answered') {
  const w = await windows.openOrExtendWindow({
    conversationId,
    projectId,
    adapter: 'rocketchat',
    seq,
    now: ago(2 * HOUR),
  });
  const [claimed] = await windows.claimDueWindows({
    adapter: 'rocketchat',
    claimant: 'core-1',
    limit: 1,
    settleMs: 0,
  });
  if (!claimed || claimed.id !== w.id)
    throw new Error('fixture: the settled window was not claimed');
  const claim = windows.claimOf(claimed);
  if (!claim) throw new Error('fixture: no claim');
  await windows.closeWindow({ windowId: w.id, decision, claim, now: ago(HOUR) });
  return w;
}
async function windowRows() {
  const rows = await harness.db.execute(sql`
    SELECT id, origin, first_seq, last_seq, closed_at FROM conversation_windows
    WHERE conversation_id = ${conversationId} ORDER BY opened_at
  `);
  return rows as unknown as Array<{
    id: string;
    origin: string;
    first_seq: number;
    last_seq: number;
    closed_at: Date | null;
  }>;
}

describe('the heartbeat tick', () => {
  it('opens exactly one heartbeat window over the unanswered person messages, leaving the settled one closed (criteria 36, 37)', async () => {
    await self({ heartbeat: { enabled: true, intervalMs: HOUR } });
    await say('agent', 'earlier answer', 5 * HOUR);
    const first = await say('person', 'anyone?', 4 * HOUR);
    const newest = await say('person', 'hello?', 3 * HOUR);
    const original = await settled(newest.seq, 'nothing-to-say');

    const result = await heartbeat.runHeartbeatTick(NOW);
    expect(result).toMatchObject({ rooms: 1, opened: 1 });

    const rows = await windowRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: original.id, origin: 'inbound' });
    expect(rows[0]?.closed_at).not.toBeNull();
    expect(rows[1]).toMatchObject({
      origin: 'heartbeat',
      first_seq: first.seq,
      last_seq: newest.seq,
      closed_at: null,
    });

    // cm:guard the second tick is the assertion that the heartbeat window it just opened counts as a window OPEN: without that clause every tick would add one (ISS-1034 criterion 36 "exactly one").
    expect(await heartbeat.runHeartbeatTick(NOW)).toMatchObject({
      opened: 0,
      skipped: { 'window-open': 1 },
    });
    expect(await windowRows()).toHaveLength(2);
  });

  it('opens nothing when the handle’s heartbeat is off (criterion 38)', async () => {
    await self({ heartbeat: { enabled: false } });
    await say('agent', 'earlier answer', 5 * HOUR);
    const newest = await say('person', 'hello?', 3 * HOUR);
    await settled(newest.seq, 'nothing-to-say');

    expect(await heartbeat.runHeartbeatTick(NOW)).toEqual({ rooms: 0, opened: 0, skipped: {} });
    expect(await windowRows()).toHaveLength(1);
  });

  it('opens nothing when the last settled window answered', async () => {
    await self({ heartbeat: { enabled: true, intervalMs: HOUR } });
    await say('agent', 'earlier answer', 5 * HOUR);
    const newest = await say('person', 'thanks', 3 * HOUR);
    await settled(newest.seq, 'answered');

    expect(await heartbeat.runHeartbeatTick(NOW)).toMatchObject({
      opened: 0,
      skipped: { 'last-window-not-quiet': 1 },
    });
  });

  // cm:guard two INDEPENDENT connections, because one connection sees its own uncommitted insert and the partial unique index is never asked the question this case exists for (ISS-1034 criterion 65).
  it('two ticks racing on one room open one window between them (criterion 65)', async () => {
    await self({ heartbeat: { enabled: true, intervalMs: HOUR } });
    await say('agent', 'earlier answer', 5 * HOUR);
    const newest = await say('person', 'hello?', 3 * HOUR);
    await settled(newest.seq, 'nothing-to-say');

    const [a, b] = await Promise.all([
      heartbeat.runHeartbeatTick(NOW, independent() as never),
      heartbeat.runHeartbeatTick(NOW, independent() as never),
    ]);
    expect(a.opened + b.opened).toBeGreaterThanOrEqual(1);
    const beats = (await windowRows()).filter((w) => w.origin === 'heartbeat');
    expect(beats).toHaveLength(1);
  });
});
