/**
 * ISS-1410: a release act from an attempt that no longer holds its run is refused by name. A job
 * pane names its job on every call (`x-forge-job`, from `$FORGE_JOB`); dev.789's release attempts
 * 38611445 and d80cba45 were failed while their panes stood, and each next attempt was handed the
 * same run, so two sessions could push, tag and deploy one release while core refused nothing.
 * Planted through the app's own doors: a cut, its job failed and retried, and each attempt's acts.
 * ISS-1418: only a retry that has started on a box supersedes; dev.791's run 978499ba had its live
 * attempt 2 refused in favour of attempt 3, which was queued and cancelled without ever starting.
 *
 * @direct-test-of packages/core/src/release-batch/attempt-holds.ts
 * @direct-test-of packages/core/src/release-batch/routes.ts
 */

import { randomUUID } from 'node:crypto';
import { JOB_ACT_HEADER } from '@forge/contracts/jobs';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { api, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

const METHOD = { skill: 'release-flow', loaded: true };

/** A job status the box's and core's own paths write, set here as they would leave it. */
const setStatus = (jobId: string, status: 'dispatched' | 'failed') =>
  withKernelMarker(db, (tx) =>
    tx.execute(sql`
      UPDATE jobs SET status = ${status},
             dispatched_at = coalesce(dispatched_at, now()),
             finished_at = CASE WHEN ${status} = 'failed' THEN now() END
       WHERE id = ${jobId}
    `),
  );

describe('a release act names the attempt making it', () => {
  let projectId: string;
  let ownerId: string;
  let token: string;
  const fx = releaseWorld(() => ({ projectId, ownerId }));

  beforeEach(async () => {
    await truncateAll();
    ownerId = (await createTestUser({ verified: true })).id;
    projectId = (await createTestProject(ownerId)).id;
    token = await userToken(ownerId);
    await fx.seedReleaseRunner();
    const bindingId = await fx.declareProduction({}, 'none');
    await declareProductionDocument({ projectId, ownerId, bindingId, probes: 'none' });
  });

  /** A cut release run and the release job it minted, out on a box. */
  async function cut(): Promise<{ runId: string; first: string }> {
    const issueIds = [await fx.insertIssue()];
    const r = await api(token, 'POST', `/api/projects/${projectId}/release-batches`, { issueIds });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const runId = String(r.body.runId);
    const [job] = await rows<{ id: string }>(sql`
      SELECT id FROM jobs WHERE pipeline_run_id = ${runId} AND type = 'release_batch'
    `);
    if (!job) throw new Error('the cut minted no release job');
    await setStatus(job.id, 'dispatched');
    return { runId, first: job.id };
  }

  /** The box failed `first` on a false reading while its pane stood, and the run was retried. */
  async function retried(first: string): Promise<string> {
    const second = randomUUID();
    await setStatus(first, 'failed');
    await db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, payload,
                        attempts, retry_of, queued_at, dispatched_at)
      SELECT ${second}, project_id, pipeline_run_id, created_by, type, 'dispatched', payload,
             attempts + 1, id, now() + interval '1 second', now() + interval '1 second'
        FROM jobs WHERE id = ${first}
    `);
    return second;
  }

  const method = (runId: string, job?: string) =>
    api(
      token,
      'POST',
      `/api/projects/${projectId}/release-batches/${runId}/method`,
      METHOD,
      job === undefined ? {} : { [JOB_ACT_HEADER]: job },
    );

  const codeOf = (body: unknown): string | undefined =>
    (body as { error?: { refusals?: Array<{ code: string }> } }).error?.refusals?.[0]?.code;

  const detailOf = (body: unknown): string =>
    (body as { error?: { refusals?: Array<{ detail: string }> } }).error?.refusals?.[0]?.detail ??
    '';

  it("refuses the earlier attempt's act on a run a later attempt holds, naming the later one", async () => {
    const { runId, first } = await cut();
    const second = await retried(first);

    const refused = await method(runId, first);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(codeOf(refused.body)).toBe('RELEASE_ATTEMPT_SUPERSEDED');
    expect(detailOf(refused.body)).toContain(second);
    expect(detailOf(refused.body)).toContain('attempt 2');

    const taken = await method(runId, second);
    expect(taken.status, JSON.stringify(taken.body)).toBe(200);
  });

  it('refuses the same attempt at the deploy, the range report and the finish', async () => {
    const { runId, first } = await cut();
    await retried(first);
    const head = { [JOB_ACT_HEADER]: first };
    const acts = [
      api(
        token,
        'POST',
        `/api/projects/${projectId}/integrations/coolify/deploy`,
        { pipelineRunId: runId },
        head,
      ),
      api(
        token,
        'POST',
        `/api/projects/${projectId}/release-batches/${runId}/range`,
        { base: 'a'.repeat(40), head: 'b'.repeat(40), changes: [], files: [] },
        head,
      ),
      api(token, 'POST', `/api/projects/${projectId}/release-batches/${runId}/finish`, {}, head),
      api(
        token,
        'POST',
        `/api/projects/${projectId}/release-batches/${runId}/abort`,
        { reason: 'mine' },
        head,
      ),
    ];
    for (const r of await Promise.all(acts)) {
      expect(codeOf(r.body), JSON.stringify(r.body)).toBe('RELEASE_ATTEMPT_SUPERSEDED');
    }
  });

  /** A retry of `earlier` on the run, queued and not taken: the box holds it back while `earlier`'s pane stands. */
  async function queuedRetry(earlier: string): Promise<string> {
    const retry = randomUUID();
    await db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, payload,
                        attempts, retry_of, queued_at)
      SELECT ${retry}, project_id, pipeline_run_id, created_by, type, 'queued', payload,
             attempts + 1, id, now() + interval '2 seconds'
        FROM jobs WHERE id = ${earlier}
    `);
    return retry;
  }

  const finish = (runId: string, job: string) =>
    api(
      token,
      'POST',
      `/api/projects/${projectId}/release-batches/${runId}/finish`,
      {},
      { [JOB_ACT_HEADER]: job },
    );

  it("dev.791's run 978499ba: a retry that never started supersedes nothing, and the live earlier attempt still holds the run", async () => {
    const { runId, first } = await cut();
    // attempt 2 failed on a false "lost its pane" while its pane worked on; attempt 3 queued behind it
    const second = await retried(first);
    await setStatus(second, 'failed');
    const third = await queuedRetry(second);

    expect((await method(runId, second)).status).toBe(200);
    // dev.791 shipped on this finish, taken while attempt 3 still waited in the queue
    const finished = await finish(runId, second);
    expect(finished.status, JSON.stringify(finished.body)).toBe(202);
    expect((finished.body as { finish?: { state?: string } }).finish?.state).toBe('accepted');

    // attempt 3 was cancelled before any box took it: still nothing supersedes attempt 2
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE id = ${third}`,
      ),
    );
    expect((await method(runId, second)).status).toBe(200);
    // an attempt before the live one is still superseded, and the refusal names attempt 2
    const older = await method(runId, first);
    expect(codeOf(older.body), JSON.stringify(older.body)).toBe('RELEASE_ATTEMPT_SUPERSEDED');
    expect(detailOf(older.body)).toContain(second);
  });

  it('a retry that has started on a box supersedes the earlier attempt, naming the retry', async () => {
    const { runId, first } = await cut();
    const second = await retried(first);
    await setStatus(second, 'failed');
    const third = await queuedRetry(second);
    await setStatus(third, 'dispatched');

    const refused = await method(runId, second);
    expect(codeOf(refused.body), JSON.stringify(refused.body)).toBe('RELEASE_ATTEMPT_SUPERSEDED');
    expect(detailOf(refused.body)).toContain(third);
    expect(detailOf(refused.body)).toContain('attempt 3');
    expect(codeOf((await finish(runId, second)).body)).toBe('RELEASE_ATTEMPT_SUPERSEDED');

    // ended after starting, it still supersedes: the run is attempt 3's, and no attempt holds it
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE id = ${third}`,
      ),
    );
    expect(codeOf((await method(runId, second)).body)).toBe('RELEASE_ATTEMPT_SUPERSEDED');
    expect(codeOf((await method(runId, third)).body)).toBe('RELEASE_ATTEMPT_ENDED');
  });

  it('takes the attempt holding the run, a call naming no job, and a failed attempt no retry superseded', async () => {
    const { runId, first } = await cut();
    expect((await method(runId, first)).status).toBe(200);
    expect((await method(runId)).status).toBe(200);
    // an old runner fails live jobs on a false "lost its pane" (ISS-1411): failed alone stops nothing
    await setStatus(first, 'failed');
    expect((await method(runId, first)).status).toBe(200);
  });

  it('refuses an attempt whose cancel was requested, and a job that is no attempt of this run', async () => {
    const { runId, first } = await cut();
    await db.execute(sql`UPDATE jobs SET cancellation_requested = true WHERE id = ${first}`);
    const ended = await method(runId, first);
    expect(codeOf(ended.body), JSON.stringify(ended.body)).toBe('RELEASE_ATTEMPT_ENDED');

    const other = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${randomUUID()}, ${projectId}, 'interactive', 'running')
    `);
    await db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, payload)
      SELECT ${other}, ${projectId}, id, ${ownerId}, 'smoke', 'dispatched', '{}'::jsonb
        FROM pipeline_runs WHERE project_id = ${projectId} AND kind = 'interactive' LIMIT 1
    `);
    const elsewhere = await method(runId, other);
    expect(codeOf(elsewhere.body), JSON.stringify(elsewhere.body)).toBe(
      'RELEASE_ATTEMPT_NOT_ON_RUN',
    );
  });

  it('refuses a job header that is no job id, or names no job, by name', async () => {
    const { runId } = await cut();
    expect(codeOf((await method(runId, 'not-a-job')).body)).toBe('RELEASE_ATTEMPT_UNKNOWN');
    expect(codeOf((await method(runId, randomUUID())).body)).toBe('RELEASE_ATTEMPT_UNKNOWN');
  });
});
