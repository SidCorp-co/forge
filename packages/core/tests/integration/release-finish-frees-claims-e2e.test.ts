/**
 * A release that shipped holds nothing. Its finish closes what it can; an issue it cannot close (an
 * open question refuses `closed`, as it did on ISS-493 and ISS-456 for every dev release from
 * dev.231) stays at `awaiting_release` with its claim and its release step let go, so the next
 * release claims it without an abort. A run that promoted and recorded no ship still holds its
 * roster for a person, and the sweep keeps that hold. Against real Postgres, with production's
 * answer stubbed.
 *
 * @direct-test-of packages/core/src/release-batch/finish.ts
 * @direct-test-of packages/core/src/release-batch/releasing-recovery.ts
 * @direct-test-of packages/core/src/issues/release-claim.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  releaseEndedRunClaims,
  setWorkStep,
  type TransitionActor,
} from '../../src/issues/index.js';
import { askQuestion } from '../../src/questions/index.js';
import { finishReleaseBatch } from '../../src/release-batch/finish.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { releaseWorld } from '../helpers/release-world.js';

/** The commit production serves after the release's deploy. */
const SERVED = 'b'.repeat(40);

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

/** The release's deploy, recorded as the release job records it before it promotes. */
async function recordDeploy(runId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO release_attempts (run_id, stage, idempotency_key, verdict, settled_at)
    VALUES (${runId}, 'deploy', ${`deploy-${runId}`}, 'ok', now())
  `);
}

/** An issue at the gate holding a question a person has not answered: `closed` refuses it. */
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

async function shippedAt(runId: string): Promise<unknown> {
  const [row] = await rows<{ at: unknown }>(sql`
    SELECT release_released_at AS at FROM pipeline_runs WHERE id = ${runId}
  `);
  return row?.at ?? null;
}

async function lastComment(issueId: string): Promise<string | undefined> {
  const [row] = await rows<{ body: string }>(sql`
    SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at DESC LIMIT 1
  `);
  return row?.body;
}

/** A release run that ended `status` after its deploy, still claiming `issueId` at its release step. */
async function endedHolding(issueId: string, shipped: boolean): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version,
                               release_released_at, metadata)
    VALUES (${id}, ${projectId}, 'system', ${shipped ? 'completed' : 'failed'}, now(),
            ${shipped ? '0.4.0-dev.2' : '0.4.0-dev.1'}, ${shipped ? sql`now()` : null},
            ${JSON.stringify({ source: 'release-batch', issueIds: [issueId] })}::jsonb)
  `);
  await recordDeploy(id);
  await db.execute(sql`UPDATE issues SET release_batch_run_id = ${id} WHERE id = ${issueId}`);
  await setWorkStep(db, issueId, 'release');
  return id;
}

describe('a release that shipped lets go of what it could not close', () => {
  it('leaves the unclosed issue at the gate unclaimed, off its release step, and the next release claims it', async () => {
    const closes = await fx.insertIssue('awaiting_release');
    const asked = await askedAtTheGate();
    const { runId } = await fx.claim([closes, asked]);
    expect(await fx.stored(asked)).toMatchObject({ claim: runId, step: 'release' });
    await recordDeploy(runId);
    fx.serve(SERVED);

    const result = await finishReleaseBatch(runId, actor(), { commit: SERVED });

    expect(result.closed).toEqual([closes]);
    expect(result.failed.map((f) => f.id)).toEqual([asked]);
    expect(result.failed[0]?.reason).toContain('open question');
    expect(await shippedAt(runId)).not.toBeNull();
    expect(await fx.stored(asked)).toMatchObject({
      status: 'awaiting_release',
      claim: null,
      step: null,
    });
    expect(await lastComment(asked)).toContain(
      'The release shipped, so nothing holds this issue: it is at `awaiting_release` with its claim released',
    );

    const next = await fx.claim([asked]);

    expect(next.runId).not.toBe(runId);
    expect(await fx.stored(asked)).toMatchObject({ claim: next.runId, step: 'release' });
  });
});

describe('the sweep holds a promoted roster only while its run recorded no ship', () => {
  it('lets go of a roster a shipped run left claimed at its release step, and its step with it', async () => {
    const asked = await askedAtTheGate();
    await endedHolding(asked, true);

    await releaseEndedRunClaims();

    expect(await fx.stored(asked)).toMatchObject({
      status: 'awaiting_release',
      claim: null,
      step: null,
    });
  });

  it('keeps holding a roster whose run promoted and recorded no ship, for a person to settle', async () => {
    const asked = await askedAtTheGate();
    const failed = await endedHolding(asked, false);

    await releaseEndedRunClaims();

    expect(await fx.stored(asked)).toMatchObject({
      status: 'awaiting_release',
      claim: failed,
      step: 'release',
    });
  });
});
