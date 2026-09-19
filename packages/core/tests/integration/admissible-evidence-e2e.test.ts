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

  // ISS-1062 — the repo projection is a THIRD evidence field on the same row, under the same rule as
  // the two above: it is shown, never filtered on. These cases hold every other input fixed and vary
  // only the projection, so a `WHERE` clause reading `repo_pull_requests` would show up here as a
  // missing row and nowhere else.
  describe('the repo projection travels as evidence and gates nothing', () => {
    async function bindGitHub(): Promise<string> {
      const connectionId = randomUUID();
      const bindingId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
        VALUES (${connectionId}, 'user', ${userId}, 'github', true)
      `);
      await harness.db.execute(sql`
        INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, stages, active, config)
        VALUES (${bindingId}, ${connectionId}, ${projectId}, 'github', 'service', ARRAY[]::text[], true, '{}'::jsonb)
      `);
      return bindingId;
    }

    async function projectPr(
      bindingId: string,
      issueId: string,
      number: number,
      over: Record<string, unknown>,
    ): Promise<void> {
      await harness.db.execute(sql`
        INSERT INTO repo_pull_requests
          (project_id, binding_id, issue_id, number, repo_full_name, title, state, draft,
           head_ref, head_sha, base_ref, base_sha, behind_by, mergeable_state, refreshed_for_head,
           refresh_error, checks)
        VALUES (
          ${projectId}, ${bindingId}, ${issueId}, ${number}, 'SidCorp-co/forge', 'planted', 'open',
          false, ${`ISS-${number}`}, ${'a'.repeat(40)}, 'main', ${'c'.repeat(40)},
          ${(over.behindBy as number | null) ?? null},
          ${(over.mergeableState as string | null) ?? null},
          ${(over.refreshedForHead as string | null) ?? null},
          ${(over.refreshError as string | null) ?? null},
          ${JSON.stringify(over.checks ?? {})}::jsonb
        )
      `);
    }

    it('carries an empty list for an issue with no pull request', async () => {
      await insertIssue(6);
      const [row] = await rows();
      expect(row?.pullRequests).toEqual([]);
    });

    it('carries the pull request linked to the issue', async () => {
      const bindingId = await bindGitHub();
      const issueId = await insertIssue(7);
      await projectPr(bindingId, issueId, 7, { behindBy: 0, mergeableState: 'clean' });

      const [row] = await rows();
      expect(row?.pullRequests).toHaveLength(1);
      expect(row?.pullRequests[0]).toMatchObject({
        number: 7,
        state: 'open',
        behindBy: 0,
        mergeableState: 'clean',
      });
    });

    it('admits the same issues whatever the projection says', async () => {
      const bindingId = await bindGitHub();
      const none = await insertIssue(10);
      const green = await insertIssue(11);
      const conflicted = await insertIssue(12);
      const unread = await insertIssue(13);
      void none;
      await projectPr(bindingId, green, 11, {
        behindBy: 0,
        mergeableState: 'clean',
        refreshedForHead: 'a'.repeat(40),
      });
      await projectPr(bindingId, conflicted, 12, {
        behindBy: 14,
        mergeableState: 'dirty',
        refreshedForHead: 'a'.repeat(40),
      });
      await projectPr(bindingId, unread, 13, { refreshError: 'HTTP 403 on SidCorp-co/forge' });

      const got = await rows();
      expect(got.map((r) => r.issueKey)).toEqual(['ISS-10', 'ISS-11', 'ISS-12', 'ISS-13']);
      expect(got[0]?.pullRequests).toEqual([]);
      expect(got[1]?.pullRequests[0]?.mergeableState).toBe('clean');
      expect(got[2]?.pullRequests[0]?.mergeableState).toBe('dirty');
      expect(got[3]?.pullRequests[0]?.refreshError).toMatch(/403/);
      expect(got[3]?.pullRequests[0]?.behindBy).toBeNull();
    });
  });
});
