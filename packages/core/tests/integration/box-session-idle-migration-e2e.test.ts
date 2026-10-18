/**
 * ISS-1228 round 16 — migration 0338 run the way a deploy runs it, on a database that still holds
 * what it repairs.
 *
 * Beta had no idle run session or master left when 0338 reached it, so the judge could not watch
 * it repair one. Here a database is migrated, by drizzle's own migrator, to the step before 0338;
 * idle run sessions and masters are seeded with every history the migration reads; and the same
 * migrator then applies the real folder, which is what `db/migrate.ts` does at boot. Every seeded
 * row is read back. `turn-end-is-a-chats-e2e.test.ts` runs the file's statements on a database
 * already at head; this one proves the journal entry is taken and the deploy's path repairs them.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDevice, createTestProject, createTestUser } from '../helpers/index.js';
import { MIGRATIONS_FOLDER } from '../helpers/migrate.js';
import { caseDbName, drainRetiredScratchDbs, retireScratchDb } from '../helpers/scratch-db.js';

const TAG = '0338_a_box_session_is_never_left_idle';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: JournalEntry[];
};
const target = journal.entries.find((e) => e.tag === TAG);

/** The migrations folder as it stood before 0338: the same files, a journal that ends before it. */
function folderBefore0338(): string {
  if (!target) throw new Error(`${TAG} is not in the journal, so no deploy would ever run it`);
  const dir = mkdtempSync(join(tmpdir(), 'iss1228-before-0338-'));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const before = { ...journal, entries: journal.entries.filter((e) => e.when < target.when) };
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(before, null, 2));
  return dir;
}

type Db = PostgresJsDatabase<Record<string, unknown>>;

let adminUrl: string;
let admin: Sql;
let client: Sql;
let db: Db;
let dbName: string;
let beforeDir: string;

/** What each seeded session is, and the status 0338 must leave it at. */
const seeded: Array<{ name: string; id: string; expected: string; moved: boolean }> = [];
let untouchedXmin: string;
let untouchedId: string;

