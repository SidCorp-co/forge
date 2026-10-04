// cm:why ISS-112 (design automation rev 1, step fires_table; REQ-16 BC-4): migration 0367, read off
// disk and run against real Postgres inside a transaction that is rolled back. Every old prompt fire
// becomes one schedule_runs row, a failover chain stays one fire, a session naming a schedule that is
// gone is reported by count and by name and never dropped in silence, a second run writes nothing,
// and a legacy row the new vocabulary cannot name stops the migration by name.

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

const MIGRATION = readFileSync(
  resolvePath(
    dirname(fileURLToPath(import.meta.url)),
    '../../drizzle/migrations/0367_a_fire_is_one_row_for_every_kind.sql',
  ),
  'utf8',
);

let harness: TestDatabase;
let client: Sql;
let notices: string[] = [];
let projectId: string;
let otherProjectId: string;
let userId: string;

class Rollback extends Error {}

beforeAll(async () => {
  harness = await setupTestDatabase();
  client = postgres(harness.url, { max: 1, onnotice: (n) => notices.push(String(n.message)) });
  const user = await createTestUser(harness.db);
  userId = user.id;
  projectId = (await createTestProject(harness.db, user.id)).id;
  otherProjectId = (await createTestProject(harness.db, user.id)).id;
}, 120_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  if (harness) await harness.cleanup();
});

type Tx = postgres.TransactionSql;

async function asBeforeTheMigration(tx: Tx): Promise<void> {
  await tx.unsafe(`
    ALTER TABLE schedule_runs DROP CONSTRAINT IF EXISTS schedule_runs_reason_chk;
    ALTER TABLE schedule_runs DROP CONSTRAINT IF EXISTS schedule_runs_refusal_chk;
  `);
}

async function schedule(tx: Tx, kind: string): Promise<string> {
  const [row] = await tx`
    INSERT INTO schedules (project_id, name, cron, prompt, kind, owner_id)
    VALUES (${projectId}, ${`${kind} subject`}, '0 3 * * *', ${kind === 'prompt' ? 'go' : null}, ${kind}, ${userId})
    RETURNING id`;
  return row?.id as string;
}

async function session(
  tx: Tx,
  args: {
    scheduleId: string;
    status: string;
    tick?: boolean;
    parentId?: string;
    failover?: boolean;
    failureReason?: string;
    failureDetail?: string;
    minutesAgo: number;
  },
): Promise<string> {
  const [run] = await tx`
    INSERT INTO pipeline_runs (project_id, kind, status, metadata)
    VALUES (${projectId}, 'system', 'running', '{"source":"schedule.run"}'::jsonb) RETURNING id`;
  const metadata: Record<string, unknown> = { source: 'schedule.run', scheduleId: args.scheduleId };
  if (args.tick) metadata.tick = true;
  if (args.failover) metadata.failover = { attempt: 1, triedDeviceIds: [] };
  const [row] = await tx`
    INSERT INTO agent_sessions (project_id, user_id, pipeline_run_id, kind, status, metadata,
                                parent_session_id, failure_reason, failure_detail, created_at, updated_at)
    VALUES (${projectId}, ${userId}, ${run?.id as string}, 'chat', ${args.status},
            ${tx.json(metadata as postgres.JSONValue)}, ${args.parentId ?? null},
            ${args.failureReason ?? null}, ${args.failureDetail ?? null},
            now() - make_interval(mins => ${args.minutesAgo}),
            now() - make_interval(mins => ${args.minutesAgo - 1}))
    RETURNING id`;
  return row?.id as string;
}

async function legacyRun(
  tx: Tx,
  args: { scheduleId: string; status: string; output?: string; projectId?: string },
): Promise<string> {
  const finishedAt = args.status === 'running' ? null : new Date();
  const [row] = await tx`
    INSERT INTO schedule_runs (schedule_id, project_id, trigger, status, output, started_at, finished_at)
    VALUES (${args.scheduleId}, ${args.projectId ?? projectId}, 'scheduled', ${args.status},
            ${args.output ?? null}, now(), ${finishedAt})
    RETURNING id`;
  return row?.id as string;
}

