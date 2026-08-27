/**
 * ISS-652 — row seeders for the alert-engine integration suites.
 *
 * Shared by every `admin-alerts-*-e2e` spec and by `alert-sweeper-e2e`, which
 * seed the same five tables (jobs, runners, usage_records, schedules +
 * agent_sessions, integration_deliveries) because A1–A5 read them. Bound to one
 * `TestDatabase` by {@link alertFixtures} so a spec never threads `harness`
 * through every call.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createTestUser, type TestDatabase } from './index.js';

export interface AlertFixtures {
  insertRun(projectId: string, status: string): Promise<string>;
  insertIssue(args: {
    projectId: string;
    createdById: string;
    seq: number;
    status?: string;
  }): Promise<string>;
  insertJob(args: {
    projectId: string;
    runId: string;
    status: string;
    type?: string;
    payload?: Record<string, unknown>;
    runnerId?: string | null;
    issueId?: string | null;
    dispatchedAgoMinutes?: number;
    queuedAgoMinutes?: number;
  }): Promise<string>;
  insertRunner(args: {
    projectId: string;
    status: string;
    capabilities?: Record<string, unknown>;
    quarantinedUntil?: string | null;
    lastSeenAt?: string | null;
    rateLimitedUntil?: string | null;
    limitReason?: string | null;
    provisionStatus?: string | null;
  }): Promise<string>;
  insertBinding(projectId: string): Promise<string>;
  insertDelivery(args: {
    bindingId: string;
    direction: 'outbound' | 'inbound';
    status: 'ok' | 'failed';
    createdAgoMinutes?: number;
  }): Promise<void>;
  insertUsage(args: {
    projectId: string | null;
    cost: number;
    recordedAgoHours: number;
  }): Promise<void>;
  insertPromptSchedule(projectId: string): Promise<string>;
  insertPromptSession(args: {
    projectId: string;
    scheduleId: string;
    status: 'completed' | 'completed_via_recovery' | 'cancelled_stale' | 'failed';
    createdAgoMinutes: number;
  }): Promise<void>;
}

const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

export function alertFixtures(harness: TestDatabase): AlertFixtures {
  const db = harness.db;

  return {
    async insertRun(projectId, status) {
      const id = randomUUID();
      const finishedAt =
        status === 'running' || status === 'paused' ? null : new Date().toISOString();
      await db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at)
        VALUES (${id}, ${projectId}, 'system', ${status}, now(), ${finishedAt})
      `);
      return id;
    },

    async insertIssue(args) {
      const id = randomUUID();
      await db.execute(sql`
        INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq)
        VALUES (${id}, ${args.projectId}, 'alert fixture', ${args.status ?? 'approved'},
                ${args.createdById}, ${args.seq})
      `);
      return id;
    },

    async insertJob(args) {
      const id = randomUUID();
      const dispatchedAt =
        args.dispatchedAgoMinutes === undefined ? null : agoIso(args.dispatchedAgoMinutes * 60_000);
      const queuedAt =
        args.queuedAgoMinutes === undefined
          ? new Date().toISOString()
          : agoIso(args.queuedAgoMinutes * 60_000);
      await db.execute(sql`
        INSERT INTO jobs (id, project_id, issue_id, type, status, payload, pipeline_run_id, runner_id, created_by, queued_at, dispatched_at)
        VALUES (
          ${id}, ${args.projectId}, ${args.issueId ?? null}, ${args.type ?? 'code'}, ${args.status},
          ${JSON.stringify(args.payload ?? {})}::jsonb, ${args.runId}, ${args.runnerId ?? null},
          (SELECT created_by FROM projects WHERE id = ${args.projectId}), ${queuedAt}, ${dispatchedAt}
        )
      `);
      return id;
    },

    // cm:why lastSeenAt defaults to a fresh heartbeat, like a real 'online' runner; the four nullable overrides exist so a spec can drive one A3 contributor at a time (stale, rate-limited, auth-dead, unprovisioned)
    async insertRunner(args) {
      const id = randomUUID();
      await db.execute(sql`
        INSERT INTO runners (id, project_id, type, host, name, status, capabilities, quarantined_until, last_seen_at, rate_limited_until, limit_reason, provision_status)
        VALUES (
          ${id}, ${args.projectId}, 'claude-code', 'remote', 'test-runner', ${args.status},
          ${JSON.stringify(args.capabilities ?? {})}::jsonb, ${args.quarantinedUntil ?? null},
          ${args.lastSeenAt === undefined ? new Date().toISOString() : args.lastSeenAt},
          ${args.rateLimitedUntil ?? null}, ${args.limitReason ?? null}, ${args.provisionStatus ?? null}
        )
      `);
      return id;
    },

    async insertBinding(projectId) {
      const owner = await createTestUser(db);
      const connectionId = randomUUID();
      await db.execute(sql`
        INSERT INTO integration_connections (id, owner_type, owner_id, provider)
        VALUES (${connectionId}, 'user', ${owner.id}, 'coolify')
      `);
      const bindingId = randomUUID();
      await db.execute(sql`
        INSERT INTO integration_bindings (id, connection_id, project_id, provider, environment)
        VALUES (${bindingId}, ${connectionId}, ${projectId}, 'coolify', 'prod')
      `);
      return bindingId;
    },

    async insertDelivery(args) {
      const createdAt = agoIso((args.createdAgoMinutes ?? 1) * 60_000);
      await db.execute(sql`
        INSERT INTO integration_deliveries (id, binding_id, direction, event_name, status, created_at)
        VALUES (${randomUUID()}, ${args.bindingId}, ${args.direction}, 'deploy', ${args.status}, ${createdAt})
      `);
    },

    async insertUsage(args) {
      await db.execute(sql`
        INSERT INTO usage_records (id, project_id, source, model, estimated_cost, recorded_at)
        VALUES (${randomUUID()}, ${args.projectId}, 'api', 'test-model', ${args.cost}, ${agoIso(args.recordedAgoHours * 3_600_000)})
      `);
    },

    async insertPromptSchedule(projectId) {
      const id = randomUUID();
      await db.execute(sql`
        INSERT INTO schedules (id, project_id, name, cron, kind, enabled)
        VALUES (${id}, ${projectId}, 'prompt alert fixture', '0 * * * *', 'prompt', true)
      `);
      return id;
    },

    async insertPromptSession(args) {
      const runId = randomUUID();
      const createdAt = agoIso(args.createdAgoMinutes * 60_000);
      await db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at)
        VALUES (${runId}, ${args.projectId}, 'system', 'completed', ${createdAt}, now())
      `);
      await db.execute(sql`
        INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, metadata, created_at, updated_at)
        VALUES (
          ${randomUUID()}, ${args.projectId}, ${runId}, ${args.status},
          ${JSON.stringify({ source: 'schedule.run', scheduleId: args.scheduleId })}::jsonb,
          ${createdAt}, ${createdAt}
        )
      `);
    },
  };
}
