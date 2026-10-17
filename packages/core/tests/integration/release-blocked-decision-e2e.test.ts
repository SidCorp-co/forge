/**
 * ISS-1366 — a release agent whose pane stops on a question carries it to a person, and the
 * release waits for the answer instead of asking again.
 *
 * Measured on portal-lighthuman: four release_batch jobs in an hour for one release, each asked
 * the same question in its own pane, each ended `Blocked` after 15 minutes, each retried by core 60
 * seconds later under the same run, the question on no issue and in no queue. The world here is that
 * project's shape — three issues at the gate, one release claimed, one job out with a box — against
 * real Postgres and the real job and release routes.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { pairDevice } from '../helpers/pair-device.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let deviceId: string;
let deviceToken: string;
let userToken: string;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

const DIALOG = {
  kind: 'dialog',
  questions: [
    {
      question: 'Staging is ahead of the roster.\nHow should the release go on?',
      header: 'Fork',
      multiSelect: false,
      options: [
        { label: 'Push + finish unverified', description: 'ship what is here (Recommended)' },
        { label: 'Also ship bb4fb368' },
        { label: 'Abort to gate' },
      ],
    },
  ],
} as const;

const BLOCKED_REASON =
  "the job's pane `forge-job-0af4b864` has been stopped on a question only a human can answer for 15m — nothing on this box answers a job pane's question, so that wait had no end of its own and the slot was holding it";

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  const [lifecycle, batch, err, hooksMod, subscriber] = await Promise.all([
    import('../../src/jobs/lifecycle-routes.js'),
    import('../../src/release-batch/routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/pipeline/hooks.js'),
    import('../../src/release-batch/decision-subscriber.js'),
  ]);
  subscriber.registerReleaseDecisionSubscriber(hooksMod.hooks);
  app = new Hono();
  app.route('/api/jobs', lifecycle.jobLifecycleDeviceRoutes);
  app.route('/api/jobs', lifecycle.jobLifecycleUserRoutes);
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.onError(err.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${ownerId}`);
  projectId = (await createTestProject(harness.db, ownerId)).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  await fx.declareProduction();
  await fx.seedReleaseRunner();
  const issued = await pairDevice({ ownerId, name: 'box', platform: 'linux' });
  deviceId = issued.device.id;
  deviceToken = issued.plaintext;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  userToken = await signUserToken(ownerId);
});

/** Three issues at the gate, one release claimed over them, and its job out with the box. */
async function runningRelease() {
  const ids = [await fx.insertIssue(), await fx.insertIssue(), await fx.insertIssue()];
  const released = await fx.claim(ids);
  await harness.db.execute(sql`
    UPDATE jobs SET status = 'running', device_id = ${deviceId}, dispatched_at = now(), acked_at = now()
     WHERE id = ${released.jobId}
  `);
  return { ids, ...released };
}

