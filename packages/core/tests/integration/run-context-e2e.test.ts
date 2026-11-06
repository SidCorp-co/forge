/**
 * ISS-1065: nothing recorded which rules, knowledge, lessons or memories reached a run, so a wrong
 * action could not be traced to the text its agent was given. Core now records each reach against
 * the run session and its issue, and `GET /api/projects/:id/run-context` answers them. Against real
 * Postgres.
 *
 * @direct-test-of packages/core/src/run-context/record.ts
 * @direct-test-of packages/core/src/run-context/hook.ts
 * @direct-test-of packages/core/src/run-context/read.ts
 * @direct-test-of packages/core/src/run-context/routes.ts
 * @direct-test-of packages/core/src/run-context/sources.ts
 * @direct-test-of packages/core/src/run-context-ports.ts
 * @direct-test-of packages/core/src/prompt/carried.ts
 * @direct-test-of packages/core/src/prompt/system.ts
 * @direct-test-of packages/core/src/jobs/prepare-claimed-job.ts
 * @direct-test-of packages/core/src/knowledge/routes.ts
 * @direct-test-of packages/core/src/memory/search-routes.ts
 */

import type { RunContextReach, RunContextView } from '@forge/contracts/run-context';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { backgroundSettled } from '../../src/lib/background.js';
import { declareOutboxQueues } from '../../src/outbox/queues.js';
import { isBossStarted, startBoss } from '../../src/queue/boss.js';
import { recordOrientationCarried } from '../../src/run-context-ports.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestRunSession,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { pairTestBox } from '../helpers/paired-box.js';

const RULE = 'Delete by literal path, never through a variable.';
const GUIDE = 'Build with pnpm build, then run the direct tests.';
const LESSON = 'A judge reads the running build, never the diff.';
const MEMORY = 'The release cut aborted on dev.537 because the fragments folder was empty.';

const w = {
  projectId: '',
  issueId: '',
  deviceId: '',
  box: '',
  owner: '',
  sessionId: '',
  lessonSlug: 'lesson-1',
  memoryId: '',
};

async function kernel(statement: ReturnType<typeof sql>) {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) => tx.execute(statement));
}

async function seedKnowledge(
  kind: string,
  slug: string,
  body: string,
  injection: string,
  metadata = {},
) {
  await db.execute(sql`
    INSERT INTO knowledge_entries (project_id, kind, slug, title, body, injection, metadata)
    VALUES (${w.projectId}, ${kind}, ${slug}, ${slug}, ${body}, ${injection}, ${JSON.stringify(metadata)}::jsonb)
  `);
}

/** A `drive` job on the issue, claimed on the box: its prompt is composed and its session opened. */
async function claimDriveJob(): Promise<string> {
  const [run] = await rows<{ id: string }>(sql`
    INSERT INTO pipeline_runs (project_id, kind, status) VALUES (${w.projectId}, 'system', 'running')
    RETURNING id`);
  const [job] = await rows<{ id: string }>(sql`
    INSERT INTO jobs (project_id, issue_id, pipeline_run_id, created_by, type, payload, status)
    VALUES (${w.projectId}, ${w.issueId}, ${run?.id}, ${w.owner}, 'drive',
            ${JSON.stringify({ promptString: 'Work ISS-7.' })}::jsonb, 'queued')
    RETURNING id`);
  const { prepareClaimedJob } = await import('../../src/jobs/prepare-claimed-job.js');
  const policy = {
    revision: 1,
    qa: 'none',
    status: 'in_progress',
    from: 'job',
    model: 'opus',
    profile: 'default',
    deniedTools: [],
  };
  const prepared = await prepareClaimedJob({
    jobId: job?.id as string,
    deviceId: w.deviceId,
    policy: policy as unknown as Parameters<typeof prepareClaimedJob>[0]['policy'],
  });
  // the claim dispatches the job, which is what makes its session the box's one live run
  await kernel(sql`UPDATE jobs SET status = 'dispatched' WHERE id = ${job?.id}`);
  return prepared.agentSessionId;
}

async function context(query: string, token = w.owner): Promise<RunContextView> {
  const got = await api(
    await userToken(token),
    'GET',
    `/api/projects/${w.projectId}/run-context?${query}`,
  );
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return got.body as unknown as RunContextView;
}

