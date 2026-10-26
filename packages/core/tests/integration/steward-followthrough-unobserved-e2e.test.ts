// adminhub-fe ISS-36, 2026-10-26: a landing recorded on `release/stg` shipped the issue, and the
// steward's release follow-through was briefed to "judge each carried criterion on the running build
// and record a verdict (identity `runtime`)" on a project that declares no production environment.
// Nothing runs there that Forge observes; its job recorded a runtime pass over every criterion its
// judge had passed at the landing. The brief is chosen by what runs: where no running build is
// observed it judges nothing, and every steward job carries the project's release facts.
//
// @direct-test-of packages/core/src/steward/job.ts
// @direct-test-of packages/core/src/steward/prompts.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { seedProduction, seedProjectDocument } from '../helpers/release-world.js';

let ownerId = '';
let seq = 30;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** The brief a release follow-through job on a freshly shipped issue of `projectId` is queued with. */
async function followthroughBrief(projectId: string): Promise<string> {
  await bindTestRunner(projectId, await createTestDevice(ownerId));
  seq += 1;
  const issue = await createTestIssue(projectId, ownerId, seq, {
    status: 'closed',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  const [made] = await rows<{ id: string }>(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                              state, not_before, started_at)
    VALUES (${projectId}, 'issue', ${issue.id}, ${issue.key}, 'release.shipped', '[]'::jsonb,
            ARRAY['release_followthrough']::text[], 'running', now(), now())
    RETURNING id`);
  const { enqueueStewardJob } = await import('../../src/steward/job.js');
  const { db } = await import('../../src/db/client.js');
  const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
  const { eq } = await import('drizzle-orm');
  const [run] = await db
    .select()
    .from(stewardRuns)
    .where(eq(stewardRuns.id, made?.id ?? ''));
  if (!run) throw new Error('the run row was not written');
  const started = await enqueueStewardJob(run, ['release_followthrough']);
  if (!started.ok) throw new Error(started.failure);
  const [job] = await rows<{ prompt: string }>(sql`
    SELECT payload ->> 'promptString' AS prompt FROM jobs WHERE id = ${started.jobId}`);
  return job?.prompt ?? '';
}

describe('a release follow-through is briefed by what runs', () => {
  it('judges nothing on a project with no production environment, and is told so', async () => {
    const projectId = (await createTestProject(ownerId)).id;
    await seedProjectDocument(projectId, ownerId, {
      environments: {},
      defaultBranch: 'release/stg',
      extra: { release: { approval: { required: true }, changeRequests: false } },
    });
    const brief = await followthroughBrief(projectId);

    expect(brief).toContain('Judge nothing and record no verdict');
    expect(brief).not.toContain('identity `runtime`');
    expect(brief).toContain(
      "This project declares no production environment: its running build is each issue's landing on `release/stg`.",
    );
  });

  it('judges the running build where production is declared and bound', async () => {
    const projectId = (await createTestProject(ownerId)).id;
    await seedProduction({ projectId, ownerId, probes: 'none' });
    const brief = await followthroughBrief(projectId);

    expect(brief).toContain(
      'Judge each carried criterion on the running build and record a verdict (`POST /api/issues/<id>/verdicts`, identity `runtime`).',
    );
    expect(brief).toContain('This project has a production environment');
  });
});
