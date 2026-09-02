/**
 * A `drive` handoff is code evidence.
 *
 * `collectWorkEvidence` scanned `('code','fix')` on both the job table and the
 * handoff table until 2026-09-02, so an autonomous driver — the one step that
 * writes the code, merges it and closes the issue in a single session — had no
 * evidence at all. `applyMergeMarker` refuses an AGENT's `POST /api/issues/:id/merge`
 * with NO_WORK_EVIDENCE, so the driver's own merge stamp was unreachable, and
 * the close-stamp audit comment told every reader "no branch, commit or code
 * handoff is recorded" for work that had all three. Measured the same day on
 * forge-beta: 7 stored `drive` handoffs, 7 of them carrying a `commitSha`,
 * 0 counted.
 *
 * The unit suite (`src/pipeline/work-evidence.test.ts`) queues rows behind a
 * fake query builder that never executes a `where`, so an `inArray` list is
 * exactly what it cannot see — the assertion there would pass with `drive`
 * absent. This runs the real SQL.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('drive handoffs count as code evidence', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  });

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function issueWithHandoff(
    step: string,
    payload: Record<string, unknown> | null,
  ): Promise<string> {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO issues (project_id, title, status, created_by_id)
      VALUES (${project.id}, ${`handoff-${step}`}, 'in_progress', ${owner.id})
      RETURNING id
    `);
    const issueId = (rows[0] as { id: string }).id;
    if (payload) {
      const runs = await harness.db.execute<{ id: string }>(sql`
        INSERT INTO pipeline_runs (project_id, issue_id, status)
        VALUES (${project.id}, ${issueId}, 'running')
        RETURNING id
      `);
      const runId = (runs[0] as { id: string }).id;
      await harness.db.execute(sql`
        INSERT INTO issue_step_contexts (project_id, issue_id, pipeline_run_id, kind, step, payload)
        VALUES (${project.id}, ${issueId}, ${runId}, 'handoff', ${step},
                ${JSON.stringify(payload)}::jsonb)
      `);
    }
    return issueId;
  }

  // cm:why imported inside the test, not at module scope — work-evidence.ts pulls in db/client.js, which validates env at load time and would throw before beforeAll sets DATABASE_URL
  const load = () => import('../../src/pipeline/work-evidence.js');

  it('reads commitSha and filesModified out of a drive handoff', async () => {
    const issueId = await issueWithHandoff('drive', {
      commitSha: 'deadbeef',
      filesModified: [{ path: 'a.ts', op: 'edit' }],
    });

    const { collectWorkEvidence, hasCodeEvidence } = await load();
    const evidence = await collectWorkEvidence(issueId, harness.db as never);

    expect(evidence.handoffCommitSha).toBe('deadbeef');
    expect(evidence.handoffFilesModified).toBe(1);
    expect(hasCodeEvidence(evidence)).toBe(true);
  });

  it('lets the driver stamp its own merge, which NO_WORK_EVIDENCE used to refuse', async () => {
    const issueId = await issueWithHandoff('drive', { commitSha: 'deadbeef' });

    const { findMissingWorkEvidence } = await load();

    expect(await findMissingWorkEvidence(issueId, harness.db as never)).toBeNull();
  });

  // cm:guard the negative half is what stops the fix from degenerating into "any handoff is evidence": an EMPTY handoff is the ISS-105 fabrication shape, and widening the step list must not widen what counts as proof
  it('still refuses a drive handoff that carries no commit and no files', async () => {
    const issueId = await issueWithHandoff('drive', { outcome: 'ok', summary: 'did things' });

    const { findMissingWorkEvidence } = await load();

    expect(await findMissingWorkEvidence(issueId, harness.db as never)).toContain(
      'no branch, commit or code handoff is recorded',
    );
  });

  it('does not count a step that writes no code', async () => {
    const issueId = await issueWithHandoff('review', { commitSha: 'deadbeef' });

    const { hasCodeEvidence, collectWorkEvidence } = await load();

    expect(hasCodeEvidence(await collectWorkEvidence(issueId, harness.db as never))).toBe(false);
  });
});