const reaches = (view: RunContextView, how: string) =>
  view.reached.filter((r) => r.how === how).map((r) => `${r.kind}:${r.ref}`);

beforeAll(async () => {
  const owner = await createTestUser({ verified: true });
  const agent = await createTestUser({ kind: 'agent' });
  const project = await createTestProject(owner.id);
  w.projectId = project.id;
  w.owner = owner.id;
  await addProjectMember(w.projectId, owner.id, 'owner');
  await addProjectMember(w.projectId, agent.id, 'member');
  w.issueId = (
    await createTestIssue(w.projectId, owner.id, 7, {
      status: 'in_progress',
      createdAt: new Date(),
    })
  ).id;
  const box = await pairTestBox(w.projectId, { pairedBy: owner.id, actsAs: agent.id });
  w.deviceId = box.deviceId;
  w.box = box.paneToken as string;
  await seedKnowledge('rule', 'delete-by-literal-path', RULE, 'always');
  await seedKnowledge('guide', 'build-commands', GUIDE, 'on_demand');
  await seedKnowledge('lesson', w.lessonSlug, LESSON, 'on_demand', {
    lessonId: '00000000-0000-4000-8000-000000000001',
    number: 1,
    scope: { kind: 'project', areaId: null, areaName: null, itemKind: null },
  });
  const [memory] = await rows<{ id: string }>(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content)
    VALUES (${w.projectId}, 'note', 'notes/release-cut', ${MEMORY}) RETURNING id`);
  w.memoryId = memory?.id as string;
  // opening a job's session emits on the outbox, as a claim does in a serving process
  if (!isBossStarted()) {
    await startBoss();
    await declareOutboxQueues();
  }
  w.sessionId = await claimDriveJob();
  await backgroundSettled();
});

describe('c1: a drive run records each rule and lesson its prompt carried', () => {
  it('records the always-applied rule and the lesson the map names, against the session and its issue', async () => {
    const view = await context(`session=${w.sessionId}`);
    expect(reaches(view, 'prompt').sort()).toEqual(
      ['lesson:lesson-1', 'rule:delete-by-literal-path'].sort(),
    );
    const rule = view.reached.find((r) => r.ref === 'delete-by-literal-path') as RunContextReach;
    expect(rule).toMatchObject({ sessionId: w.sessionId, issueId: w.issueId, how: 'prompt' });
    expect(rule.revision).toMatch(/^sha256:[0-9a-f]{16}$/);
    // an on-demand guide is named in the index, never given: it did not reach the run by its prompt
    expect(reaches(view, 'prompt')).not.toContain('knowledge:build-commands');
  });

  it("records the rules and lessons a declared run's orientation carries as it opens", async () => {
    const runId = await createTestRunSession(w.projectId, w.deviceId, new Date(), null);
    const [s] = await rows<{ id: string }>(
      sql`SELECT id FROM agent_sessions WHERE pipeline_run_id = ${runId}`,
    );
    const declared = s?.id as string;
    recordOrientationCarried({ projectId: w.projectId, deviceId: w.deviceId, sessionId: declared });
    await backgroundSettled();
    const view = await context(`session=${declared}`);
    expect(reaches(view, 'prompt').sort()).toEqual(
      ['lesson:lesson-1', 'rule:delete-by-literal-path'].sort(),
    );
    await kernel(sql`UPDATE agent_sessions SET status = 'completed' WHERE id = ${declared}`);
  });
});

describe("c2: a knowledge get and a memory search made with a run's token record their hits", () => {
  it('records a knowledge GET against the run, at the entry it returned', async () => {
    const got = await api(w.box, 'GET', `/api/projects/${w.projectId}/knowledge/build-commands`);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    await backgroundSettled();
    const view = await context(`session=${w.sessionId}`);
    const hit = view.reached.find((r) => r.how === 'get') as RunContextReach;
    expect(hit).toMatchObject({
      kind: 'knowledge',
      ref: 'build-commands',
      sessionId: w.sessionId,
      issueId: w.issueId,
      revision: new Date(got.body.updatedAt as string).toISOString(),
    });
  });

  it('records a memory search against the run, one row per hit', async () => {
    const got = await api(w.box, 'POST', '/api/memory/search', {
      projectId: w.projectId,
      query: 'release cut aborted fragments',
      strategy: 'keyword',
    });
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect((got.body.hits as { id: string }[]).map((h) => h.id)).toContain(w.memoryId);
    await backgroundSettled();
    const view = await context(`session=${w.sessionId}`);
    expect(reaches(view, 'search')).toContain(`memory:${w.memoryId}`);
  });

  it('records nothing for a person reading with their own credential', async () => {
    const before = (await context(`session=${w.sessionId}`)).reached.length;
    const got = await api(
      await userToken(w.owner),
      'GET',
      `/api/projects/${w.projectId}/knowledge/build-commands`,
    );
    expect(got.status).toBe(200);
    await backgroundSettled();
    expect((await context(`session=${w.sessionId}`)).reached.length).toBe(before);
  });

  it('records against the run a call names, and counts a box read no single run answers', async () => {
    const runId = await createTestRunSession(w.projectId, w.deviceId, new Date(), null);
    const [s] = await rows<{ id: string }>(
      sql`SELECT id FROM agent_sessions WHERE pipeline_run_id = ${runId}`,
    );
    const named = s?.id as string;
    const path = `/api/projects/${w.projectId}/knowledge/build-commands`;
    expect((await api(w.box, 'GET', path, undefined, { 'x-forge-run': named })).status).toBe(200);
    await backgroundSettled();
    expect(reaches(await context(`session=${named}`), 'get')).toEqual(['knowledge:build-commands']);

    // two live sessions on the box, and the call names neither: a guess would mix two runs' records
    const before = await context(`session=${w.sessionId}`);
    expect((await api(w.box, 'GET', path)).status).toBe(200);
    await backgroundSettled();
    const after = await context(`session=${w.sessionId}`);
    expect(after.reached.length).toBe(before.reached.length);
    expect(after.unrecorded.unattributed).toBe(before.unrecorded.unattributed + 1);
    await kernel(sql`UPDATE agent_sessions SET status = 'completed' WHERE id = ${named}`);
  });
});

describe('c3: the read route answers what a run, and what an issue, was given', () => {
  it('answers the same reaches for the issue as for its run', async () => {
    const bySession = await context(`session=${w.sessionId}`);
    const byIssue = await context(`issue=${w.issueId}`);
    expect(byIssue.subject).toEqual({ issue: w.issueId });
    expect(byIssue.truncated).toBe(false);
    const mine = byIssue.reached.filter((r) => r.sessionId === w.sessionId);
    expect(mine).toEqual(bySession.reached);
    expect(new Set(byIssue.reached.map((r) => r.how))).toEqual(
      new Set(['prompt', 'get', 'search']),
    );
  });

  it('refuses a query naming both a session and an issue, or neither, by its shape', async () => {
    const owner = await userToken(w.owner);
    for (const q of [`session=${w.sessionId}&issue=${w.issueId}`, '']) {
      const got = await api(owner, 'GET', `/api/projects/${w.projectId}/run-context?${q}`);
      expect(got.status).toBe(400);
      expect(JSON.stringify(got.body)).toContain('exactly one of session=');
    }
  });

  it("answers nothing of a session another project's run holds", async () => {
    const other = await createTestProject(w.owner);
    await addProjectMember(other.id, w.owner, 'owner');
    const got = await api(
      await userToken(w.owner),
      'GET',
      `/api/projects/${other.id}/run-context?session=${w.sessionId}`,
    );
    expect(got.status).toBe(200);
    expect((got.body as unknown as RunContextView).reached).toEqual([]);
  });
});

describe('c4: a failure in the recorder leaves the read answering and is counted', () => {
  it('answers the knowledge read whole while the record cannot be written, and counts the failure', async () => {
    const before = await context(`session=${w.sessionId}`);
    await db.execute(sql`ALTER TABLE run_context_reaches RENAME TO run_context_reaches_planted`);
    try {
      const got = await api(w.box, 'GET', `/api/projects/${w.projectId}/knowledge/build-commands`);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      expect(got.body.body).toBe(GUIDE);
      await backgroundSettled();
    } finally {
      await db.execute(sql`ALTER TABLE run_context_reaches_planted RENAME TO run_context_reaches`);
    }
    const after = await context(`session=${w.sessionId}`);
    expect(after.unrecorded.failed).toBe(before.unrecorded.failed + 1);
    expect(after.reached.length).toBe(before.reached.length);
  });
});
