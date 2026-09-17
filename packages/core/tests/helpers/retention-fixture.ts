/**
 * Shared fixture for the two ISS-1027 retention suites.
 *
 * They split by proposition: one asserts that an over-age row leaves every
 * swept table and that each rule's exemption keeps the row it is about, the
 * other asserts the transcript rule — that a terminal job's events do not go
 * until the transcript they would rebuild is recorded as finalised, and that
 * the repair pass is what ends that hold rather than an age.
 *
 * Everything is planted through raw SQL at an explicit age, because the whole
 * subject is a predicate over a timestamp: a fixture that let the code under
 * test write its own rows would be asserting against whatever that code
 * happened to do.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { setupTestDatabase, type TestDatabase } from './db.js';
import { createTestDevice, createTestProject, createTestUser } from './factories.js';
import { truncateAll } from './truncate.js';

export type RetentionMods = {
  runRetentionSweep: typeof import('../../src/pipeline/retention/sweep.js').runRetentionSweep;
};

export interface RetentionFixture {
  harness: TestDatabase;
  mods: RetentionMods;
  ids: { projectId: string; ownerId: string; issueId: string; runId: string; deviceId: string };
  reset(): Promise<void>;
  insertJob(opts?: {
    status?: string;
    type?: string;
    sessionId?: string | null;
    finishedDaysAgo?: number;
  }): Promise<string>;
  insertSession(opts?: {
    status?: string;
    metadata?: unknown;
    messages?: unknown;
  }): Promise<string>;
  insertJobEvent(
    jobId: string,
    daysAgo: number,
    seq: number,
    ev?: { kind?: string; data?: unknown },
  ): Promise<string>;
  insertRunner(): Promise<string>;
  insertRunnerEvent(runnerId: string, daysAgo: number): Promise<string>;
  insertQueueSnapshot(daysAgo: number): Promise<string>;
  insertKernelTransition(entity: string, entityId: string, daysAgo: number): Promise<string>;
  insertRetrievalAnalytics(daysAgo: number): Promise<string>;
  count(table: string): Promise<number>;
  metadataOf(sessionId: string): Promise<Record<string, unknown>>;
}

const ago = (days: number) => sql`now() - make_interval(days => ${days})`;

export async function createRetentionFixture(): Promise<RetentionFixture> {
  const harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const sweep = await import('../../src/pipeline/retention/sweep.js');
  const ids = { projectId: '', ownerId: '', issueId: '', runId: '', deviceId: '' };

  return {
    harness,
    ids,
    mods: { runRetentionSweep: sweep.runRetentionSweep },

    async reset() {
      await truncateAll(harness.db);
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      ids.ownerId = owner.id;
      ids.projectId = project.id;
      ids.issueId = randomUUID();
      ids.runId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, created_by_id, title, description, status)
        VALUES (${ids.issueId}, ${ids.projectId}, ${ids.ownerId}, 'ISS-1027 fixture', 'x', 'open')
      `);
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
        VALUES (${ids.runId}, ${ids.projectId}, ${ids.issueId}, 'issue', 'running', now())
      `);
      ids.deviceId = (await createTestDevice(harness.db, owner.id)).id;
    },

    // cm:guard `jobs_active_unique` is on (issue_id, type) for ACTIVE rows, so two fixture jobs on one issue must differ in `type` or one insert fails on a constraint that has nothing to do with retention.
    async insertJob(opts = {}) {
      const id = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, agent_session_id,
                          type, status, payload, queued_at, finished_at)
        VALUES (${id}, ${ids.projectId}, ${ids.issueId}, ${ids.runId}, ${ids.ownerId},
                ${opts.sessionId ?? null}, ${opts.type ?? randomUUID().slice(0, 8)},
                ${opts.status ?? 'done'}, '{}'::jsonb, now(),
                ${opts.finishedDaysAgo === undefined ? sql`now()` : ago(opts.finishedDaysAgo)})
      `);
      return id;
    },

    async insertSession(opts = {}) {
      const id = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, status, metadata,
                                    messages)
        VALUES (${id}, ${ids.projectId}, ${ids.ownerId}, ${ids.runId},
                ${opts.status ?? 'completed'},
                ${JSON.stringify(opts.metadata ?? {})}::jsonb,
                ${JSON.stringify(opts.messages ?? [])}::jsonb)
      `);
      return id;
    },

    async insertJobEvent(jobId, daysAgo, seq, ev = {}) {
      const id = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO job_events (id, job_id, ts, kind, data, seq)
        VALUES (${id}, ${jobId}, ${ago(daysAgo)}, ${ev.kind ?? 'stdout'},
                ${JSON.stringify(ev.data ?? {})}::jsonb, ${seq})
      `);
      return id;
    },

    // cm:guard one DEVICE per runner, not the fixture's shared one: `runners_project_device_type_uq` is on (project_id, device_id, type), so two runners built the obvious way collide on a constraint that has nothing to do with retention.
    async insertRunner() {
      const id = randomUUID();
      const device = await createTestDevice(harness.db, ids.ownerId);
      await harness.db.execute(sql`
        INSERT INTO runners (id, project_id, type, device_id, name, status)
        VALUES (${id}, ${ids.projectId}, 'claude-code', ${device.id},
                ${`r-${id.slice(0, 8)}`}, 'online')
      `);
      return id;
    },

    async insertRunnerEvent(runnerId, daysAgo) {
      const id = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO runner_events (id, runner_id, project_id, old_status, new_status, reason, ts)
        VALUES (${id}, ${runnerId}, ${ids.projectId}, 'offline', 'online', 'fixture',
                ${ago(daysAgo)})
      `);
      return id;
    },

    async insertQueueSnapshot(daysAgo) {
      const id = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO queue_snapshots (id, project_id, ts, queue_depth, running_count)
        VALUES (${id}, ${ids.projectId}, ${ago(daysAgo)}, 1, 0)
      `);
      return id;
    },

    async insertKernelTransition(entity, entityId, daysAgo) {
      const id = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type,
                                        source, created_at)
        VALUES (${id}, ${entity}, ${entityId}, 'running', 'done', 'system', 'fixture',
                ${ago(daysAgo)})
      `);
      return id;
    },

    async insertRetrievalAnalytics(daysAgo) {
      const id = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO retrieval_analytics (id, project_id, query, hit_count, created_at)
        VALUES (${id}, ${ids.projectId}, 'q', 1, ${ago(daysAgo)})
      `);
      return id;
    },

    async count(table) {
      const rows = (await harness.db.execute(
        sql`SELECT count(*)::int AS n FROM ${sql.raw(`"${table}"`)}`,
      )) as unknown as Array<{ n: number }>;
      return Number(rows[0]?.n ?? 0);
    },

    async metadataOf(sessionId) {
      const rows = (await harness.db.execute(
        sql`SELECT metadata FROM agent_sessions WHERE id = ${sessionId}`,
      )) as unknown as Array<{ metadata: Record<string, unknown> | null }>;
      return rows[0]?.metadata ?? {};
    },
  };
}
