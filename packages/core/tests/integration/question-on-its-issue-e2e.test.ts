/**
 * ISS-1228 r20 — the master's ruling: a question raised by a job working an issue IS that issue's
 * question. The rig: ISS-4's drive job stopped on a question, which was written at project level, so
 * the wedge net read the in-progress issue as nothing working and moved it back to Open while the
 * question stood. The question is now the issue's (ISS-1257's marker), every stalled-issue sweep
 * reads it as waiting on a person, and migration 0347 links the rows already standing. A job with no
 * issue still asks at project level (ISS-1366).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ws/broadcast.js', () => ({
  broadcast: vi.fn(),
  broadcastToProject: vi.fn(),
}));

import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let deviceId: string;

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
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  const { pairDevice } = await import('../helpers/pair-device.js');
  deviceId = (await pairDevice({ ownerId, name: 'box-b', platform: 'linux' })).device.id;
});

const ASKED = {
  kind: 'dialog' as const,
  questions: [
    {
      question: 'Which database should the scratch migration target?',
      options: [{ label: 'Primary' }, { label: 'Replica' }],
    },
  ],
};

/** An issue at `status` whose drive job, worked by a live session on box-b, stops on a question. */
async function stopOnQuestion(
  status: string,
  metadata = '{}',
): Promise<{ issueId: string; runId: string }> {
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id)
    VALUES (${issueId}, ${projectId}, 4, 'Pick the scratch migration target', ${status}, ${ownerId}, ${ownerId})
  `);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, metadata)
    VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', ${metadata}::jsonb)
  `);
  const sessionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, started_at,
                                last_heartbeat_at, metadata)
    VALUES (${sessionId}, ${projectId}, ${runId}, ${deviceId}, 'pipeline', 'running', now(), now(),
            '{"jobType":"drive"}'::jsonb)
  `);
  const jobId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, device_id, agent_session_id, created_by,
                      type, status, dispatched_at, acked_at, payload)
    VALUES (${jobId}, ${projectId}, ${runId}, ${issueId}, ${deviceId}, ${sessionId}, ${ownerId},
            'drive', 'running', now(), now(), '{}'::jsonb)
  `);
  const { endBlockedJob } = await import('../../src/jobs/blocked.js');
  const ended = await endBlockedJob({ id: jobId, status: 'running' }, deviceId, {
    error: 'forge-runner: the pane has been stopped on a question only a human can answer for 2m',
    asked: ASKED,
  });
  expect(ended.issueId).toBe(issueId);
  return { issueId, runId };
}

/** Nothing has written the issue, its run or its job for two days: every sweep's clock has run. */
async function leftForTwoDays(issueId: string, runId: string, runStatus: string): Promise<void> {
  await harness.db.execute(
    sql`UPDATE pipeline_runs SET status = ${runStatus}, finished_at = CASE WHEN ${runStatus} = 'running' THEN NULL ELSE now() - interval '2 days' END WHERE id = ${runId}`,
  );
  await harness.db.execute(
    sql`UPDATE jobs SET created_at = now() - interval '2 days' WHERE issue_id = ${issueId}`,
  );
  await harness.db.execute(
    sql`UPDATE issues SET updated_at = now() - interval '2 days' WHERE id = ${issueId}`,
  );
}

