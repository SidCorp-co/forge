/**
 * Rows planted at an explicit age for the retention suites: the subject is a predicate over a
 * timestamp, so the code under test never writes its own rows.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from './factories.js';

export interface RetentionFixture {
  ids: { projectId: string; ownerId: string; issueId: string; runId: string; deviceId: string };
  reset(): Promise<void>;
  insertJob(opts?: {
    status?: string;
    type?: string;
    sessionId?: string | null;
    finishedDaysAgo?: number;
  }): Promise<string>;
  insertSession(opts?: { status?: string; kind?: string; metadata?: unknown }): Promise<string>;
  insertJobEvent(
    jobId: string,
    daysAgo: number,
    seq: number,
    ev?: { kind?: string; data?: unknown },
  ): Promise<string>;
  insertSessionEvent(
    sessionId: string,
    daysAgo: number,
    seq: number,
    ev?: { kind?: string; data?: unknown },
  ): Promise<string>;
  insertRunner(): Promise<string>;
  insertRunnerEvent(runnerId: string, daysAgo: number): Promise<string>;
  insertQueueSnapshot(daysAgo: number): Promise<string>;
  insertKernelTransition(entity: string, entityId: string, daysAgo: number): Promise<string>;
  count(table: string): Promise<number>;
  metadataOf(sessionId: string): Promise<Record<string, unknown>>;
}

const ago = (days: number) => sql`now() - make_interval(days => ${days})`;

export function retentionWorld(): RetentionFixture {
  const ids = { projectId: '', ownerId: '', issueId: '', runId: '', deviceId: '' };

  return {
    ids,

    async reset() {
      await truncateAll();
      const owner = await createTestUser();
      const project = await createTestProject(owner.id);
      ids.ownerId = owner.id;
      ids.projectId = project.id;
      ids.issueId = randomUUID();
      ids.runId = randomUUID();
      await db.execute(sql`
        INSERT INTO issues (id, project_id, created_by_id, title, description, status)
        VALUES (${ids.issueId}, ${ids.projectId}, ${ids.ownerId}, 'ISS-1027 fixture', 'x', 'open')
      `);
      await db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
        VALUES (${ids.runId}, ${ids.projectId}, ${ids.issueId}, 'issue', 'running', now())
      `);
      ids.deviceId = await createTestDevice(owner.id);
    },

    async insertJob(opts = {}) {
      const id = randomUUID();
      await db.execute(sql`
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
      await db.execute(sql`
        INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, kind, status, metadata)
        VALUES (${id}, ${ids.projectId}, ${ids.ownerId}, ${ids.runId},
                ${opts.kind ?? 'pipeline'}, ${opts.status ?? 'completed'},
                ${JSON.stringify(opts.metadata ?? {})}::jsonb)
      `);
      return id;
    },

    async insertJobEvent(jobId, daysAgo, seq, ev = {}) {
      const id = randomUUID();
      await db.execute(sql`
        INSERT INTO job_events (id, job_id, ts, kind, data, seq)
        VALUES (${id}, ${jobId}, ${ago(daysAgo)}, ${ev.kind ?? 'stdout'},
                ${JSON.stringify(ev.data ?? {})}::jsonb, ${seq})
      `);
      return id;
    },

    async insertSessionEvent(sessionId, daysAgo, seq, ev = {}) {
      const id = randomUUID();
      await db.execute(sql`
        INSERT INTO agent_session_events (id, agent_session_id, ts, kind, data, seq)
        VALUES (${id}, ${sessionId}, ${ago(daysAgo)}, ${ev.kind ?? 'stdout'},
                ${JSON.stringify(ev.data ?? { line: { type: 'assistant' } })}::jsonb, ${seq})
      `);
      return id;
    },

    async insertRunner() {
      const id = randomUUID();
      const device = await createTestDevice(ids.ownerId);
      await db.execute(sql`
        INSERT INTO runners (id, project_id, type, device_id, name, status)
        VALUES (${id}, ${ids.projectId}, 'claude-code', ${device},
                ${`r-${id.slice(0, 8)}`}, 'online')
      `);
      return id;
    },

    async insertRunnerEvent(runnerId, daysAgo) {
      const id = randomUUID();
      await db.execute(sql`
        INSERT INTO runner_events (id, runner_id, project_id, old_status, new_status, reason, ts)
        VALUES (${id}, ${runnerId}, ${ids.projectId}, 'offline', 'online', 'fixture',
                ${ago(daysAgo)})
      `);
      return id;
    },

    async insertQueueSnapshot(daysAgo) {
      const id = randomUUID();
      await db.execute(sql`
        INSERT INTO queue_snapshots (id, project_id, ts, queue_depth, running_count)
        VALUES (${id}, ${ids.projectId}, ${ago(daysAgo)}, 1, 0)
      `);
      return id;
    },

    async insertKernelTransition(entity, entityId, daysAgo) {
      const id = randomUUID();
      await db.execute(sql`
        INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type,
                                        actor_agency, source, created_at)
        VALUES (${id}, ${entity}, ${entityId}, 'running', 'done', 'system', 'agent', 'fixture',
                ${ago(daysAgo)})
      `);
      return id;
    },

    async count(table) {
      const [row] = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.raw(`"${table}"`)}`,
      );
      return Number(row?.n ?? 0);
    },

    async metadataOf(sessionId) {
      const [row] = await rows<{ metadata: Record<string, unknown> | null }>(
        sql`SELECT metadata FROM agent_sessions WHERE id = ${sessionId}`,
      );
      return row?.metadata ?? {};
    },
  };
}
