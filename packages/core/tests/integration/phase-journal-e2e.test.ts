/**
 * The phase journal against real Postgres, after the reviewer-verdict mechanism
 * was removed on 2026-09-02.
 *
 * Until then `phase_journal_verdict_is_runner_written` refused any `verdict`
 * artifact not written by the runner. The constraint is gone with the mechanism
 * (migration 0194), but rows it protected still exist, and `endPhase` keeps one
 * clause for their sake: an agent note may not land on a row already carrying a
 * verdict. That clause protects HISTORY — nothing writes a verdict any more —
 * and this file is what proves it still does.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('phase_journal E2E', () => {
  let harness: TestDatabase;
  let projectId: string;
  let runId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    projectId = project.id;
    runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, NULL, 'system', 'running', now())
    `);
  });

  async function insertPhase(
    phase: string,
    source: string,
    artifact: unknown,
    attempt = 1,
    startedAt?: string,
  ): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO phase_journal (id, project_id, run_id, phase, attempt, source, artifact, started_at)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${phase}, ${attempt}, ${source},
              ${artifact === null ? null : JSON.stringify(artifact)}::jsonb,
              COALESCE(${startedAt ?? null}::timestamptz, now()))
    `);
  }

  async function violatedConstraint(p: Promise<unknown>): Promise<string | undefined> {
    try {
      await p;
      return undefined;
    } catch (e) {
      const cause = (e as { cause?: { constraint_name?: string } }).cause;
      return cause?.constraint_name;
    }
  }

  it('refuses to let an agent note overwrite a historical verdict row', async () => {
    const { endPhase } = await import('../../src/pipeline/phase-journal.js');
    await insertPhase('review', 'runner', {
      kind: 'verdict',
      decision: 'request_changes',
      findings: [{ why: 'AC2 unmet' }],
    });

    await endPhase({
      runId,
      phase: 'review',
      attempt: 1,
      outcome: 'ok',
      artifact: { kind: 'note', text: 'Reviewer decision: approve.' },
    });

    const rows = await harness.db.execute(sql`
      SELECT source, artifact->>'kind' AS kind, artifact->>'decision' AS decision, ended_at
      FROM phase_journal WHERE phase = 'review'
    `);
    expect(rows[0]).toMatchObject({
      source: 'runner',
      kind: 'verdict',
      decision: 'request_changes',
    });
    expect(rows[0]?.ended_at).toBeNull();
  });

  it('no longer refuses a verdict-shaped row from an agent — the CHECK is gone', async () => {
    await insertPhase('review', 'agent', { kind: 'verdict', decision: 'approve' });
    const rows = await harness.db.execute(
      sql`SELECT source FROM phase_journal WHERE phase = 'review'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('still closes a phase whose artifact is not a verdict', async () => {
    const { endPhase } = await import('../../src/pipeline/phase-journal.js');
    await insertPhase('code', 'agent', { kind: 'note', text: 'first' });

    await endPhase({
      runId,
      phase: 'code',
      attempt: 1,
      outcome: 'ok',
      artifact: { kind: 'note', text: 'second' },
    });

    const rows = await harness.db.execute(sql`
      SELECT artifact->>'text' AS text, ended_at FROM phase_journal WHERE phase = 'code'
    `);
    expect(rows[0]?.text).toBe('second');
    expect(rows[0]?.ended_at).not.toBeNull();
  });

  it('lets the agent write every phase it owns', async () => {
    await insertPhase('code', 'agent', { kind: 'commit', sha: 'abc123' });
    await insertPhase('plan', 'agent', null);

    const rows = await harness.db.execute(
      sql`SELECT phase FROM phase_journal WHERE source = 'agent' ORDER BY phase`,
    );
    expect(rows.map((r) => r.phase)).toEqual(['code', 'plan']);
  });

  it('refuses a second row for the same phase and attempt, so a resume point is never ambiguous', async () => {
    await insertPhase('code', 'agent', null, 1);

    expect(await violatedConstraint(insertPhase('code', 'agent', null, 1))).toBe(
      'phase_journal_run_phase_attempt_idx',
    );
    await insertPhase('code', 'agent', null, 2);
  });

  /**
   * ISS-1042 criterion 40 — the journal reads in the order it happened.
   *
   * `resumePoint` answered where to restart and was the only way in, so an
   * operator could read what a run was stuck on and never what it had done.
   */
  describe('listPhases', () => {
    it('answers oldest first, whatever order the rows were written in', async () => {
      const { listPhases } = await import('../../src/pipeline/phase-journal.js');
      await insertPhase('ship', 'agent', null, 1, '2026-09-03T00:00:00Z');
      await insertPhase('plan', 'agent', null, 1, '2026-09-01T00:00:00Z');
      await insertPhase('code', 'agent', null, 1, '2026-09-02T00:00:00Z');

      const rows = await listPhases(runId);

      expect(rows.map((r) => r.phase)).toEqual(['plan', 'code', 'ship']);
    });

    it('orders two attempts of one phase written at the same instant by attempt', async () => {
      const { listPhases } = await import('../../src/pipeline/phase-journal.js');
      await insertPhase('code', 'agent', null, 2, '2026-09-01T00:00:00Z');
      await insertPhase('code', 'agent', null, 1, '2026-09-01T00:00:00Z');

      const rows = await listPhases(runId);

      expect(rows.map((r) => r.attempt)).toEqual([1, 2]);
    });

    it('answers only this run’s phases', async () => {
      const { listPhases } = await import('../../src/pipeline/phase-journal.js');
      const otherRun = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
        VALUES (${otherRun}, ${projectId}, NULL, 'system', 'running', now())
      `);
      await harness.db.execute(sql`
        INSERT INTO phase_journal (id, project_id, run_id, phase, attempt, source)
        VALUES (${randomUUID()}, ${projectId}, ${otherRun}, 'someone-elses', 1, 'agent')
      `);
      await insertPhase('code', 'agent', null, 1);

      const rows = await listPhases(runId);

      expect(rows.map((r) => r.phase)).toEqual(['code']);
    });

    it('answers an empty journal rather than raising', async () => {
      const { listPhases } = await import('../../src/pipeline/phase-journal.js');

      await expect(listPhases(runId)).resolves.toEqual([]);
    });
  });
});
