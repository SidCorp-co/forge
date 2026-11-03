/**
 * ISS-928 (d): every path that still ends a release run `failed` writes its code and its reason. One
 * test per writer, each driving the writer itself against real Postgres and reading the failure back
 * the way the release page and the repair read it (`release-repair.ts:readRunFailure`): the finish
 * that closed none of its roster, the record that closed none, a deploy that failed under a close,
 * a cut that lost its claim, and the kernel's close of an unshipped release asked to end otherwise.
 * That no writer can drop the cause is the compiler's (`pipeline/run-end.test.ts`).
 *
 * @direct-test-of packages/core/src/release-batch/finish.ts
 * @direct-test-of packages/core/src/release-batch/recorded.ts
 * @direct-test-of packages/core/src/release-batch/claim-conflicts.ts
 * @direct-test-of packages/core/src/pipeline/runs.ts
 * @direct-test-of packages/core/src/pipeline/runs-cascade.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import type { TransitionActor } from '../../src/issues/index.js';
import { closeRun, closeRunIfOneShot } from '../../src/pipeline/index.js';
import { askQuestion } from '../../src/questions/index.js';
import { claimRoster } from '../../src/release-batch/claim-conflicts.js';
import { finishReleaseBatch } from '../../src/release-batch/finish.js';
import { endRecordRun } from '../../src/release-batch/recorded.js';
import { readRunFailure } from '../../src/release-batch/release-repair.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { releaseWorld } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await fx.seedReleaseRunner();
});

const actor = (): TransitionActor => ({ type: 'user', id: ownerId, agency: 'human' });

/** The run as it ended, and the failure it carries as every reader reads it. */
async function ended(runId: string) {
  const [run] = await rows<{ status: string; released: unknown; metadata: unknown }>(sql`
    SELECT status, release_released_at AS released, metadata FROM pipeline_runs WHERE id = ${runId}`);
  return {
    status: run?.status,
    released: run?.released ?? null,
    failure: readRunFailure(run?.metadata),
  };
}

/** A release run open at its release step, wearing `version`, holding nothing. */
async function openRelease(version: string, source = 'release-batch'): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, metadata)
    VALUES (${id}, ${projectId}, 'system', 'running', now(), ${version},
            ${JSON.stringify({ source, issueIds: [] })}::jsonb)`);
  return id;
}

async function askedAtTheGate(): Promise<string> {
  const id = await fx.insertIssue('awaiting_release');
  await askQuestion({
    id: randomUUID(),
    projectId,
    issueId: id,
    prompt: 'Is Half half of the large width?',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the width rule', recommended: 'Half of the page.' },
  });
  return id;
}

describe('every failed end of a release run names its code and reason', () => {
  it('a finish that closed none of its roster: release_closed_none, naming each refusal', async () => {
    const asked = await askedAtTheGate();
    const { runId } = await fx.claim([asked]);
    await finishReleaseBatch(runId, actor());
    const run = await ended(runId);
    expect(run).toMatchObject({ status: 'failed', released: null });
    expect(run.failure).toMatchObject({ code: 'release_closed_none' });
    expect(run.failure?.detail).toContain(asked);
    expect(run.failure?.detail).toContain('open question');
  });

  it('a record that closed none and stands on nothing else: release_record_incomplete', async () => {
    const runId = await openRelease('0.7.0', 'release-record');
    const stuck = randomUUID();
    await endRecordRun(runId, '0.7.0', {
      closed: [],
      failed: [{ id: stuck, reason: 'an open question refuses the close' }],
    });
    const run = await ended(runId);
    expect(run).toMatchObject({ status: 'failed', released: null });
    expect(run.failure).toMatchObject({ code: 'release_record_incomplete' });
    expect(run.failure?.detail).toContain(stuck);
  });

  it('a close asked `completed` while a deploy it dispatched failed: deploy_failed', async () => {
    const runId = await openRelease('0.7.1');
    await db.execute(sql`
      UPDATE pipeline_runs SET metadata = metadata || ${JSON.stringify({
        __forge_deploy_confirm: {
          'target:prod': {
            bindingId: randomUUID(),
            deploymentUuid: 'dep-1',
            targetLabel: 'production',
            status: 'failed',
            deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            detail: 'the build exited 1',
          },
        },
      })}::jsonb WHERE id = ${runId}`);
    expect(await closeRun(runId, 'completed')).toBe('settled');
    const run = await ended(runId);
    expect(run.status).toBe('failed');
    expect(run.failure).toMatchObject({ code: 'deploy_failed' });
    expect(run.failure?.detail).toContain('the build exited 1');
  });

  it('a cut that lost a claim to another release: CLAIM_CONFLICT, naming who holds it', async () => {
    const issue = await fx.insertIssue('awaiting_release');
    const holder = await fx.claim([issue]);
    const runId = await openRelease('0.7.2');
    await expect(claimRoster(projectId, [issue], runId)).rejects.toThrow(/CLAIM_CONFLICT/);
    const run = await ended(runId);
    expect(run.status).toBe('failed');
    expect(run.failure).toMatchObject({ code: 'CLAIM_CONFLICT' });
    expect(run.failure?.detail.length).toBeGreaterThan(0);
    expect(holder.runId).not.toBe(runId);
  });

  it('an unshipped release asked to close `completed`: release_not_shipped', async () => {
    const runId = await openRelease('0.7.3');
    await closeRunIfOneShot(runId, 'completed');
    const run = await ended(runId);
    expect(run).toMatchObject({ status: 'failed', released: null });
    expect(run.failure).toMatchObject({ code: 'release_not_shipped' });
    expect(run.failure?.detail).toContain('0.7.3');
  });

  it('an unshipped release cancelled with no abort: release_cancelled_without_abort', async () => {
    const runId = await openRelease('0.7.4');
    await closeRunIfOneShot(runId, 'cancelled');
    const run = await ended(runId);
    expect(run).toMatchObject({ status: 'failed', released: null });
    expect(run.failure).toMatchObject({ code: 'release_cancelled_without_abort' });
    expect(run.failure?.detail).toContain('0.7.4');
  });
});
