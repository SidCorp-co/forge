/**
 * ISS-1228 round 15 — a run session or a master is never left `idle`. Only a chat's box ends a
 * turn, so ending a turn is refused on every other kind, and migration 0338 repairs the rows that
 * were left `idle` before that refusal. The migration cases run the shipped file, not a copy.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0338_a_box_session_is_never_left_idle.sql', import.meta.url),
);

let harness: TestDatabase;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

/** The shipped migration, every statement, in one transaction as the deploy runs it. */
async function runMigration(): Promise<void> {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, '').trim().length > 0);
  await harness.db.transaction(async (tx) => {
    for (const s of statements) await tx.execute(sql.raw(s));
  });
}

async function aBox() {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const box = await createTestDevice(harness.db, user.id);
  return { project, box };
}

/** A session of `kind` as the old abort left it: `idle`, whatever it was before. */
async function aSession(args: {
  projectId: string;
  deviceId: string;
  kind: 'run_session' | 'master' | 'chat';
  lastHeartbeatAt: string;
}): Promise<string> {
  const runs = (await harness.db.execute(sql`
    INSERT INTO pipeline_runs (project_id, kind, status, metadata)
    VALUES (${args.projectId}, 'system', 'running', jsonb_build_object('type', ${args.kind}::text))
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const rows = (await harness.db.execute(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, title, kind, status,
                                started_at, last_heartbeat_at, metadata)
    VALUES (${args.projectId}, ${args.deviceId}, ${String(runs[0]?.id)}, 'run: r', ${args.kind}, 'idle',
            now() - interval '1 hour', ${args.lastHeartbeatAt}::timestamptz, '{}'::jsonb)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return String(rows[0]?.id);
}

async function aRecordedMove(sessionId: string, to: string, at: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, reason, actor_type, actor_agency, source, created_at)
    VALUES ('session', ${sessionId}, 'running', ${to}, 'test', 'system', 'agent', 'test', ${at}::timestamptz)
  `);
}

async function statusOf(id: string): Promise<string> {
  const rows = (await harness.db.execute(
    sql`SELECT status FROM agent_sessions WHERE id = ${id}`,
  )) as unknown as Array<{ status: string }>;
  return String(rows[0]?.status);
}

async function movesBy0338(id: string): Promise<Array<{ from_status: string; to_status: string }>> {
  return (await harness.db.execute(sql`
    SELECT from_status, to_status FROM kernel_transitions
     WHERE entity_id = ${id} AND source = 'migration-0338'
  `)) as unknown as Array<{ from_status: string; to_status: string }>;
}

describe('migration 0338', () => {
  it('holds a run session the old abort left idle while it ran as running, and records the move', async () => {
    const { project, box } = await aBox();
    const id = await aSession({
      projectId: project.id,
      deviceId: box.id,
      kind: 'run_session',
      lastHeartbeatAt: new Date().toISOString(),
    });

    await runMigration();

    expect(await statusOf(id)).toBe('running');
    expect(await movesBy0338(id)).toEqual([{ from_status: 'idle', to_status: 'running' }]);
  });

  it('gives a run session core had ended before the abort its ended status back', async () => {
    const { project, box } = await aBox();
    const id = await aSession({
      projectId: project.id,
      deviceId: box.id,
      kind: 'run_session',
      lastHeartbeatAt: '2026-10-17T10:00:00Z',
    });
    await aRecordedMove(id, 'failed', '2026-10-17T10:10:00Z');

    await runMigration();

    expect(await statusOf(id)).toBe('failed');
    expect(await movesBy0338(id)).toEqual([{ from_status: 'idle', to_status: 'failed' }]);
  });

  it('reads an ended status from a move made without the marker too', async () => {
    const { project, box } = await aBox();
    const id = await aSession({
      projectId: project.id,
      deviceId: box.id,
      kind: 'run_session',
      lastHeartbeatAt: '2026-10-17T10:00:00Z',
    });
    await harness.db.execute(sql`
      INSERT INTO unaudited_transitions (entity, entity_id, project_id, from_status, to_status, db_user, detected_at)
      VALUES ('session', ${id}, ${project.id}, 'running', 'completed', 'test', '2026-10-17T10:10:00Z')
    `);

    await runMigration();

    expect(await statusOf(id)).toBe('completed');
  });

  it('holds a master ended, idled and checked in since as running: its box uses it', async () => {
    const { project, box } = await aBox();
    const id = await aSession({
      projectId: project.id,
      deviceId: box.id,
      kind: 'master',
      lastHeartbeatAt: '2026-10-17T10:20:00Z',
    });
    await aRecordedMove(id, 'failed', '2026-10-17T10:10:00Z');

    await runMigration();

    expect(await statusOf(id)).toBe('running');
  });

  it('leaves an idle chat idle: a chat awaiting its reply is what idle means', async () => {
    const { project, box } = await aBox();
    const id = await aSession({
      projectId: project.id,
      deviceId: box.id,
      kind: 'chat',
      lastHeartbeatAt: new Date().toISOString(),
    });

    await runMigration();

    expect(await statusOf(id)).toBe('idle');
    expect(await movesBy0338(id)).toEqual([]);
  });

  it('writes nothing a second time', async () => {
    const { project, box } = await aBox();
    const id = await aSession({
      projectId: project.id,
      deviceId: box.id,
      kind: 'run_session',
      lastHeartbeatAt: new Date().toISOString(),
    });

    await runMigration();
    await runMigration();

    expect(await movesBy0338(id)).toHaveLength(1);
  });
});

async function rowOf(id: string) {
  const { db } = await import('../../src/db/client.js');
  const { agentSessions } = await import('../../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, id));
  if (!row) throw new Error(`no session ${id}`);
  return row;
}

describe('ending a turn, against the database', () => {
  const actor = { type: 'system' as const, id: null };

  it('refuses a run session by name and leaves it running', async () => {
    const { project, box } = await aBox();
    const id = await aSession({
      projectId: project.id,
      deviceId: box.id,
      kind: 'run_session',
      lastHeartbeatAt: new Date().toISOString(),
    });
    await harness.db.execute(sql`UPDATE agent_sessions SET status = 'running' WHERE id = ${id}`);
    const { endChatTurn } = await import('../../src/agent-sessions/turn-end.js');

    await expect(endChatTurn(await rowOf(id), actor)).rejects.toMatchObject({
      status: 409,
      cause: { code: 'TURN_NOT_ENDABLE' },
    });
    expect(await statusOf(id)).toBe('running');
  });

  it('leaves a running chat idle and records the move', async () => {
    const { project, box } = await aBox();
    const id = await aSession({
      projectId: project.id,
      deviceId: box.id,
      kind: 'chat',
      lastHeartbeatAt: new Date().toISOString(),
    });
    await harness.db.execute(sql`UPDATE agent_sessions SET status = 'running' WHERE id = ${id}`);
    const { endChatTurn } = await import('../../src/agent-sessions/turn-end.js');

    await endChatTurn(await rowOf(id), actor);

    expect(await statusOf(id)).toBe('idle');
    const moves = (await harness.db.execute(sql`
      SELECT from_status, to_status FROM kernel_transitions WHERE entity_id = ${id} AND source = 'session-abort'
    `)) as unknown as Array<{ from_status: string; to_status: string }>;
    expect(moves).toEqual([{ from_status: 'running', to_status: 'idle' }]);
  });
});
