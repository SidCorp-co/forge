/**
 * One project with one paired box bound to it, and the walk every pool lane is
 * proved by: listed, prepared with its prompt, started, ended by the box's fail
 * report. The pool and claim functions are handed in, so each suite reaches only
 * the modules its own lanes live in.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import type { TestDatabase } from './db.js';
import { createTestProject, createTestUser, seedOrg } from './factories.js';
import { pairDevice } from './pair-device.js';

export interface PoolBox {
  ownerId: string;
  projectId: string;
  deviceId: string;
  deviceToken: string;
}

const CLAIM_CAPABLE_VERSION = '99.0.0';

export async function seedPoolBox(harness: TestDatabase): Promise<PoolBox> {
  const ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  const projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  const issued = await pairDevice({ ownerId, name: 'pool-box', platform: 'linux' });
  const deviceId = issued.device.id;
  await harness.db.execute(sql`
    UPDATE devices SET agent_version = ${CLAIM_CAPABLE_VERSION}, last_seen_at = now()
    WHERE id = ${deviceId}
  `);
  await harness.db.execute(
    sql`UPDATE projects SET repo_path = '/tmp/pool-lanes' WHERE id = ${projectId}`,
  );
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at)
    VALUES (${randomUUID()}, ${projectId}, ${deviceId}, 'claude-code', 'pool-runner', 'online', now())
  `);
  return { ownerId, projectId, deviceId, deviceToken: issued.plaintext };
}

export async function countRows(
  harness: TestDatabase,
  projectId: string,
  table: 'jobs' | 'pipeline_runs',
): Promise<number> {
  const rows = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE project_id = ${projectId}`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

export interface JobFacts {
  status: string;
  held_by: string | null;
  error: string | null;
  failure_kind: string | null;
  failure_action: string | null;
  failure_reason: string | null;
}

export async function jobFacts(harness: TestDatabase, jobId: string): Promise<JobFacts> {
  const rows = (await harness.db.execute(sql`
    SELECT status, held_by, error, failure_kind, failure_action, failure_reason
    FROM jobs WHERE id = ${jobId}
  `)) as unknown as JobFacts[];
  const row = rows[0];
  if (!row) throw new Error(`job ${jobId} not found`);
  return row;
}

export async function seedIssue(harness: TestDatabase, box: PoolBox): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
    VALUES (${id}, ${box.projectId}, 4242, 'lane issue', 'open', 'medium', ${box.ownerId})
  `);
  return id;
}

/** A queued `custom` job on a run of its own, carrying exactly `payload`. */
export async function plantJob(
  harness: TestDatabase,
  box: PoolBox,
  opts: { payload: Record<string, unknown>; queuedAgo?: string },
): Promise<{ jobId: string; runId: string }> {
  const jobId = randomUUID();
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${box.projectId}, 'system', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, created_by, payload, queued_at)
    VALUES (${jobId}, ${box.projectId}, ${runId}, 'custom', 'queued', ${box.ownerId},
            ${JSON.stringify(opts.payload)}::jsonb, now() - ${opts.queuedAgo ?? '0 minutes'}::interval)
  `);
  return { jobId, runId };
}

export interface PoolPorts {
  readPool: (a: {
    deviceId: string;
    projectId?: string;
    limit: number;
  }) => Promise<Array<{ jobId: string }>>;
  prepare: (a: {
    jobId: string;
    deviceId: string;
    sessionId: string;
  }) => Promise<
    { ok: true; prepared: { promptString: string | null } } | { ok: false; reason: string }
  >;
  start: (a: { jobId: string; deviceId: string; sessionId: string }) => Promise<unknown>;
  /** Answers `POST /api/jobs/:id/fail` as the device job-lifecycle routes do. */
  request: (path: string, init: RequestInit) => Response | Promise<Response>;
}

/**
 * One job the whole way through the pool, ending on the one report a pool pane
 * that ends sends (`daemon/pool_jobs.rs:supervise`). A `resumed` job is briefed
 * with its original prompt followed by its prior attempts.
 */
export async function walkThroughPool(
  harness: TestDatabase,
  box: PoolBox,
  ports: PoolPorts,
  jobId: string,
  prompt: string,
  { resumed = false }: { resumed?: boolean } = {},
): Promise<void> {
  const offered = await ports.readPool({
    deviceId: box.deviceId,
    projectId: box.projectId,
    limit: 50,
  });
  expect(
    offered.map((e) => e.jobId),
    'the pool must offer the job its lane minted',
  ).toContain(jobId);

  const sessionId = randomUUID();
  const prepared = await ports.prepare({ jobId, deviceId: box.deviceId, sessionId });
  expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  if (!prepared.ok) return;
  if (resumed) expect(prepared.prepared.promptString?.startsWith(prompt)).toBe(true);
  else expect(prepared.prepared.promptString).toBe(prompt);

  expect(await ports.start({ jobId, deviceId: box.deviceId, sessionId })).toEqual({ ok: true });

  const failed = await ports.request(`/api/jobs/${jobId}/fail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${box.deviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      error: `the job's pane \`forge-job-${jobId}\` ended without reporting an outcome`,
    }),
  });
  expect(failed.status).toBe(200);
  expect(['failed', 'done']).toContain((await jobFacts(harness, jobId)).status);
}
