/**
 * ISS-684 (REQ-74 BC-4, BC-5): the Delivery overview lists what holds delivery back, per issue and
 * per release, and every hold names its cause and who acts on it next. Read through
 * `GET /api/projects/:id/development/overview` off real rows: a job hold that clears itself, a held
 * job a person resumes, a run that failed with its issue left untaken, and an issue a release holds
 * at the gate. A declared run's moving lane names the box its lease was taken from.
 *
 * @direct-test-of packages/core/src/development/overview-holds.ts
 * @direct-test-of packages/core/src/development/overview-read.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';

const world = { projectId: '', ownerId: '', token: '' };
const HOUR = 60 * 60_000;

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
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
});

async function issueAt(seq: number, status: string): Promise<string> {
  return (
    await createTestIssue(world.projectId, world.ownerId, seq, { status, createdAt: new Date() })
  ).id;
}

/** A running issue run carrying one job at `status`, its payload and columns as given. */
async function runWithJob(
  issueId: string,
  job: { status: string; payload?: unknown; retryAfterAt?: Date | null },
): Promise<string> {
  const runId = randomUUID();
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${runId}, ${world.projectId}, ${issueId}, 'issue', 'running')`);
    await tx.execute(sql`
      INSERT INTO jobs (project_id, issue_id, pipeline_run_id, created_by, type, status, payload,
                        queued_at, retry_after_at)
      VALUES (${world.projectId}, ${issueId}, ${runId}, ${world.ownerId}, 'code', ${job.status},
              ${JSON.stringify(job.payload ?? {})}::jsonb, now() - interval '20 minutes',
              ${job.retryAfterAt?.toISOString() ?? null})`);
  });
  return runId;
}

async function failedRun(issueId: string, endedAgo: number): Promise<string> {
  const runId = randomUUID();
  const at = new Date(Date.now() - endedAgo).toISOString();
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at, finished_at)
      VALUES (${runId}, ${world.projectId}, ${issueId}, 'issue', 'failed', ${at}, ${at})`);
    await tx.execute(sql`
      INSERT INTO jobs (project_id, issue_id, pipeline_run_id, created_by, type, status, payload,
                        queued_at, finished_at, failure_reason)
      VALUES (${world.projectId}, ${issueId}, ${runId}, ${world.ownerId}, 'code', 'failed', '{}'::jsonb,
              ${at}, ${at}, 'provider_usage_limit')`);
  });
  return runId;
}

const hold = (reason: string, autoRelease: boolean) => ({
  __hold: { reason, heldAt: new Date(Date.now() - 15 * 60_000).toISOString(), autoRelease },
});