function post(path: string, token: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const blocked = (jobId: string, asked: unknown = DIALOG) =>
  post(`/api/jobs/${jobId}/blocked`, deviceToken, { error: BLOCKED_REASON, asked });

async function jobsOf(runId: string): Promise<Array<{ id: string; status: string }>> {
  const rows = await harness.db.execute(sql`
    SELECT id, status FROM jobs WHERE pipeline_run_id = ${runId} ORDER BY created_at
  `);
  return rows as unknown as Array<{ id: string; status: string }>;
}

function promptOf(row: { steps: Array<Record<string, unknown>> } | undefined): string {
  return String(row?.steps[0]?.prompt);
}

async function questionsOn(issueId: string | null) {
  const rows = await harness.db.execute(sql`
    SELECT id, status, blocker_kind, steps FROM agent_questions
     WHERE project_id = ${projectId}
       AND ${issueId === null ? sql`issue_id IS NULL` : sql`issue_id = ${issueId}`}
     ORDER BY id
  `);
  return rows as unknown as Array<{
    id: string;
    status: string;
    blocker_kind: string;
    steps: Array<Record<string, unknown>>;
  }>;
}

describe('a release agent stopped on a question, ended Blocked', () => {
  it('puts the question with its options on the first claimed issue, and nobody retries the job', async () => {
    const release = await runningRelease();

    const res = await blocked(release.jobId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.replayed).toBe(false);

    const [first, ...others] = release.ids as [string, ...string[]];
    const asked = await questionsOn(first);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.status).toBe('open');
    expect(asked[0]?.blocker_kind).toBe('human');
    const step = asked[0]?.steps[0] as {
      prompt: string;
      answerShape: string;
      options: Array<{ id: string; label: string }>;
      recommendedOptionId: string;
    };
    expect(step.prompt).toBe('Fork: Staging is ahead of the roster. How should the release go on?');
    expect(step.answerShape).toBe('choice');
    expect(step.options.map((o) => o.label)).toEqual([
      'Push + finish unverified — ship what is here (Recommended)',
      'Also ship bb4fb368',
      'Abort to gate',
    ]);
    expect(step.recommendedOptionId).toBe('o1');

    const pointers = await Promise.all(others.map((id) => fx.commentCount(id)));
    expect(pointers).toEqual([1, 1]);
    // Forge points the others at the question; the person who pressed Release said none of it.
    const authors = await harness.db.execute<{ kind: string; email: string }>(sql`
      SELECT u.kind, u.email FROM comments c JOIN users u ON u.id = c.author_id
      WHERE c.issue_id IN (${sql.join(
        others.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
    expect(authors).toEqual([
      { kind: 'agent', email: 'forge@agents.forge.invalid' },
      { kind: 'agent', email: 'forge@agents.forge.invalid' },
    ]);
    expect(await fx.commentCount(first)).toBe(0);

    const jobs = await jobsOf(release.runId);
    expect(jobs.map((j) => j.status).sort()).toEqual(['failed', 'held']);
    expect(await fx.runStatus(release.runId)).toBe('running');
    for (const id of release.ids) expect((await fx.stored(id)).status).toBe('releasing');
  });

  it('refuses a second release by name while the first one waits, saying where the question is', async () => {
    const release = await runningRelease();
    await blocked(release.jobId);
    const later = await fx.insertIssue();

    const { createReleaseBatch } = await import('../../src/release-batch/service.js');
    const { blockersOf } = await import('../../src/release-batch/blocker-sentences.js');
    const refusal = await createReleaseBatch({
      projectId,
      issueIds: [later],
      userId: ownerId,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    const inFlight = blockersOf(refusal).find((b) => b.code === 'BATCH_IN_FLIGHT');
    expect(inFlight).toBeDefined();
    const [firstShown] = await fx.displayIds([release.ids[0] as string]);
    expect(inFlight?.message).toContain('waiting on a decision');
    expect(inFlight?.message).toContain(`\`${firstShown}\``);
    expect((await jobsOf(release.runId)).filter((j) => j.status === 'queued')).toHaveLength(0);
  });

  it('is one decision however many times the same report arrives', async () => {
    const release = await runningRelease();
    const first = await (await blocked(release.jobId)).json();
    const again = await blocked(release.jobId);
    expect(again.status).toBe(200);
    const replay = await again.json();

    expect(replay.replayed).toBe(true);
    expect(replay.heldJobId).toBe(first.heldJobId);
    expect(replay.questionIds).toEqual(first.questionIds);
    expect(await questionsOn(release.ids[0] as string)).toHaveLength(1);
    expect(await fx.commentCount(release.ids[1] as string)).toBe(1);
    expect((await jobsOf(release.runId)).filter((j) => j.status === 'held')).toHaveLength(1);
  });

  it('reports the decision in the batch state, with each question, its options and where it stands', async () => {
    const release = await runningRelease();
    await blocked(release.jobId);

    const res = await app.request(
      `/api/projects/${projectId}/release-batches/${release.runId}/state`,
      {
        headers: { authorization: `Bearer ${userToken}` },
      },
    );
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.decision.phase).toBe('waiting');
    expect(state.decision.issue.id).toBe(release.ids[0]);
    expect(state.decision.questions).toHaveLength(1);
    expect(state.decision.questions[0].status).toBe('open');
    expect(state.decision.questions[0].options).toHaveLength(3);
    expect(state.decision.questions[0].recommendedOptionId).toBe('o1');
  });

  it('refuses an operator resume of the held job by name while its question is open', async () => {
    const release = await runningRelease();
    const { heldJobId } = await (await blocked(release.jobId)).json();

    const res = await post(`/api/jobs/${heldJobId}/resume`, userToken, {});
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DECISION_OPEN');
    expect((await jobsOf(release.runId)).filter((j) => j.status === 'held')).toHaveLength(1);
  });
});

