/**
 * Core's one last-resort line per thread (ISS-875, owner 2026-11-02): a thread is told at most one
 * of the three cannot-speak lines, whichever path tells it, and the claim is a row, so a core that
 * restarts does not tell the thread again. Migration 0582 records every support thread already told
 * one, so the deploy does not tell it twice either.
 */

// @direct-test-of packages/core/drizzle/migrations/0582_a_thread_is_told_one_last_resort_line.sql

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimLastResort,
  LAST_RESORT_LINES,
  releaseLastResort,
} from '../../src/conversations/last-resort.js';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

describe('a thread is told one last-resort line', () => {
  const thread = () => ({ adapter: 'rocketchat', venue: `chat.test GROUP ${randomUUID()}` });

  it('once, whichever case would tell it, and read from the row, never from memory', async () => {
    const place = thread();
    expect(await claimLastResort(place, 'offline')).toBe(LAST_RESORT_LINES.offline);
    // a core that restarted holds nothing in memory: the row alone answers
    vi.resetModules();
    const again = await import('../../src/conversations/last-resort.js');
    expect(await again.claimLastResort(place, 'offline')).toBeNull();
    expect(await claimLastResort(place, 'turn_failed')).toBeNull();
    expect(await claimLastResort(place, 'rate_limited')).toBeNull();
  });

  it('each thread its own, and a line that could not be posted gives its claim back', async () => {
    const one = thread();
    const two = thread();
    expect(await claimLastResort(one, 'turn_failed')).toBe(LAST_RESORT_LINES.turn_failed);
    expect(await claimLastResort(two, 'turn_failed')).toBe(LAST_RESORT_LINES.turn_failed);
    expect(await claimLastResort({ ...one, adapter: 'widget' }, 'turn_failed')).not.toBeNull();
    await releaseLastResort(one);
    expect(await claimLastResort(one, 'rate_limited')).toBe(LAST_RESORT_LINES.rate_limited);
  });

  it('two paths racing to tell one thread post one line', async () => {
    const place = thread();
    const told = await Promise.all(
      Array.from({ length: 5 }, () => claimLastResort(place, 'turn_failed')),
    );
    expect(told.filter(Boolean)).toHaveLength(1);
  });
});

const TAG = '0582_a_thread_is_told_one_last_resort_line';

let ground: MigrationGround;
let m: MigrationDb;
let projectId: string;
let roomId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  const userId = randomUUID();
  const orgId = randomUUID();
  const connectionId = randomUUID();
  projectId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  await m.sql`INSERT INTO integration_connections (id, owner_type, owner_id, provider, config) VALUES (${connectionId}, 'user', ${userId}, 'rocketchat', ${m.sql.json({ serverUrl: 'https://chat.example.test' })})`;
  const [binding] = await m.sql<{ id: string }[]>`
    INSERT INTO integration_bindings (project_id, connection_id, provider, role, config, label)
    VALUES (${projectId}, ${connectionId}, 'rocketchat', 'service', ${m.sql.json({ rids: ['GROUP1'] })}, 'support')
    RETURNING id`;
  const [room] = await m.sql<{ id: string }[]>`
    INSERT INTO support_rooms (project_id, binding_id, connection_id, rid, principal_user_id)
    VALUES (${projectId}, ${String(binding?.id)}, ${connectionId}, 'GROUP1', ${userId})
    RETURNING id`;
  roomId = String(room?.id);
});

afterEach(async () => {
  await m.drop();
});

/** A thread of the room, its conversation, and one core action recorded in it. */
async function told(thread: string, tool: string, output: Record<string, unknown>) {
  const venue = `chat.example.test GROUP1 ${thread}`;
  const [c] = await m.sql<{ id: string }[]>`
    INSERT INTO conversations (adapter, external_id, shape)
    VALUES ('rocketchat', ${venue}, 'group')
    ON CONFLICT (adapter, external_id) DO UPDATE SET title = conversations.title
    RETURNING id`;
  await m.sql`
    INSERT INTO support_actions (room_id, project_id, conversation_id, thread, kind, actor_kind, tool, output)
    VALUES (${roomId}, ${projectId}, ${String(c?.id)}, ${thread}, 'refused', 'core', ${tool}, ${m.sql.json(output as never)})`;
  return venue;
}

describe('0582: a support thread already told a line is recorded as told', () => {
  it('records each thread told an offline, turn-failed or limit line, once, and none whose line was never posted', async () => {
    const offline = await told('t-offline', 'offline', { posted: true });
    const failed = await told('t-failed', 'turn_failed', { posted: true });
    await told('t-failed', 'turn_failed', { posted: true });
    const limited = await told('t-limit', 'limit', { messagesPerUserPerHour: 30 });
    await told('t-unposted', 'turn_failed', { posted: false });

    await m.migrate();

    const rows = await m.sql<{ adapter: string; venue: string; kind: string }[]>`
      SELECT adapter, venue, kind FROM conversation_last_resorts ORDER BY venue`;
    expect(rows).toEqual([
      { adapter: 'rocketchat', venue: failed, kind: 'turn_failed' },
      { adapter: 'rocketchat', venue: limited, kind: 'rate_limited' },
      { adapter: 'rocketchat', venue: offline, kind: 'offline' },
    ]);
  });
});
