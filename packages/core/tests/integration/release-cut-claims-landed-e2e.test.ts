/**
 * ISS-888 (forge, 2026-11-02: six issues sat at `awaiting_release`, deployed and claimed by no cut,
 * until the master recorded each by hand). Two shapes left a landed issue waiting on a hold nobody was
 * told about:
 *
 * - a landing marked merged after the cut that shipped it, which that cut's roster never named;
 * - a release aborted "nothing to release: X shipped in V", whose roster was held for a person.
 *
 * Now the finish of the release that holds a late-marked landing records it as shipped in the version
 * it ships, by the rule a shipped-in record is held to; an abort over an already-shipped roster records
 * it on the release the run names, or holds it for its agent naming that record, never for a person;
 * and the master reads every hold whose act is its own. Against real Postgres.
 *
 * @direct-test-of packages/core/src/release-batch/shipped-in.ts
 * @direct-test-of packages/core/src/release-batch/shipped-in-runs.ts
 * @direct-test-of packages/core/src/release-batch/agent-owed-holds.ts
 * @direct-test-of packages/core/src/release-batch/finish.ts
 * @direct-test-of packages/core/src/release-batch/close-roster.ts
 * @direct-test-of packages/core/src/release-batch/hold.ts
 * @direct-test-of packages/core/src/release-batch/routes.ts
 * @direct-test-of packages/core/src/release-batch/prompt.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import type { TransitionActor } from '../../src/issues/index.js';
import { owedLine } from '../../src/masters/owed.js';
import { mastersPorts } from '../../src/masters/ports.js';
import { shippedReleasesOf } from '../../src/pipeline/index.js';
import { askQuestion } from '../../src/questions/index.js';
import { finishReleaseBatch } from '../../src/release-batch/finish.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { A, C1, markTrailWorld } from '../helpers/mark-trail-world.js';
import { releaseWorld, seedProductionDeployTrigger } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
let token: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));
const { claim: markAt } = markTrailWorld();

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
  token = await userToken(ownerId);
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await fx.seedReleaseRunner();
});

const actor = (): TransitionActor => ({ type: 'user', id: ownerId, agency: 'agent' });
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;

const shippedIn = async (id: string) =>
  ((await shippedReleasesOf(projectId, [id])).get(id) as { version?: string } | undefined)
    ?.version ?? null;

/** A release that shipped, cut `cutAgo` minutes ago, its finish naming `commit`. */
async function shipped(version: string, commit: string, cutAgo: number): Promise<string> {
  const id = randomUUID();
  const at = minutesAgo(cutAgo);
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, created_at, release_version,
                               release_released_at, metadata)
    VALUES (${id}, ${projectId}, 'system', 'completed', ${at}::timestamptz, ${at}::timestamptz,
            ${version}, ${at}::timestamptz,
            ${JSON.stringify({ source: 'release-batch', finish: { requestId: randomUUID(), state: 'finished', commit, version: 1 } })}::jsonb)
  `);
  return id;
}

/** An issue at the gate that landed `landedAgo` minutes ago; its mark is written separately. */
async function landed(landedAgo: number): Promise<string> {
  const id = await fx.insertIssue('awaiting_release');
  await db.execute(
    sql`UPDATE issues SET merged_commit_sha = ${A}, merged_at = ${minutesAgo(landedAgo)}::timestamptz WHERE id = ${id}`,
  );
  return id;
}

/** The mark on `id`, written `ago` minutes ago. */
async function markedAgo(id: string, ago: number): Promise<void> {
  await markAt(id, A);
  await db.execute(
    sql`UPDATE activity_log SET created_at = ${minutesAgo(ago)}::timestamptz WHERE issue_id = ${id}`,
  );
}

/** A cut of `roster` whose run reads as cut `cutAgo` minutes ago. */
async function cutAgo(roster: string[], ago: number): Promise<{ runId: string; version: string }> {
  const { runId, version } = await fx.claim(roster);
  await db.execute(
    sql`UPDATE pipeline_runs SET created_at = ${minutesAgo(ago)}::timestamptz WHERE id = ${runId}`,
  );
  return { runId, version };
}

const agentHolds = () => mastersPorts().releaseHoldsOwed(projectId);

describe('a landing marked merged after the cut that shipped it (ISS-888 shape 1)', () => {
  it("is recorded as shipped in the version that cut ships, by that release's finish", async () => {
    const roster = await landed(150);
    await markedAgo(roster, 140);
    const late = await landed(120);
    const { runId, version } = await cutAgo([roster], 60);
    // the agent marks its landing only now, after the cut that already carries its commit
    await markAt(late, A);

    const result = await finishReleaseBatch(runId, actor());

    expect(result.closed).toEqual([roster]);
    expect(await statusOf(late), 'the late-marked landing the release holds').toBe('closed');
    expect(await shippedIn(late)).toBe(version);
    expect(await fx.holdOf(late)).toBeNull();
    const [meta] = await rows<{ late: { claimed: string[]; leftOut: unknown[] } }>(
      sql`SELECT metadata -> 'lateMarks' AS late FROM pipeline_runs WHERE id = ${runId}`,
    );
    expect(meta?.late).toEqual({ claimed: [late], leftOut: [] });
  });

  it('leaves a landing made after the cut, or marked before it, to the releases that own it', async () => {
    const roster = await landed(150);
    await markedAgo(roster, 140);
    const after = await landed(30);
    await markAt(after, A);
    const before = await landed(120);
    await markedAgo(before, 90);
    const { runId } = await cutAgo([roster], 60);

    await finishReleaseBatch(runId, actor());

    expect(await statusOf(after), 'landed after the cut: the cut cannot hold it').toBe(
      'awaiting_release',
    );
    expect(await statusOf(before), 'marked before the cut: its roster chose not to name it').toBe(
      'awaiting_release',
    );
  });

  it('names one it cannot close, held for its agent with the command, and the master reads it', async () => {
    const roster = await landed(150);
    await markedAgo(roster, 140);
    const late = await landed(120);
    const { runId, version } = await cutAgo([roster], 60);
    await markAt(late, A);
    await askQuestion({
      id: randomUUID(),
      projectId,
      issueId: late,
      prompt: 'Does the late one still ship?',
      blockerKind: 'human',
      answer: { shape: 'free_text', needed: 'a yes or no', recommended: 'Yes.' },
    });

    await finishReleaseBatch(runId, actor());

    expect(await statusOf(late)).toBe('awaiting_release');
    const hold = await fx.holdOf(late);
    expect(hold).toMatchObject({ code: 'RELEASE_SHIPPED_IN_OWED', owes: 'agent' });
    expect(hold?.reason).toContain(version);
    expect(hold?.reason).toContain('could not record it');
    expect(hold?.reason).toContain('shipped-in-records');
    const [meta] = await rows<{ late: { leftOut: Array<{ issueId: string; owes: string }> } }>(
      sql`SELECT metadata -> 'lateMarks' AS late FROM pipeline_runs WHERE id = ${runId}`,
    );
    expect(meta?.late.leftOut).toMatchObject([{ issueId: late, owes: 'agent' }]);

    const owed = await agentHolds();
    expect(owed.map((h) => [h.issueId, h.code])).toEqual([[late, 'RELEASE_SHIPPED_IN_OWED']]);
    expect(owedLine({ ...NONE, releaseHolds: owed })).toContain('shipped-in-records -X POST');
  });
});

describe('an abort over a roster an earlier release already shipped (ISS-888 shape 2)', () => {
  /** V shipped after X landed and did not carry it; a later cut took X and its run found nothing new. */
  async function abortedOverShipped(body: Record<string, unknown>) {
    await shipped('0.4.0-dev.1', C1, 60);
    const x = await landed(120);
    await markedAgo(x, 90);
    const { runId, jobId } = await fx.claim([x]);
    const [job] = await rows<{ prompt: string }>(
      sql`SELECT payload ->> 'promptString' AS prompt FROM jobs WHERE id = ${jobId}`,
    );
    expect(
      job?.prompt,
      'the release run is told how to name the release that shipped it',
    ).toContain('"shippedIn":{"version":"<that release>"');
    const aborted = await api(
      token,
      'POST',
      `/api/projects/${projectId}/release-batches/${runId}/abort`,
      {
        reason: 'nothing to release: its work shipped in 0.4.0-dev.1',
        blocker: { owes: 'human', waitingFor: 'a person to decide what this roster ships' },
        pushed: false,
        ...body,
      },
    );
    return { x, aborted };
  }

  it('holds the issue for its agent naming the shipped-in record, never for a person', async () => {
    const { x, aborted } = await abortedOverShipped({});

    expect(aborted.status, JSON.stringify(aborted.body)).toBe(200);
    expect(aborted.body).toMatchObject({ heldForPerson: [], shippedInOwed: [x] });
    const hold = await fx.holdOf(x);
    expect(hold).toMatchObject({ code: 'RELEASE_SHIPPED_IN_OWED', owes: 'agent' });
    expect(hold?.reason).toContain('0.4.0-dev.1');
    expect(hold?.reason).toContain('shipped-in-records');

    // the sweep does not cut it into the same abort again
    await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
    await sweepAutomaticReleases();
    expect(await fx.stored(x)).toMatchObject({ status: 'awaiting_release', claim: null });
    expect((await fx.holdOf(x))?.code).toBe('RELEASE_SHIPPED_IN_OWED');

    const owed = await agentHolds();
    expect(owed.map((h) => h.issueId)).toEqual([x]);
  });

  it('records the roster on the release the run names, closing it there', async () => {
    const { x, aborted } = await abortedOverShipped({
      shippedIn: {
        version: '0.4.0-dev.1',
        evidence: `git merge-base --is-ancestor ${A} ${C1} answered 0`,
      },
    });

    expect(aborted.status, JSON.stringify(aborted.body)).toBe(200);
    expect(aborted.body).toMatchObject({ heldForPerson: [], shippedInRecorded: [x] });
    expect(await statusOf(x)).toBe('closed');
    expect(await shippedIn(x)).toBe('0.4.0-dev.1');
    expect(await agentHolds()).toEqual([]);
  });

  it('still holds for the person a roster no shipped release could hold', async () => {
    const x = await landed(120);
    await markedAgo(x, 90);
    const { runId } = await fx.claim([x]);
    const aborted = await api(
      token,
      'POST',
      `/api/projects/${projectId}/release-batches/${runId}/abort`,
      {
        reason: 'the deploy credential expired',
        blocker: { owes: 'human', waitingFor: 'a person to renew the deploy credential' },
        pushed: false,
      },
    );

    expect(aborted.status, JSON.stringify(aborted.body)).toBe(200);
    expect(aborted.body).toMatchObject({ heldForPerson: [x], shippedInOwed: [] });
    expect(await fx.holdOf(x)).toMatchObject({ code: 'RELEASE_ABORT_BLOCKED', owes: 'human' });
    expect(await agentHolds(), 'a person owes it, so the master is not told it').toEqual([]);
  });
});

const NONE: Parameters<typeof owedLine>[0] = {
  designs: [],
  revisions: [],
  breakdowns: [],
  triages: [],
  confirms: [],
  comments: [],
  documents: [],
  builderRuns: [],
  releaseNotes: [],
  warnedNotes: [],
  unnamedReleases: [],
  releaseMerges: [],
  releaseApprovals: [],
  releaseActs: [],
  answers: [],
  stewardAsks: [],
  questions: [],
  landedWork: [],
  marks: [],
  filings: [],
  recordings: [],
  releaseHolds: [],
  endedRunHolds: [],
  requests: [],
  carriers: [],
  reviews: [],
  contentLanguage: 'en',
};