async function issueState(issueId: string) {
  const [issue] = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${issueId}`,
  );
  const comments = await harness.db.execute(
    sql`SELECT 1 FROM comments WHERE issue_id = ${issueId}`,
  );
  const stranded = await harness.db.execute(
    sql`SELECT 1 FROM notifications WHERE issue_id = ${issueId} AND type = 'issue_stranded'`,
  );
  return { status: issue?.status, comments: comments.length, stranded: stranded.length };
}

/** The run's word as every reader of it takes it: the summary the drawer, the runs tab and the issue page read. */
async function runReading(runId: string) {
  const { loadPipelineRunSummary } = await import('../../src/pipeline/runs-rollup.js');
  const run = await loadPipelineRunSummary(runId);
  return { status: run?.status, reading: run?.reading };
}

describe('a run whose job stopped on a question reads as waiting on its answer, never Failed alone', () => {
  it('reads asking while the question stands, answered once it is answered', async () => {
    const { runId } = await stopOnQuestion('in_progress');
    expect(await runReading(runId)).toEqual({ status: 'failed', reading: 'asking' });
    await harness.db.execute(sql`UPDATE agent_questions SET status = 'answered'`);
    expect(await runReading(runId)).toEqual({ status: 'failed', reading: 'answered' });
  });

  it('reads the later work once a job after the question runs or fails', async () => {
    const { issueId, runId } = await stopOnQuestion('in_progress');
    await harness.db.execute(sql`UPDATE agent_questions SET status = 'answered'`);
    await harness.db.execute(sql`UPDATE pipeline_runs SET status = 'running', finished_at = NULL`);
    const later = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, device_id, created_by, type, status,
                        queued_at, dispatched_at, acked_at, payload)
      VALUES (${later}, ${projectId}, ${runId}, ${issueId}, ${deviceId}, ${ownerId}, 'drive', 'running',
              now() + interval '1 minute', now(), now(), '{}'::jsonb)
    `);
    expect(await runReading(runId)).toEqual({ status: 'running', reading: 'running' });
    await harness.db.execute(
      sql`UPDATE jobs SET status = 'failed', failure_reason = 'agent_exited_without_result', finished_at = now() WHERE id = ${later}`,
    );
    await harness.db.execute(sql`UPDATE pipeline_runs SET status = 'failed', finished_at = now()`);
    expect(await runReading(runId)).toEqual({ status: 'failed', reading: null });
  });

  it('reads Failed once its question is voided or expired without an answer', async () => {
    const { runId } = await stopOnQuestion('in_progress');
    await harness.db.execute(sql`UPDATE agent_questions SET status = 'void'`);
    expect(await runReading(runId)).toEqual({ status: 'failed', reading: null });
    await harness.db.execute(sql`UPDATE agent_questions SET status = 'expired'`);
    expect(await runReading(runId)).toEqual({ status: 'failed', reading: null });
  });
});

describe("a job's question is its issue's (criteria 201, 202)", () => {
  it('stands on the issue the job worked, linked to the session that asked', async () => {
    const { issueId } = await stopOnQuestion('in_progress');
    const rows = await harness.db.execute<{
      issue_id: string | null;
      agent_session_id: string | null;
    }>(sql`SELECT issue_id, agent_session_id FROM agent_questions WHERE project_id = ${projectId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.issue_id).toBe(issueId);
    expect(rows[0]?.agent_session_id).not.toBeNull();
  });

  it('keeps an in-progress issue where it is while its question stands, and names it no orphan', async () => {
    const { issueId, runId } = await stopOnQuestion('in_progress');
    await leftForTwoDays(issueId, runId, 'failed');

    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');
    await resetAutonomousWedgesOnce();
    const { detectOrphanedRunAssertions } = await import(
      '../../src/pipeline/issue-run-invariant.js'
    );
    await detectOrphanedRunAssertions();

    expect(await issueState(issueId)).toEqual({ status: 'in_progress', comments: 0, stranded: 0 });
  });

  it('neither sends back nor parks an Open issue while its question stands', async () => {
    const { issueId, runId } = await stopOnQuestion(
      'open',
      '{"autonomousRescue":{"count":3,"doneDriveJobs":0}}',
    );
    await leftForTwoDays(issueId, runId, 'running');

    const { runReconcilerOnce } = await import('../../src/pipeline/reconciler.js');
    await runReconcilerOnce();

    expect(await issueState(issueId)).toEqual({ status: 'open', comments: 0, stranded: 0 });
  });

  it('asks at project level for a job that carries no issue (ISS-1366, unchanged)', async () => {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}, 'system', 'running')
    `);
    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, started_at)
      VALUES (${sessionId}, ${projectId}, ${runId}, ${deviceId}, 'pipeline', 'running', now())
    `);
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, device_id, agent_session_id, created_by, type, status,
                        acked_at, payload)
      VALUES (${jobId}, ${projectId}, ${runId}, ${deviceId}, ${sessionId}, ${ownerId}, 'smoke', 'running', now(),
              '{}'::jsonb)
    `);
    const { endBlockedJob } = await import('../../src/jobs/blocked.js');
    const ended = await endBlockedJob({ id: jobId, status: 'running' }, deviceId, {
      error: 'stopped on a question',
      asked: ASKED,
    });
    expect(ended.issueId).toBeNull();
    const [row] = await harness.db.execute<{ issue_id: string | null }>(
      sql`SELECT issue_id FROM agent_questions WHERE id = ${ended.questionIds[0]}`,
    );
    expect(row?.issue_id).toBeNull();
    const { projectQuestionsFor } = await import('../../src/questions/read.js');
    const tab = await projectQuestionsFor(projectId, ownerId, 'open', { limit: 10 }, true);
    expect(tab?.questions.map((q) => q.askedBy)).toEqual([
      { jobType: 'smoke', issueId: null, issueRef: null, issueTitle: null },
    ]);
  });
});

