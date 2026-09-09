// The seeding a release-batch case needs before it can assert anything.
//
// Extracted from `release-batch-finish-e2e.test.ts` when the recovery cases
// pushed that file's outer `describe` past its line budget. Two suites read
// the same batch surface, and a second hand-typed copy of this seeding is how
// one of them ends up proving its own SQL instead of the batch's.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createTestDevice, type TestDatabase } from './index.js';

export const RELEASE_LABEL = 'release-box';
export const SKIP_NOTE = { section: 'Skip', userFacing: '-' };

export interface StoredIssue {
  status: string;
  mergedAt: unknown;
  claim: unknown;
}

export interface ReleaseBatchFixture {
  declareProduction(config?: Record<string, unknown>): Promise<void>;
  seedReleaseRunner(): Promise<void>;
  insertIssue(status?: string, note?: unknown): Promise<string>;
  stored(id: string): Promise<StoredIssue>;
  runStatus(runId: string): Promise<string>;
  commentCount(issueId: string): Promise<number>;
  claim(ids: string[]): Promise<{ runId: string; jobId: string; issueIds: string[] }>;
  waitFor(cond: () => Promise<boolean>): Promise<void>;
}

export function releaseBatchFixture(
  harness: () => TestDatabase,
  ids: () => { projectId: string; ownerId: string },
): ReleaseBatchFixture {
  let seq = 0;

  // cm:edge contract -> packages/core/src/release-batch/gate.ts — `resolveProductionDeclaration` reads exactly a production branch distinct from the base plus an active `prod` binding; seed one half and every case dies on NO_RELEASE_GATE before reaching what it asserts
  async function declareProduction(config: Record<string, unknown> = {}): Promise<void> {
    const { projectId, ownerId } = ids();
    const connectionId = randomUUID();
    await harness().db.execute(sql`
      UPDATE projects SET base_branch = 'main', production_branch = 'production'
      WHERE id = ${projectId}
    `);
    await harness().db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connectionId}, 'user', ${ownerId}, 'coolify', true)
    `);
    await harness().db.execute(sql`
      INSERT INTO integration_bindings (connection_id, project_id, provider, environment, active, config)
      VALUES (
        ${connectionId}, ${projectId}, 'coolify', 'prod', true,
        ${JSON.stringify({ releaseRunnerLabel: RELEASE_LABEL, ...config })}::jsonb
      )
    `);
  }

  // cm:guard the box must carry the LABEL and be claim-capable, which are two different gates: `resolveReleaseDeviceIds` matches on `runners.labels`, and `onlineCapableDeviceIds` then asks whether anyone in that set is alive and above the version floor. Seed the label without the liveness and the batch refuses NO_RUNNER_ONLINE, which reads nothing like the pool being empty.
  async function seedReleaseRunner(): Promise<void> {
    const { projectId, ownerId } = ids();
    const device = await createTestDevice(harness().db, ownerId, { status: 'online' });
    await harness().db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (
        ${randomUUID()}, ${projectId}, 'claude-code', ${device.id}, 'release-runner',
        'online', now(), ${JSON.stringify([RELEASE_LABEL])}::jsonb
      )
    `);
  }

  async function insertIssue(
    status = 'awaiting_release',
    note: unknown = SKIP_NOTE,
  ): Promise<string> {
    const { projectId, ownerId } = ids();
    const id = randomUUID();
    seq += 1;
    await harness().db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
      VALUES (
        ${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId},
        ${note === null ? null : JSON.stringify(note)}::jsonb
      )
    `);
    return id;
  }

  async function stored(id: string): Promise<StoredIssue> {
    const rows = await harness().db.execute(sql`
      SELECT status, merged_at, release_batch_run_id FROM issues WHERE id = ${id}
    `);
    return {
      status: String(rows[0]?.status),
      mergedAt: rows[0]?.merged_at ?? null,
      claim: rows[0]?.release_batch_run_id ?? null,
    };
  }

  async function runStatus(runId: string): Promise<string> {
    const rows = await harness().db.execute(sql`
      SELECT status FROM pipeline_runs WHERE id = ${runId}
    `);
    return String(rows[0]?.status);
  }

  async function commentCount(issueId: string): Promise<number> {
    const rows = await harness().db.execute(sql`
      SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issueId}
    `);
    return Number(rows[0]?.n ?? 0);
  }

  // cm:guard go through `createReleaseBatch` and never write `release_batch_run_id` by hand — the claim is a CAS UPDATE inside that function, and a fixture that re-issues it proves its own SQL rather than the batch's
  async function claim(idList: string[]) {
    const { projectId, ownerId } = ids();
    const { createReleaseBatch } = await import('../../src/release-batch/service.js');
    return createReleaseBatch({ projectId, issueIds: idList, userId: ownerId });
  }

  // cm:why the claim subscriber is fire-and-forget by design (it must not hold up a run close), so an assertion has to wait for the write rather than assume it landed
  async function waitFor(cond: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('waitFor: condition never became true');
  }

  return {
    declareProduction,
    seedReleaseRunner,
    insertIssue,
    stored,
    runStatus,
    commentCount,
    claim,
    waitFor,
  };
}
