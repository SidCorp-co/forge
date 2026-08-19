/**
 * The phase journal's CHECK constraint, against real Postgres.
 *
 * `phase_journal_verdict_is_runner_written` is the only thing standing between
 * a driver and its own review record. Under the agent-driven pipeline there is
 * no job boundary left between coding and review, so nothing downstream would
 * contradict a session that wrote itself an approval — the database has to
 * refuse it.
 *
 * A constraint that has never been observed rejecting anything is a claim, not
 * a mechanism, and a mocked db cannot observe it. Hence this file.
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

describe('phase_journal constraints E2E', () => {
  let harness: TestDatabase;
  let projectId: string;
  let runId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
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
  ): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO phase_journal (id, project_id, run_id, phase, attempt, source, artifact)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${phase}, ${attempt}, ${source},
              ${artifact === null ? null : JSON.stringify(artifact)}::jsonb)
    `);
  }

  /**
   * drizzle wraps the driver error, so the constraint name is on the cause, not
   * the message. Asserting the name rather than regex-matching prose is what
   * makes this test fail if a DIFFERENT constraint starts rejecting the row.
   */
  async function violatedConstraint(p: Promise<unknown>): Promise<string | undefined> {
    try {
      await p;
      return undefined;
    } catch (e) {
      const cause = (e as { cause?: { constraint_name?: string } }).cause;
      return cause?.constraint_name;
    }
  }

  it('refuses a verdict the agent wrote for itself', async () => {
    expect(
      await violatedConstraint(
        insertPhase('review', 'agent', { kind: 'verdict', decision: 'approve' }),
      ),
    ).toBe('phase_journal_verdict_is_runner_written');
  });

  it('refuses an agent-written rejection too, so the rule is about authorship not outcome', async () => {
    expect(
      await violatedConstraint(
        insertPhase('review', 'agent', { kind: 'verdict', decision: 'request_changes' }),
      ),
    ).toBe('phase_journal_verdict_is_runner_written');
  });

  it('accepts the same verdict from the runner', async () => {
    await insertPhase('review', 'runner', { kind: 'verdict', decision: 'approve' });

    const rows = await harness.db.execute(sql`
      SELECT source, artifact->>'decision' AS decision FROM phase_journal WHERE phase = 'review'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'runner', decision: 'approve' });
  });

  it('lets the agent write every non-verdict phase it owns', async () => {
    await insertPhase('code', 'agent', { kind: 'commit', sha: 'abc123' });
    await insertPhase('plan', 'agent', null);

    const rows = await harness.db.execute(
      sql`SELECT phase FROM phase_journal WHERE source = 'agent' ORDER BY phase`,
    );
    expect(rows.map((r) => r['phase'])).toEqual(['code', 'plan']);
  });

  it('refuses a second row for the same phase and attempt, so a resume point is never ambiguous', async () => {
    await insertPhase('code', 'agent', null, 1);

    expect(await violatedConstraint(insertPhase('code', 'agent', null, 1))).toBe(
      'phase_journal_run_phase_attempt_idx',
    );
    await insertPhase('code', 'agent', null, 2);
  });
});