/** A person answers the question the issue's job stopped on, `ago` before the sweeps read it. */
async function answerItsQuestion(issueId: string, ago = '0 minutes'): Promise<void> {
  const [row] = await harness.db.execute<{
    id: string;
    steps: Array<{ round: number; options?: Array<{ id: string }> }>;
  }>(sql`SELECT id, steps FROM agent_questions WHERE issue_id = ${issueId}`);
  const step = row?.steps.at(-1);
  const optionId = step?.options?.[0]?.id;
  if (!row || !step || !optionId) throw new Error('the job must have asked a choice');
  const { answerQuestion } = await import('../../src/questions/write.js');
  await answerQuestion({
    questionId: row.id,
    answer: { kind: 'option', optionId },
    round: step.round,
    by: ownerId,
    role: 'admin',
  });
  await harness.db.execute(
    sql`UPDATE agent_questions SET updated_at = now() - ${ago}::interval WHERE id = ${row.id}`,
  );
}

/** The stranded-work notice first, so it reads the issue before any reset could move it out of reach. */
async function sweep(): Promise<void> {
  const { detectOrphanedRunAssertions } = await import('../../src/pipeline/issue-run-invariant.js');
  await detectOrphanedRunAssertions();
  const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');
  await resetAutonomousWedgesOnce();
}