describe('the decision is answered, or the release ends first', () => {
  const TWO = {
    kind: 'dialog',
    questions: [
      { question: 'Ship bb4fb368 too?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { question: 'Anything to tell the team?', options: [] },
    ],
  };

  async function answer(questionId: string, given: { optionId: string } | { text: string }) {
    const { answerQuestion } = await import('../../src/questions/write.js');
    return answerQuestion({
      questionId,
      answer:
        'optionId' in given
          ? { kind: 'option', optionId: given.optionId }
          : { kind: 'text', text: given.text },
      round: 1,
      by: ownerId,
      role: 'admin',
    });
  }

  it('requeues the held job once, with every answer in its prompt, and not before the last one', async () => {
    const release = await runningRelease();
    const { heldJobId, questionIds } = await (await blocked(release.jobId, TWO)).json();
    expect(questionIds).toHaveLength(2);

    await answer(questionIds[0], { optionId: 'o2' });
    expect((await jobsOf(release.runId)).find((j) => j.id === heldJobId)?.status).toBe('held');

    await answer(questionIds[1], { text: 'tell them staging moved' });
    await fx.waitFor(async () =>
      (await jobsOf(release.runId)).some((j) => j.id === heldJobId && j.status === 'queued'),
    );

    const rows = await harness.db.execute(sql`SELECT payload FROM jobs WHERE id = ${heldJobId}`);
    const payload = rows[0]?.payload as { promptString: string } | undefined;
    const prompt = String(payload?.promptString);
    expect(prompt).toContain('Decisions already given');
    expect(prompt).toContain('Answer: ');
    expect(prompt).toContain('No');
    expect(prompt).toContain('tell them staging moved');

    const { requeueOnAnswer } = await import('../../src/release-batch/decision-hold.js');
    expect(await requeueOnAnswer(questionIds[1])).toBe(false);
    expect((await jobsOf(release.runId)).filter((j) => j.status === 'queued')).toHaveLength(1);
  });

  it('voids the open question with the abort as its reason, and cancels the held job', async () => {
    const release = await runningRelease();
    const { heldJobId, questionIds } = await (await blocked(release.jobId)).json();

    const { abortReleaseBatch } = await import('../../src/release-batch/service.js');
    await abortReleaseBatch(release.runId, 'the owner changed the plan', ownerId);
    await fx.waitFor(
      async () => (await questionsOn(release.ids[0] as string))[0]?.status === 'void',
    );

    const rows = await harness.db.execute(sql`
      SELECT status, void_reason FROM agent_questions WHERE id = ${questionIds[0]}
    `);
    expect(rows[0]?.void_reason).toContain('aborted');
    expect(rows[0]?.void_reason).toContain('the owner changed the plan');
    expect((await jobsOf(release.runId)).find((j) => j.id === heldJobId)?.status).toBe('cancelled');
  });

  it('never requeues a cancelled job when the last answer races the abort', async () => {
    const release = await runningRelease();
    const { heldJobId, questionIds } = await (await blocked(release.jobId)).json();
    const { abortReleaseBatch } = await import('../../src/release-batch/service.js');

    await Promise.allSettled([
      answer(questionIds[0], { optionId: 'o1' }),
      abortReleaseBatch(release.runId, 'racing', ownerId),
    ]);
    await fx.waitFor(async () => (await fx.runStatus(release.runId)) === 'cancelled');
    await new Promise((r) => setTimeout(r, 200));

    const held = (await jobsOf(release.runId)).find((j) => j.id === heldJobId);
    expect(held?.status).toBe('cancelled');
  });
});

// ISS-1421 r5 — Releasing is not a state an issue waits in: the held recovery hands a release held
// on a decision back, and the question stays open on the issue it is asked on, holding that issue.
describe('a release handed back while it waits on a decision (criterion 67, 68)', () => {
  it('returns the roster to the gate, links the open question, and keeps it open after the run ends', async () => {
    const release = await runningRelease();
    const { questionIds } = await (await blocked(release.jobId)).json();
    const [first, second] = release.ids as [string, string, string];

    const { recoverHeldReleaseBatches } = await import('../../src/release-batch/held-recovery.js');
    expect(await recoverHeldReleaseBatches(new Date())).toEqual({ recovered: 1 });
    await fx.waitFor(async () => (await fx.runStatus(release.runId)) !== 'running');

    for (const id of release.ids) {
      expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    }
    const comments = await harness.db.execute<{ body: string }>(sql`
      SELECT body FROM comments WHERE issue_id = ${second} ORDER BY created_at DESC LIMIT 1
    `);
    expect(comments[0]?.body).toMatch(
      new RegExp(`The question stays open at https?://\\S+/projects/[^/\\s]+/issues/${first}\\.`),
    );
    expect(comments[0]?.body).toContain(`/releases/${release.runId}.`);

    // The run's end voids nothing: the question waits on the issue it is asked on.
    await new Promise((r) => setTimeout(r, 200));
    const asked = await questionsOn(first);
    expect(asked.map((q) => q.id)).toEqual(questionIds);
    expect(asked[0]?.status).toBe('open');

    const { rosterCloseShortfalls } = await import('../../src/release-batch/close-shortfall.js');
    const held = await rosterCloseShortfalls(projectId, [first, second]);
    expect(held.get(first)?.map((s) => s.code)).toContain('OPEN_QUESTIONS');
    expect(held.get(second)?.map((s) => s.code) ?? []).not.toContain('OPEN_QUESTIONS');
  });
});

describe('two moments the answer and the hold can meet', () => {
  it('leaves one held job when two reports of one blocked job are taken at the same moment', async () => {
    const release = await runningRelease();
    const { holdBlockedRelease } = await import('../../src/release-batch/decision-hold.js');
    const { jobs } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [job] = await harness.db.select().from(jobs).where(eq(jobs.id, release.jobId));

    const both = await Promise.all(
      [1, 2, 3].map(() => holdBlockedRelease(job as never, DIALOG as never)),
    );

    expect(new Set(both.map((h) => h?.heldJobId)).size).toBe(1);
    expect((await jobsOf(release.runId)).filter((j) => j.status === 'held')).toHaveLength(1);
    expect(await questionsOn(release.ids[0] as string)).toHaveLength(1);
  });

  it('hands an operator resume that lands after the last answer the answers, and requeues once', async () => {
    const release = await runningRelease();
    const { heldJobId, questionIds } = await (await blocked(release.jobId)).json();
    await harness.db.execute(sql`
      UPDATE agent_questions
         SET status = 'answered',
             steps = jsonb_set(steps, '{0,chosenOptionId}', '"o3"')
       WHERE id = ${questionIds[0]}
    `);

    const res = await post(`/api/jobs/${heldJobId}/resume`, userToken, {});
    expect(res.status).toBe(200);

    const rows = await harness.db.execute(
      sql`SELECT payload, status FROM jobs WHERE id = ${heldJobId}`,
    );
    const payload = rows[0]?.payload as { promptString: string } | undefined;
    expect(rows[0]?.status).toBe('queued');
    expect(String(payload?.promptString)).toContain('Decisions already given');
    expect(String(payload?.promptString)).toContain('Abort to gate');

    const { requeueOnAnswer } = await import('../../src/release-batch/decision-hold.js');
    expect(await requeueOnAnswer(questionIds[0])).toBe(false);
    expect((await jobsOf(release.runId)).filter((j) => j.status === 'queued')).toHaveLength(1);
  });
});

describe('an answer that reaches a release already ended', () => {
  it('leaves its held job as it is instead of requeueing it under a closed run', async () => {
    const release = await runningRelease();
    const { heldJobId, questionIds } = await (await blocked(release.jobId)).json();
    await harness.db.execute(
      sql`UPDATE pipeline_runs SET status = 'cancelled' WHERE id = ${release.runId}`,
    );

    const { answerQuestion } = await import('../../src/questions/write.js');
    await answerQuestion({
      questionId: questionIds[0],
      answer: { kind: 'option', optionId: 'o1' },
      round: 1,
      by: ownerId,
      role: 'admin',
    });
    await new Promise((r) => setTimeout(r, 200));

    expect((await jobsOf(release.runId)).find((j) => j.id === heldJobId)?.status).toBe('held');
  });
});

describe('a question the question screen refuses', () => {
  it('is carried as a free-text question naming the rule it broke, never dropped', async () => {
    const release = await runningRelease();
    const { writePaneQuestion, questionIdFor } = await import(
      '../../src/questions/pane-question-write.js'
    );
    const id = questionIdFor(release.jobId, 7);

    await harness.db.transaction(async (tx) => {
      await writePaneQuestion(tx as never, {
        id,
        projectId,
        issueId: release.ids[0] as string,
        pane: {
          prompt: 'two\nlines',
          answer: { shape: 'free_text', needed: 'your answer' },
        },
        who: 'release agent',
      });
    });

    const rows = await harness.db.execute(sql`SELECT steps FROM agent_questions WHERE id = ${id}`);
    const steps = rows[0]?.steps as Array<{ prompt: string; answerShape: string }> | undefined;
    const step = steps?.[0];
    expect(step?.answerShape).toBe('free_text');
    expect(step?.prompt).toContain('would not carry as written (single-line)');
  });
});

describe('a plain failure from a runner that reads nothing, and a job that is no release', () => {
  // ISS-1421 r6, criterion 94 — anhome's question b210f881 said only that the box could not read
  // what the agent asked, so nobody could answer it and the release waited on it. Refused by name.
  it('refuses the unreadable ask by name: no question, the release stopped, each issue told why', async () => {
    const release = await runningRelease();

    const res = await post(`/api/jobs/${release.jobId}/fail`, deviceToken, {
      error: BLOCKED_REASON,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retry.scheduled).toBe(false);
    expect(body.heldJobId).toBeNull();

    for (const id of release.ids) expect(await questionsOn(id)).toEqual([]);
    expect(await questionsOn(null)).toEqual([]);
    expect((await jobsOf(release.runId)).map((j) => j.status)).toEqual(['failed']);
    const [job] = (await harness.db.execute(sql`
      SELECT error FROM jobs WHERE id = ${release.jobId}
    `)) as unknown as Array<{ error: string }>;
    expect(job?.error).toMatch(/^RELEASE_ASK_UNREADABLE: The release agent stopped on a question Forge could not read/);
    expect(await fx.runStatus(release.runId)).not.toBe('running');
    for (const id of release.ids) {
      expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
      const [said] = (await harness.db.execute(sql`
        SELECT string_agg(body, E'\n') AS body FROM comments WHERE issue_id = ${id}
      `)) as unknown as Array<{ body: string }>;
      expect(said?.body).toContain('stopped on a question Forge could not read');
      expect(said?.body).toContain('No question was written, since nobody could answer it');
      expect(said?.body).toContain('Start the next release from Awaiting release.');
    }
  });

  it('the same refusal through the blocked door, from a runner that names why it could not read', async () => {
    const release = await runningRelease();

    const res = await blocked(release.jobId, { kind: 'unread', why: 'the transcript was cut' });
    expect(res.status).toBe(200);
    expect((await res.json()).heldJobId).toBeNull();
    for (const id of release.ids) expect(await questionsOn(id)).toEqual([]);
    expect(await fx.stored(release.ids[0] as string)).toMatchObject({ status: 'awaiting_release' });
  });

  it('carries the question of a smoke job at project level and does not retry it', async () => {
    const runId = randomUUID();
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
      VALUES (${runId}, ${projectId}, 'system', 'running', '{"source":"smoke"}'::jsonb)
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, device_id, created_by, type, status, acked_at, payload)
      VALUES (${jobId}, ${projectId}, ${runId}, ${deviceId}, ${ownerId}, 'smoke', 'running', now(), '{}'::jsonb)
    `);

    const res = await blocked(jobId, {
      kind: 'permission',
      tool: 'Bash',
      input: '{"command":"rm -rf build"}',
    });
    expect(res.status).toBe(200);

    const asked = await questionsOn(null);
    expect(asked).toHaveLength(1);
    expect(promptOf(asked[0])).toContain('Bash');
    expect((await jobsOf(runId)).map((j) => j.status)).toEqual(['failed']);
  });
});
