/**
 * A job pane its own project refused ends on that refusal, by name and once (sidcorp-mail on
 * sid-xeon-1-dev, 2026-10-28). The box's stored token was fenced to forge, hop and autoflow, every
 * release job's first call was refused `PAT_PROJECT_OUTSIDE_FENCE`, the agent stopped as its brief
 * says, and the box ended each job 15 minutes later as a pane that "reported nothing" — which core
 * read as infra and retried: 23 failed jobs on three runs, every one refused the same way.
 *
 * The runner now ends such a job on the refusal, leading its reason with `[CREDENTIAL_REFUSED]`
 * (`runner-core/src/job_exit.rs:credential_refused_reason`); core reads it as terminal, keeps the
 * refusal's code in its reason, and schedules no retry. The silence ending stays a retry: it is
 * what a pane that may have been working leaves.
 *
 * @direct-test-of packages/core/src/pipeline/failure-classifier.ts
 * @direct-test-of packages/core/src/pipeline/failure-patterns.ts
 * @direct-test-of packages/contracts/src/failure-causes.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { classifyFailure } from '../../src/pipeline/index.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

let say: (who: 'box', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let box = '';

// the runner's sentence, as `job_exit::credential_refused_reason` writes it for the 2026-10-28 pane
const REFUSED =
  '[CREDENTIAL_REFUSED] PAT_PROJECT_OUTSIDE_FENCE: the job\'s pane `forge-job-5e615ddd` was refused on its own project\'s credential — PAT_PROJECT_OUTSIDE_FENCE: this request came on token "dev-runner-box sid-xeon-1-dev forge+hop+autoflow" (fc4fe551), which reaches forge, hop, autoflow; the path names project a417a126, which it does not reach — so nothing it does can be recorded, and the same job on this box would be refused the same way; give the box a credential that reaches the project (re-provision its checkout) before running it again';
const SILENT =
  "the job's pane `forge-job-a6b5ce7f` has reported nothing since its agent ended a turn 15m ago — a job pane is briefed once and has nothing left to do after its last turn, so the slot it held was holding a finished agent and not work in flight";

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { issueDeviceCredential } = await import('../../src/devices/credential.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  box = await createTestDevice(ownerId);
  await bindTestRunner(projectId, box);
  say = requester(app, {
    box: await issueDeviceCredential({ deviceId: box, holderUserId: ownerId }),
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** A release job out on `box`, as a box that took it from the pool leaves it. */
async function dispatchedReleaseJob(): Promise<string> {
  const runId = randomUUID();
  const jobId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, device_id, payload,
                      dispatched_at)
    VALUES (${jobId}, ${projectId}, ${runId}, ${ownerId}, 'release_batch', 'dispatched', ${box},
            '{}'::jsonb, now())
  `);
  return jobId;
}

async function rowOf(jobId: string) {
  const [row] = await rows<{
    status: string;
    failure_kind: string | null;
    failure_action: string | null;
    failure_reason: string | null;
    retries: number;
  }>(sql`
    SELECT status, failure_kind, failure_action, failure_reason,
           (SELECT count(*)::int FROM jobs r WHERE r.retry_of = ${jobId}) AS retries
      FROM jobs WHERE id = ${jobId}`);
  return row;
}

describe("a job its pane's own project refused", () => {
  it('is classified terminal, by its own cause, keeping the refusal code', () => {
    const verdict = classifyFailure({ error: REFUSED });
    expect([verdict.kind, verdict.cause, verdict.action]).toEqual([
      'infra',
      'credential_refused',
      'terminal',
    ]);
    expect(verdict.reason).toContain('PAT_PROJECT_OUTSIDE_FENCE');
    expect(verdict.meta?.needsReview).toBeUndefined();
  });

  it('ends failed once, with no retry, when its box reports the refusal', async () => {
    const jobId = await dispatchedReleaseJob();
    const failed = ok(await say('box', 'POST', `/api/jobs/${jobId}/fail`, { error: REFUSED }));
    expect(failed).toMatchObject({ status: 'failed', retry: { scheduled: false } });
    const row = await rowOf(jobId);
    expect([row?.status, row?.failure_kind, row?.failure_action, row?.retries]).toEqual([
      'failed',
      'infra',
      'terminal',
      0,
    ]);
    expect(row?.failure_reason).toContain('PAT_PROJECT_OUTSIDE_FENCE');
  });
});

describe('a job that ended on its silence', () => {
  it('is still retried: a pane that reported nothing may have been working', async () => {
    expect(classifyFailure({ error: SILENT }).action).toBe('retry');
    const jobId = await dispatchedReleaseJob();
    ok(await say('box', 'POST', `/api/jobs/${jobId}/fail`, { error: SILENT }));
    const row = await rowOf(jobId);
    expect([row?.failure_action, row?.retries]).toEqual(['retry', 1]);
  });
});