// ISS-1228 round 24 (judge-78): an answer woke the masters to resume the in-progress issue, and about
// 40 seconds later the wedge net moved it back to Open (reconciler_autonomous_wedge_reset), while a
// "work in progress with no run behind it" notice fired on it in between.
describe('an answered question resumes its issue where it stands (round 24)', () => {
  it('leaves an in-progress issue in progress, with no notice, past the reset window of its last write', async () => {
    const { issueId, runId } = await stopOnQuestion('in_progress');
    await leftForTwoDays(issueId, runId, 'failed');
    await answerItsQuestion(issueId);
    await sweep();
    expect(await issueState(issueId)).toEqual({ status: 'in_progress', comments: 0, stranded: 0 });
  });

  it('still leaves it nine minutes after the answer, while the masters may still be taking it up', async () => {
    const { issueId, runId } = await stopOnQuestion('in_progress');
    await leftForTwoDays(issueId, runId, 'failed');
    await answerItsQuestion(issueId, '9 minutes');
    await sweep();
    expect(await issueState(issueId)).toEqual({ status: 'in_progress', comments: 0, stranded: 0 });
  });

  it('reads it as wedged once the grace has run from an answer nothing took up', async () => {
    const { issueId, runId } = await stopOnQuestion('in_progress');
    await leftForTwoDays(issueId, runId, 'failed');
    await answerItsQuestion(issueId, '11 minutes');
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');
    expect(await resetAutonomousWedgesOnce()).toBe(1);
    expect((await issueState(issueId)).status).toBe('open');
  });

  it('resolves a stranded notice already standing once the question is answered', async () => {
    const { issueId, runId } = await stopOnQuestion('in_progress');
    await leftForTwoDays(issueId, runId, 'failed');
    await harness.db.execute(
      sql`UPDATE agent_questions SET status = 'void' WHERE issue_id = ${issueId}`,
    );
    const { detectOrphanedRunAssertions } = await import(
      '../../src/pipeline/issue-run-invariant.js'
    );
    await detectOrphanedRunAssertions();
    const standing = sql`SELECT 1 FROM notifications WHERE issue_id = ${issueId} AND type = 'issue_stranded' AND resolved_at IS NULL`;
    expect(await harness.db.execute(standing)).toHaveLength(1);
    await harness.db.execute(
      sql`UPDATE agent_questions SET status = 'open' WHERE issue_id = ${issueId}`,
    );
    await answerItsQuestion(issueId);
    await detectOrphanedRunAssertions();
    expect(await harness.db.execute(standing)).toHaveLength(0);
  });

  it("drops the stopped job from the asker's failed jobs once its question is answered", async () => {
    const { issueId, runId } = await stopOnQuestion('in_progress');
    await leftForTwoDays(issueId, runId, 'failed');
    const { selectFailedJobs } = await import('../../src/me/attention-failed-jobs.js');
    await harness.db.execute(
      sql`UPDATE agent_questions SET status = 'void' WHERE issue_id = ${issueId}`,
    );
    expect((await selectFailedJobs(ownerId)).map((r) => r.issueDocId)).toEqual([issueId]);
    await harness.db.execute(
      sql`UPDATE agent_questions SET status = 'open' WHERE issue_id = ${issueId}`,
    );
    await answerItsQuestion(issueId);
    expect(await selectFailedJobs(ownerId)).toEqual([]);
  });
});

describe('migration 0347 links the questions already standing at project level (criterion 203)', () => {
  async function standingQuestion(issueStatus: string, questionStatus: string) {
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, ${Math.floor(Math.random() * 1e6)}, 'Asked before the ruling',
              'in_progress', ${ownerId})
    `);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'failed')
    `);
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, failure_reason,
                        payload, finished_at)
      VALUES (${jobId}, ${projectId}, ${issueId}, ${runId}, ${ownerId}, 'drive', 'failed', 'stopped_on_question',
              '{}'::jsonb, now())
    `);
    const { questionIdFor } = await import('../../src/questions/pane-question-id.js');
    const { askQuestion } = await import('../../src/questions/write.js');
    const id = questionIdFor(jobId, 1);
    await askQuestion({
      id,
      projectId,
      prompt: 'Which database should the scratch migration target?',
      blockerKind: 'human',
      answer: { shape: 'free_text', needed: 'a database' },
    });
    await harness.db.execute(
      sql`UPDATE agent_questions SET status = ${questionStatus} WHERE id = ${id}`,
    );
    await harness.db.execute(
      sql`UPDATE issues SET status = ${issueStatus}, merged_at = CASE WHEN ${issueStatus} = 'closed' THEN now() END WHERE id = ${issueId}`,
    );
    return { id, issueId };
  }

  it('links each to the issue of the job that asked it, but no open one to a finished issue', async () => {
    const live = await standingQuestion('in_progress', 'open');
    const answered = await standingQuestion('closed', 'answered');
    const finished = await standingQuestion('closed', 'open');

    const migration = readFileSync(
      new URL('../../drizzle/migrations/0347_a_jobs_question_is_its_issues.sql', import.meta.url),
      'utf8',
    );
    await harness.db.execute(sql.raw(migration));

    const issueOf = async (id: string) =>
      (
        await harness.db.execute<{ issue_id: string | null }>(
          sql`SELECT issue_id FROM agent_questions WHERE id = ${id}`,
        )
      )[0]?.issue_id;
    expect(await issueOf(live.id)).toBe(live.issueId);
    expect(await issueOf(answered.id)).toBe(answered.issueId);
    expect(await issueOf(finished.id)).toBeNull();
  });
});
