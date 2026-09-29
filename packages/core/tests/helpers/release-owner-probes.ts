// The reads the release-owner suites assert through (ISS-1281): the owner record a release run
// carries, the rows a take or a refusal may leave, and the wedges a loss raises.

import { sql } from 'drizzle-orm';
import type { TestDatabase } from './index.js';

/** A heartbeat saying the box ships the release role and is draining for an update. */
export const DRAINING = {
  releaseRole: true,
  admission: { state: 'draining', cause: 'update', sinceMs: Date.now(), boundSecs: 3600 },
};

export interface OwnerRow {
  state: string;
  sessionId: string | null;
  deviceId: string | null;
  deadlineAt: string;
  why: string | null;
  refusals: Array<{ reason: string; deviceId: string }>;
}

export async function refusalOf(
  call: Promise<unknown>,
): Promise<Error & { code?: string; boxes?: unknown }> {
  try {
    await call;
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error('expected a refusal, and the call went through');
}

export function releaseOwnerProbes(harness: () => TestDatabase) {
  async function ownerOf(runId: string): Promise<OwnerRow> {
    const rows = (await harness().db.execute(sql`
      SELECT metadata -> 'owner' AS owner FROM pipeline_runs WHERE id = ${runId}
    `)) as unknown as Array<{ owner: OwnerRow | null }>;
    const owner = rows[0]?.owner;
    if (!owner) throw new Error(`release run ${runId} carries no owner record`);
    return owner;
  }

  async function counts() {
    const rows = (await harness().db.execute(sql`
      SELECT (SELECT count(*)::int FROM agent_sessions WHERE kind = 'run_session') AS run_sessions,
             (SELECT count(*)::int FROM issue_leases) AS leases,
             (SELECT count(*)::int FROM pipeline_runs
               WHERE metadata ->> 'source' = 'release-batch') AS releases,
             (SELECT count(*)::int FROM jobs) AS jobs
    `)) as unknown as Array<Record<string, number>>;
    const r = rows[0] ?? {};
    return {
      runSessions: Number(r.run_sessions ?? 0),
      leases: Number(r.leases ?? 0),
      releases: Number(r.releases ?? 0),
      jobs: Number(r.jobs ?? 0),
    };
  }

  async function endSession(sessionId: string): Promise<void> {
    await harness().db.execute(sql`
      UPDATE agent_sessions SET status = 'completed' WHERE id = ${sessionId}
    `);
  }

  async function wedgesFor(runId: string): Promise<string[]> {
    const rows = (await harness().db.execute(sql`
      SELECT title FROM notifications
       WHERE type = 'pipeline_wedge' AND resolution_key = ${`wedge:${runId}`}
    `)) as unknown as Array<{ title: string }>;
    return rows.map((r) => r.title);
  }

  async function recover() {
    const { recoverReleaseOwners } = await import('../../src/release-batch/owner-loss.js');
    return recoverReleaseOwners();
  }

  return { ownerOf, counts, endSession, wedgesFor, recover };
}
