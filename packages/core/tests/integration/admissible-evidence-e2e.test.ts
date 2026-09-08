/**
 * ISS-940 — what a master can tell from a backlog row, against real Postgres.
 *
 * The backlog's exclusions are "no job, no live run". A run built by the
 * pipeline mints a job, so it never appears here — but an issue built BY HAND
 * mints none, and that is the row this file is about: without the evidence
 * fields it is byte-identical to one nobody has touched. Both facts are read
 * out of columns (`merged_at`, `session_context->>'branch'`) that only a real
 * planner resolves, so a mocked suite cannot fail on either.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const BACKLOG_CONFIG = {
  pipelineConfig: {
    enabled: true,
    poolBacklog: { statuses: ['draft', 'developed'], limit: 20 },
  },
};

describe('ISS-940 backlog rows carry the evidence fields (real Postgres)', () => {
  let harness: TestDatabase;
  let userId: string;
  let projectId: string;
  let deviceId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    userId = (await createTestUser(harness.db)).id;
    projectId = (await createTestProject(harness.db, userId)).id;
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify(BACKLOG_CONFIG)}::jsonb
      WHERE id = ${projectId}
    `);

    deviceId = (await createTestDevice(harness.db, userId, { name: 'backlog-box' })).id;
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status)
      VALUES (${randomUUID()}, ${projectId}, ${deviceId}, 'backlog-runner', 'claude-code', 'online')
    `);
  });

  async function insertIssue(
    seq: number,
    opts: { status?: string; merged?: boolean; branch?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const merged = opts.merged ? sql`now() - interval '2 days'` : sql`NULL`;
    const ctx = opts.branch ? JSON.stringify({ branch: opts.branch }) : JSON.stringify({});
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id,
                          merged_at, session_context)
      VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${opts.status ?? 'draft'},
              ${userId}, ${merged}, ${ctx}::jsonb)
    `);
    return id;
  }

  async function rows() {
    const { readAdmissibleIssues } = await import('../../src/devices/admissible.js');
    return readAdmissibleIssues({ deviceId });
  }

  // cm:guard the two issues differ ONLY in the evidence columns — same status, same project, same age ordering. That is the whole claim: before this change a master saw one row shape for both, and the backlog's job/run exclusions cannot separate them because neither has a job.
  it('separates a hand-built draft from an untouched one', async () => {
    await insertIssue(1);
    await insertIssue(2, { branch: 'ISS-2' });

    const got = await rows();
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ issueKey: 'ISS-1', branch: null, mergedAt: null });
    expect(got[1]).toMatchObject({ issueKey: 'ISS-2', branch: 'ISS-2' });
    expect(got[1]?.mergedAt).toBeNull();
  });

  it('shows the merge mark on work that already landed', async () => {
    await insertIssue(3, { status: 'developed', merged: true, branch: 'ISS-3' });

    const [row] = await rows();
    expect(row?.status).toBe('developed');
    expect(row?.branch).toBe('ISS-3');
    expect(typeof row?.mergedAt).toBe('string');
  });

  // cm:guard the mark must NOT hide the row. `merged_at` is caller-asserted, so excluding on it would take a decision away from the master and hide an issue whose stamp was wrong — the opposite of handing over raw facts.
  it('still offers a marked row rather than filtering it away', async () => {
    await insertIssue(4, { merged: true });

    const got = await rows();
    expect(got.map((r) => r.issueKey)).toEqual(['ISS-4']);
    expect(got[0]?.mergedAt).not.toBeNull();
  });

  it('reads a missing branch key as null rather than the string "undefined"', async () => {
    await insertIssue(5);

    const [row] = await rows();
    expect(row?.branch).toBeNull();
  });
});