async function aSession(args: {
  projectId: string;
  deviceId: string;
  kind: 'run_session' | 'master' | 'chat';
  status: string;
  lastHeartbeatAt: string | null;
}): Promise<string> {
  const runs = (await db.execute(sql`
    INSERT INTO pipeline_runs (project_id, kind, status, metadata)
    VALUES (${args.projectId}, 'system', 'running', jsonb_build_object('type', ${args.kind}::text))
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const rows = (await db.execute(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, title, kind, status,
                                started_at, last_heartbeat_at, metadata)
    VALUES (${args.projectId}, ${args.deviceId}, ${String(runs[0]?.id)}, 'run: r', ${args.kind}, ${args.status},
            now() - interval '2 hours', ${args.lastHeartbeatAt}::timestamptz, '{}'::jsonb)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return String(rows[0]?.id);
}

async function aRecordedMove(sessionId: string, to: string, at: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, reason, actor_type, actor_agency, source, created_at)
    VALUES ('session', ${sessionId}, 'running', ${to}, 'test', 'system', 'agent', 'test', ${at}::timestamptz)
  `);
}

const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

beforeAll(async () => {
  adminUrl = process.env.TEST_PG_ADMIN_URL ?? process.env.TEST_DATABASE_URL ?? '';
  if (!adminUrl) throw new Error('no TEST_PG_ADMIN_URL — global setup did not run');
  admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  dbName = caseDbName('iss1228mig');
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  client = postgres(url.toString(), { max: 1, onnotice: () => {} });
  db = drizzle(client);

  beforeDir = folderBefore0338();
  await migrate(db, { migrationsFolder: beforeDir });

  const user = await createTestUser(db);
  const project = await createTestProject(db, user.id);
  const box = await createTestDevice(db, user.id);
  // One live master per box and project, so the second master is on a second box.
  const second = await createTestDevice(db, user.id);
  const on = { projectId: project.id, deviceId: box.id };

  // A run session the old End this turn left idle while it ran, checking in since.
  const ran = await aSession({
    ...on,
    kind: 'run_session',
    status: 'idle',
    lastHeartbeatAt: ago(1),
  });
  await aRecordedMove(ran, 'running', ago(90));
  seeded.push({
    name: 'a run session left idle while it ran',
    id: ran,
    expected: 'running',
    moved: true,
  });

  // A master with no recorded move at all: its history is ambiguous, so it is held running.
  const master = await aSession({ ...on, kind: 'master', status: 'idle', lastHeartbeatAt: ago(2) });
  seeded.push({
    name: 'a master with no recorded move',
    id: master,
    expected: 'running',
    moved: true,
  });

  // A run session core had ended before the old abort flipped it, silent since: its end comes back.
  const ended = await aSession({
    ...on,
    kind: 'run_session',
    status: 'idle',
    lastHeartbeatAt: ago(40),
  });
  await aRecordedMove(ended, 'failed', ago(30));
  seeded.push({
    name: 'a run session ended before the abort',
    id: ended,
    expected: 'failed',
    moved: true,
  });

  // A master ended, then idled, that checked in after its end: its box uses it, so it runs.
  const revived = await aSession({
    ...on,
    deviceId: second.id,
    kind: 'master',
    status: 'idle',
    lastHeartbeatAt: ago(5),
  });
  await aRecordedMove(revived, 'cancelled_stale', ago(30));
  seeded.push({
    name: 'a master that checked in after its end',
    id: revived,
    expected: 'running',
    moved: true,
  });

  // A run session whose end was written without the kernel marker, read off the unaudited log.
  const unmarked = await aSession({
    ...on,
    kind: 'run_session',
    status: 'idle',
    lastHeartbeatAt: ago(25),
  });
  await db.execute(sql`
    INSERT INTO unaudited_transitions (entity, entity_id, project_id, from_status, to_status, db_user, detected_at)
    VALUES ('session', ${unmarked}, ${project.id}, 'running', 'completed', 'test', ${ago(20)}::timestamptz)
  `);
  seeded.push({
    name: 'a run session ended by an unmarked write',
    id: unmarked,
    expected: 'completed',
    moved: true,
  });

  // A chat idle between turns is what idle means: left alone.
  const chat = await aSession({ ...on, kind: 'chat', status: 'idle', lastHeartbeatAt: ago(3) });
  seeded.push({ name: 'a chat awaiting its reply', id: chat, expected: 'idle', moved: false });

  // A running run session is no business of 0338's: not even rewritten.
  untouchedId = await aSession({
    ...on,
    kind: 'run_session',
    status: 'running',
    lastHeartbeatAt: ago(1),
  });
  seeded.push({
    name: 'a running run session',
    id: untouchedId,
    expected: 'running',
    moved: false,
  });
  const [row] = (await db.execute(
    sql`SELECT xmin::text AS xmin FROM agent_sessions WHERE id = ${untouchedId}`,
  )) as unknown as Array<{ xmin: string }>;
  untouchedXmin = String(row?.xmin);

  // The deploy's own step: the real folder, through the same migrator.
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 240_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  if (dbName) retireScratchDb(adminUrl, dbName);
  await drainRetiredScratchDbs();
  await admin?.end({ timeout: 5 }).catch(() => {});
  if (beforeDir) rmSync(beforeDir, { recursive: true, force: true });
});

describe('migration 0338 on a database seeded before it runs (ISS-1228 round 16)', () => {
  it('is applied by the migrator the deploy runs, as the step after the database stood at', async () => {
    const rows = (await db.execute(sql`
      SELECT created_at::text AS at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1
    `)) as unknown as Array<{ at: string }>;
    expect(Number(rows[0]?.at)).toBeGreaterThanOrEqual(target?.when ?? Number.NaN);
    const applied = (await db.execute(sql`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE created_at = ${target?.when ?? 0}
    `)) as unknown as Array<{ n: number }>;
    expect(applied[0]?.n).toBe(1);
  });

  it('leaves each seeded session at the status its history says', async () => {
    for (const s of seeded) {
      const rows = (await db.execute(
        sql`SELECT status FROM agent_sessions WHERE id = ${s.id}`,
      )) as unknown as Array<{ status: string }>;
      expect(rows[0]?.status, s.name).toBe(s.expected);
    }
  });

  it('leaves no run session or master idle', async () => {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM agent_sessions WHERE kind IN ('run_session', 'master') AND status = 'idle'
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(0);
  });

  it('records each move it made from idle, and none for a session it left alone', async () => {
    for (const s of seeded) {
      const moves = (await db.execute(sql`
        SELECT from_status, to_status FROM kernel_transitions
         WHERE entity = 'session' AND entity_id = ${s.id} AND source = 'migration-0338'
      `)) as unknown as Array<{ from_status: string; to_status: string }>;
      expect(moves, s.name).toEqual(
        s.moved ? [{ from_status: 'idle', to_status: s.expected }] : [],
      );
    }
  });

  it('does not rewrite a session that was not idle', async () => {
    const [row] = (await db.execute(
      sql`SELECT xmin::text AS xmin FROM agent_sessions WHERE id = ${untouchedId}`,
    )) as unknown as Array<{ xmin: string }>;
    expect(row?.xmin).toBe(untouchedXmin);
  });
});