function reportRuns(report: unknown): Array<Record<string, unknown>> {
  const runs = (report as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs))
    throw new Error(`backfill_markers.report holds no runs: ${JSON.stringify(report)}`);
  return runs as Array<Record<string, unknown>>;
}

async function migrate(tx: Tx): Promise<string | null> {
  try {
    await tx.savepoint(async (sp) => {
      await sp.unsafe(MIGRATION);
    });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  notices = [];
  try {
    await client.begin(async (tx) => {
      await asBeforeTheMigration(tx);
      await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

describe('0367 backfills one schedule_runs row per old prompt fire', () => {
  it('maps each fire, keeps a failover chain as one fire, and reports the sessions it cannot link', async () => {
    await inRollback(async (tx) => {
      const prompt = await schedule(tx, 'prompt');
      const done = await session(tx, {
        scheduleId: prompt,
        status: 'completed',
        tick: true,
        minutesAgo: 50,
      });
      const refused = await session(tx, {
        scheduleId: prompt,
        status: 'failed',
        failureReason: 'session_authority_refused',
        failureDetail: 'SESSION_VIEWER: the owner is a viewer',
        minutesAgo: 40,
      });
      const root = await session(tx, {
        scheduleId: prompt,
        status: 'failed',
        tick: true,
        failureReason: 'no_client_ack',
        minutesAgo: 30,
      });
      const retry = await session(tx, {
        scheduleId: prompt,
        status: 'completed',
        tick: true,
        parentId: root,
        failover: true,
        minutesAgo: 25,
      });
      const live = await session(tx, { scheduleId: prompt, status: 'running', minutesAgo: 10 });
      const goneSchedule = '00000000-0000-4000-8000-000000000365';
      const orphan = await session(tx, {
        scheduleId: goneSchedule,
        status: 'completed',
        minutesAgo: 5,
      });

      expect(await migrate(tx)).toBeNull();

      const fires = await tx`
        SELECT id, trigger, status, refusal, error, session_id, finished_at, project_id
        FROM schedule_runs WHERE schedule_id = ${prompt} ORDER BY created_at`;
      expect(fires.map((f) => [f.session_id, f.trigger, f.status, f.refusal])).toEqual([
        [done, 'scheduled', 'success', null],
        [refused, 'manual', 'failed', 'SESSION_VIEWER'],
        [retry, 'scheduled', 'success', null],
        [live, 'manual', 'running', null],
      ]);
      expect(fires[1]?.error).toBe(
        'session_authority_refused: SESSION_VIEWER: the owner is a viewer',
      );
      expect(fires[3]?.finished_at).toBeNull();
      expect(fires.every((f) => f.finished_at !== null || f.status === 'running')).toBe(true);

      const stamped = await tx`
        SELECT id, metadata ->> 'scheduleRunId' AS fire FROM agent_sessions
        WHERE id IN ${tx([root, retry, orphan])}`;
      const fireOf = new Map(stamped.map((r) => [r.id as string, r.fire as string | null]));
      expect(fireOf.get(root)).toBe(fires[2]?.id);
      expect(fireOf.get(retry)).toBe(fires[2]?.id);
      expect(fireOf.get(orphan)).toBeNull();

      const [marker] = await tx`
        SELECT report FROM backfill_markers WHERE key = '0367_schedule_runs_one_row_per_fire'`;
      const runs = reportRuns(marker?.report);
      expect(runs.at(-1)).toMatchObject({
        firesWritten: 4,
        sessionsLinked: 5,
        sessionsUnlinked: 1,
        unlinked: [{ sessionId: orphan, scheduleId: goneSchedule }],
      });
      expect(notices).toContain(
        `schedule_runs backfill: session ${orphan} names schedule ${goneSchedule}, which does not exist, so it stays unlinked`,
      );
      expect(
        notices.some((n) => /4 fire\(s\) written over 5 session\(s\); 1 session\(s\)/.test(n)),
      ).toBe(true);
    });
  });

  it('a second run writes nothing and records that it wrote nothing', async () => {
    await inRollback(async (tx) => {
      const prompt = await schedule(tx, 'prompt');
      await session(tx, { scheduleId: prompt, status: 'completed', minutesAgo: 5 });

      expect(await migrate(tx)).toBeNull();
      expect(await migrate(tx)).toBeNull();

      const [count] =
        await tx`SELECT count(*)::int AS n FROM schedule_runs WHERE schedule_id = ${prompt}`;
      expect(count?.n).toBe(1);
      const [marker] = await tx`
        SELECT report FROM backfill_markers WHERE key = '0367_schedule_runs_one_row_per_fire'`;
      const runs = reportRuns(marker?.report);
      expect(runs.slice(-2).map((r) => r.firesWritten)).toEqual([1, 0]);
    });
  });

  it('names why each legacy skip ran nothing and rescopes a row to its schedule', async () => {
    await inRollback(async (tx) => {
      const batch = await schedule(tx, 'release_batch');
      const pull = await schedule(tx, 'sentry_pull');
      const quiet = await legacyRun(tx, {
        scheduleId: batch,
        status: 'skipped',
        output: 'nothing is waiting at the release gate',
      });
      const gateless = await legacyRun(tx, {
        scheduleId: batch,
        status: 'skipped',
        output: 'this project has no release gate',
      });
      const held = await legacyRun(tx, {
        scheduleId: batch,
        status: 'skipped',
        output: 'no cut this tick: a batch is in flight',
      });
      const pulled = await legacyRun(tx, {
        scheduleId: pull,
        status: 'skipped',
        output: 'nothing new',
      });
      const elsewhere = await legacyRun(tx, {
        scheduleId: batch,
        status: 'success',
        projectId: otherProjectId,
      });

      expect(await migrate(tx)).toBeNull();

      const rows = await tx`SELECT id, reason, refusal, project_id FROM schedule_runs`;
      const byId = new Map(rows.map((r) => [r.id as string, r]));
      expect(byId.get(quiet)).toMatchObject({ reason: 'nothing-to-do', refusal: null });
      expect(byId.get(gateless)).toMatchObject({
        reason: 'gate-refused',
        refusal: 'NO_RELEASE_GATE',
      });
      expect(byId.get(held)).toMatchObject({ reason: 'gate-refused', refusal: null });
      expect(byId.get(pulled)).toMatchObject({ reason: 'nothing-to-do' });
      expect(byId.get(elsewhere)?.project_id).toBe(projectId);
    });
  });

  it('stops by name on a legacy skip it cannot name, and writes nothing', async () => {
    await inRollback(async (tx) => {
      const prompt = await schedule(tx, 'prompt');
      await session(tx, { scheduleId: prompt, status: 'completed', minutesAgo: 5 });
      const stray = await legacyRun(tx, {
        scheduleId: prompt,
        status: 'skipped',
        output: 'who knows',
      });

      const error = await migrate(tx);
      expect(error).toBe(
        `SCHEDULE_RUN_SKIP_UNNAMED: schedule_runs row ${stray} (a prompt fire) reads output who knows, which names none of no-device | project-not-found | already-applied | nothing-to-do | gate-refused, so this migration writes nothing until that row is repaired`,
      );
      const [count] =
        await tx`SELECT count(*)::int AS n FROM schedule_runs WHERE schedule_id = ${prompt}`;
      expect(count?.n).toBe(1);
    });
  });

  it('stops by name on a settled legacy row with no finished_at', async () => {
    await inRollback(async (tx) => {
      await tx.unsafe(
        'ALTER TABLE schedule_runs DROP CONSTRAINT IF EXISTS schedule_runs_finished_chk',
      );
      const batch = await schedule(tx, 'release_batch');
      const [row] = await tx`
        INSERT INTO schedule_runs (schedule_id, project_id, trigger, status, started_at)
        VALUES (${batch}, ${projectId}, 'scheduled', 'success', now()) RETURNING id`;

      expect(await migrate(tx)).toBe(
        `SCHEDULE_RUN_FINISH: schedule_runs row ${row?.id as string} is success with finished_at null; a running fire has no finished_at and a settled one has it, so this migration writes nothing until that row is repaired`,
      );
    });
  });
});