async function overview(): Promise<Doc> {
  const res = await api(
    world.token,
    'GET',
    `/api/projects/${world.projectId}/development/overview`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Doc;
}

type Hold = {
  kind: string;
  runId: string | null;
  issues: string[];
  release: string | null;
  cause: string;
  code: string | null;
  waitingOn: { who: string; act: string; kind: string; dueAt: string | null };
  says: { cause: { key: string } };
};

const holdsOn = (d: Doc, key: string): Hold[] =>
  ((d.holds.issues as Doc[]).find((g) => g.key === key)?.holds ?? []) as Hold[];

describe('the Delivery overview lists each hold with its cause and who acts', () => {
  it('names Forge as who resumes a job hold that clears itself, and when', async () => {
    const id = await issueAt(1, 'in_progress');
    const at = new Date(Date.now() + HOUR);
    const runId = await runWithJob(id, {
      status: 'held',
      payload: hold('all_devices_exhausted', true),
      retryAfterAt: at,
    });
    const d = await overview();
    const [h] = holdsOn(d, 'ISS-1');
    expect(h).toMatchObject({ kind: 'job', runId, issues: ['ISS-1'] });
    expect(h?.cause).toBe('Every runner was busy; it retries by itself');
    expect(h?.code).toBe('all_devices_exhausted');
    expect(h?.waitingOn.who).toBe('Forge');
    expect(h?.waitingOn.act).toBe('resume it when the wait ends');
    expect(h?.waitingOn.dueAt).toBe(at.toISOString());
    expect(d.holds.count).toBe(1);
  });

  it('names the person who resumes a held job that does not clear itself', async () => {
    const id = await issueAt(2, 'in_progress');
    const runId = await runWithJob(id, {
      status: 'held',
      payload: hold('retry_rounds_exhausted', false),
    });
    const [h] = holdsOn(await overview(), 'ISS-2');
    expect(h).toMatchObject({ kind: 'job', runId });
    expect(h?.cause).toBe('Retried too many times; it will not resume itself');
    expect(h?.code).toBe('retry_rounds_exhausted');
    expect(h?.waitingOn.who).toBe('You');
    expect(h?.waitingOn.act).toBe('resume the job');
  });

  it('lists a run that failed in the last day with its issue untaken, naming who acts on the issue', async () => {
    const id = await issueAt(3, 'open');
    const runId = await failedRun(id, HOUR);
    const [h] = holdsOn(await overview(), 'ISS-3');
    expect(h).toMatchObject({ kind: 'failed', runId, issues: ['ISS-3'] });
    expect(h?.cause).toBe("Hit the model provider's usage limit");
    expect(h?.code).toBe('provider_usage_limit');
    expect(h?.waitingOn.who).toBe('Master');
  });

  it('does not list a run that failed over a day ago, nor one whose issue a live run carries again', async () => {
    const old = await issueAt(4, 'open');
    await failedRun(old, 30 * HOUR);
    const retaken = await issueAt(5, 'in_progress');
    await failedRun(retaken, HOUR);
    await runWithJob(retaken, { status: 'queued' });
    const d = await overview();
    expect(holdsOn(d, 'ISS-4')).toEqual([]);
    expect(holdsOn(d, 'ISS-5').filter((h) => h.kind === 'failed')).toEqual([]);
  });

  it('lists an issue a release holds at the gate, under the issue and under the drafted release', async () => {
    const id = await issueAt(6, 'awaiting_release');
    await db.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${id}`);
    await db.execute(sql`
      INSERT INTO release_holds (project_id, issue_id, code, reason, owes, waiting_for, held_at)
      VALUES (${world.projectId}, ${id}, 'NO_RUNNER_ONLINE', 'no runner serving this project is online',
              'human', 'the refusal named here to be cleared', now() - interval '10 minutes')`);
    const d = await overview();
    const [h] = holdsOn(d, 'ISS-6');
    expect(h).toMatchObject({ kind: 'release', runId: null, issues: ['ISS-6'] });
    expect(h?.cause).toBe('Every runner serving this project is offline');
    expect(h?.code).toBe('NO_RUNNER_ONLINE');
    expect(h?.waitingOn).toMatchObject({ who: "The runner's owner", act: 'bring a runner online' });
    expect(h?.release).toEqual(expect.any(String));
    const releases = d.holds.releases as Doc[];
    expect(releases.map((g) => g.key)).toEqual([h?.release]);
    expect(((releases[0]?.holds ?? []) as Hold[]).map((x) => x.issues)).toEqual([['ISS-6']]);
  });

  it('names the runner owner for a run no box can take', async () => {
    const id = await issueAt(7, 'in_progress');
    const runId = await runWithJob(id, { status: 'queued' });
    const [h] = holdsOn(await overview(), 'ISS-7');
    expect(h).toMatchObject({ kind: 'blocked', runId });
    expect(h?.cause).toBe('The runners have not checked in recently');
    expect(h?.code).toBe('runner_stale');
    expect(h?.waitingOn).toMatchObject({ who: "The runner's owner", act: 'bring a runner online' });
  });
});

/** The verbs an act may open with: base form, so "<who> · <act>" reads as what that agent does. */
const VERBS = new Set(
  'resume fail decide bring update let settle review clear dispatch judge back make route declare fix take record name finish try bind file write land split merge release'.split(
    ' ',
  ),
);
const CODE = /[a-z]+_[a-z_]+|[A-Z]{3,}_[A-Z_]+/;

describe('every hold, of every kind, reads in plain words', () => {
  it('a cause with no code, a who with no code, and an act that is a verb phrase', async () => {
    const a = await issueAt(1, 'in_progress');
    await runWithJob(a, {
      status: 'held',
      payload: hold('all_devices_exhausted', true),
      retryAfterAt: new Date(Date.now() + HOUR),
    });
    await runWithJob(await issueAt(2, 'in_progress'), {
      status: 'held',
      payload: hold('retry_rounds_exhausted', false),
    });
    await failedRun(await issueAt(3, 'open'), HOUR);
    const gated = await issueAt(6, 'awaiting_release');
    await db.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${gated}`);
    await db.execute(sql`
      INSERT INTO release_holds (project_id, issue_id, code, reason, owes, waiting_for, held_at)
      VALUES (${world.projectId}, ${gated}, 'RELEASE_QUEUED_BEHIND', 'a release is already cut',
              'agent', 'a later automatic release', now() - interval '5 minutes')`);
    await runWithJob(await issueAt(7, 'in_progress'), { status: 'queued' });
    const d = await overview();
    const holds = (d.holds.issues as Doc[]).flatMap((g) => g.holds as Hold[]);
    expect(new Set(holds.map((h) => h.kind))).toEqual(
      new Set(['job', 'failed', 'release', 'blocked']),
    );
    for (const h of holds) {
      expect(h.cause, `${h.kind} cause`).not.toMatch(CODE);
      expect(h.waitingOn.who, `${h.kind} who`).not.toMatch(CODE);
      expect(h.waitingOn.act, `${h.kind} act`).not.toMatch(CODE);
      const verb = h.waitingOn.act.split(' ')[0] ?? '';
      expect(VERBS.has(verb), `${h.kind} act "${h.waitingOn.act}" is not a verb phrase`).toBe(true);
    }
  });
});

describe('a declared run’s moving lane names its box', () => {
  it('reads the box its work-state lease was taken from', async () => {
    const id = await issueAt(8, 'in_progress');
    const box = await createTestDevice(world.ownerId, { name: 'box-alpha' });
    const lease = { holder: 'iss-8-run', renewedAt: new Date().toISOString(), minutes: 60 };
    await db.execute(sql`
      INSERT INTO issue_work_state (issue_id, lease, lease_device_id, updated_at)
      VALUES (${id}, ${JSON.stringify(lease)}::jsonb, ${box}, now())`);
    const d = await overview();
    const lane = (d.moving.lanes as Doc[]).find((l) => l.key === 'ISS-8');
    expect(lane).toMatchObject({ holder: 'iss-8-run', box: 'box-alpha' });
    expect(d.holds).toEqual({ count: 0, issues: [], releases: [] });
  });
});
