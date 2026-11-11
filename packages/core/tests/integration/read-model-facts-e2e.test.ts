import { randomUUID } from 'node:crypto';
import { NEEDS_YOU_PERSON_CAP } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

// REQ-12 BC-19: the fleet strip's online runners, queued count and stalled banner, and the attention
// screen's org scope, counts and offline runners are core's read models' answers, not a screen's sums.
// @direct-test-of packages/core/src/agent-sessions/ops-routes.ts
// @direct-test-of packages/core/src/agent-sessions/read.ts
// @direct-test-of packages/core/src/me/attention-routes.ts
// @direct-test-of packages/core/src/me/attention-buckets.ts
// @direct-test-of packages/core/src/development/needs-you-viewer.ts
// @direct-test-of packages/core/src/activity/read.ts

async function session(projectId: string, status: string, deviceId: string | null = null) {
  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
    VALUES (${runId}, ${projectId}, 'system', 'running', '{}'::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status)
    VALUES (${projectId}, ${deviceId}, ${runId}, 'run_session', ${status})
  `);
}

describe('the queue and attention read models serve the derived facts', () => {
  let token = '';
  let owner = '';
  let project: { id: string; slug: string; orgId: string };
  let other: { id: string; slug: string; orgId: string };

  beforeAll(async () => {
    testEnv();
    await import('../../src/index.js');
    await startQueue();
    owner = (await createTestUser({ verified: true })).id;
    project = await createTestProject(owner);
    other = await createTestProject(owner);
    await addProjectMember(project.id, owner, 'owner');
    await addProjectMember(other.id, owner, 'owner');
    token = await userToken(owner);
  }, 180_000);

  afterAll(closeWorld);

  it('stalls dispatch when sessions wait, idle ones included, and no runner is online', async () => {
    const offline = await createTestDevice(owner, { status: 'offline', name: 'box-off' });
    await bindTestRunner(project.id, offline);
    await session(project.id, 'queued');
    await session(project.id, 'idle');
    await session(project.id, 'running');
    const res = await api(token, 'GET', `/api/agent-sessions/queue-stats?projectId=${project.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ waiting: 2, onlineRunners: 0, dispatchStalled: true });
  });

  it('is not stalled once a runner is online, and not stalled with nothing waiting', async () => {
    const online = await createTestDevice(owner, { status: 'online' });
    await bindTestRunner(project.id, online);
    const busy = await api(token, 'GET', `/api/agent-sessions/queue-stats?projectId=${project.id}`);
    expect(busy.body).toMatchObject({ waiting: 2, onlineRunners: 1, dispatchStalled: false });
    const idleProject = await api(
      token,
      'GET',
      `/api/agent-sessions/queue-stats?projectId=${other.id}`,
    );
    expect(idleProject.body).toMatchObject({
      waiting: 0,
      onlineRunners: 0,
      dispatchStalled: false,
    });
  });

  it('serves the owner offline runners and a count for every bucket', async () => {
    const res = await api(token, 'GET', '/api/me/attention');
    expect(res.status).toBe(200);
    const offline = res.body.offlineRunners as { kind: string; deviceName: string }[];
    expect(offline.map((d) => d.deviceName)).toEqual(['box-off']);
    expect(offline[0]?.kind).toBe('runner_offline');
    expect(res.body.counts).toMatchObject({ offlineRunners: 1, mentions: 0, failedJobs: 0 });
    expect(res.body.total).toBe(1);
  });

  it('keeps the device alert under any org scope', async () => {
    const res = await api(token, 'GET', `/api/me/attention?orgId=${project.orgId}`);
    expect(res.status).toBe(200);
    expect((res.body.counts as { offlineRunners: number }).offlineRunners).toBe(1);
  });

  // ISS-919 c09c3b22a summed the cut rows on the home in web; core counts them (REQ-12 BC-19)
  it('counts the Needs you rows it did not send past the person cap, so no screen sums them', async () => {
    const before = await api(token, 'GET', '/api/me/attention');
    expect(before.body.needsYouNotSent).toBe(0);
    const { askQuestion } = await import('../../src/questions/index.js');
    const asker = (await createTestUser({ verified: true })).id;
    for (let i = 0; i < 5; i++) {
      await askQuestion({
        id: randomUUID(),
        projectId: other.id,
        askedBy: asker,
        prompt: `Which export format, case ${i}?`,
        blockerKind: 'human',
        answer: { shape: 'free_text', needed: 'the format' },
      });
    }
    const res = await api(token, 'GET', '/api/me/attention');
    expect(res.status).toBe(200);
    const part = (
      res.body.needsYou as { projectSlug: string; total: number; decisions: unknown[] }[]
    ).find((p) => p.projectSlug === other.slug);
    expect([part?.total, part?.decisions.length]).toEqual([5, NEEDS_YOU_PERSON_CAP]);
    expect(res.body.needsYouNotSent).toBe(5 - NEEDS_YOU_PERSON_CAP);
    // the Attention band reads each kind's count from core (ISS-1198): the decisions are every
    // project's Needs you total in scope, past the cap too, and the parts sum to core's `total`
    const counts = res.body.counts as Record<string, number>;
    const parts = res.body.needsYou as { total: number; owed: { count: number }[] }[];
    expect(counts.decisions).toBe(parts.reduce((n, p) => n + p.total, 0));
    expect(counts.decisions).toBeGreaterThanOrEqual(5);
    expect(counts.owed).toBe(
      parts.reduce((n, p) => n + p.owed.reduce((m, o) => m + o.count, 0), 0),
    );
    expect(Object.values(counts).reduce((n, c) => n + c, 0)).toBe(res.body.total);
  });

  // ISS-1198 c3 (judge run ad038e31): QA owed one act, its own draft to propose, which is no decision;
  // Activity's You read "–" and the home nothing. Core serves what waits on the person, decisions and
  // the rows owed beside them, as one figure per project and one across them, and Activity counts it.
  it('serves what waits on the person, a draft of their own to propose included, to Attention and Activity', async () => {
    const made = await api(token, 'POST', `/api/projects/${project.id}/requirements`, {
      title: 'Export a project releases',
      criteria: [{ body: 'A person exports the releases' }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const res = await api(token, 'GET', `/api/me/attention?orgId=${project.orgId}`);
    expect(res.status).toBe(200);
    const part = (
      res.body.needsYou as {
        projectSlug: string;
        total: number;
        waiting: number;
        owed: { reason: string; count: number }[];
      }[]
    ).find((p) => p.projectSlug === project.slug);
    const own = part?.owed.find((o) => o.reason === 'own_work')?.count ?? 0;
    expect(own).toBeGreaterThanOrEqual(1);
    expect(part?.waiting).toBe(
      (part?.total ?? 0) + (part?.owed ?? []).reduce((n, o) => n + o.count, 0),
    );
    const counts = res.body.counts as Record<string, number>;
    expect(res.body.owedToYou).toBe((counts.decisions ?? 0) + (counts.owed ?? 0));

    // Activity's You column counts the same rows for the project, once its read behind the page lands
    let row: { projectId: string; people: { total: number }; peoplePending: boolean } | undefined;
    for (let i = 0; i < 40; i++) {
      const read = await api(token, 'GET', `/api/orgs/${project.orgId}/activity`);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      row = (read.body.projects as (typeof row & {})[]).find((p) => p.projectId === project.id);
      if (row && !row.peoplePending) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(row?.peoplePending).toBe(false);
    expect(row?.people.total).toBe(part?.waiting);
  });

  it('refuses an orgId that is no uuid, by name', async () => {
    const res = await api(token, 'GET', '/api/me/attention?orgId=not-an-org');
    expect(res.status).toBe(400);
    const none = await api(token, 'GET', `/api/me/attention?org=${randomUUID()}`);
    expect(none.status).toBe(400);
  });
});
