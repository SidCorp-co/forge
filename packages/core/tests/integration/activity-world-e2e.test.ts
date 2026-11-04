/**
 * ISS-951 round 3, on a world the size of forge-dev: thirteen projects, one of them holding a
 * thousand issues and their moves, among three hundred thousand transitions of every other kind.
 * What the orchestrator read live on ad24ef729, each here:
 *
 * 1. the workspace read took 12.6 s: each leg is timed on `Server-Timing`, and the read answers under
 *    its budget without waiting on what it keeps off the path, however much is being read behind it;
 * 3. a landed issue still read Triage: a merge recorded or observed moves an in-progress issue's step
 *    past build, never back, and an issue gone to awaiting_release leaves Now;
 * 4. Recent read nothing for a project with passes and moves today: it answers them, quickly, among a
 *    table of transitions that are nearly all some other project's or entity's;
 * 2. a pane known only as of its last pass makes no claim about now.
 *
 * @direct-test-of packages/core/src/activity/glance-cache.ts
 * @direct-test-of packages/core/src/activity/read.ts
 * @direct-test-of packages/core/src/activity/recent.ts
 * @direct-test-of packages/core/src/activity/routes.ts
 * @direct-test-of packages/core/src/activity/release-glance.ts
 * @direct-test-of packages/core/src/masters/index.ts
 * @direct-test-of packages/core/src/masters/state.ts
 * @direct-test-of packages/core/src/devices/admissible.ts
 * @direct-test-of packages/core/src/db/query-timing.ts
 * @direct-test-of packages/core/src/issues/merge-record.ts
 * @direct-test-of packages/core/src/issues/work-state.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  seedOrg,
} from '../helpers/factories.js';

/** What the orchestrator asked of the live read: under a second. */
const READ_BUDGET_MS = 1_000;
/** forge-dev's workspace: thirteen projects. */
const PROJECTS = 13;
/** The big one: about what forge holds. */
const BIG_ISSUES = 1_200;
const SMALL_ISSUES = 60;
/** Transitions of every other entity and project, which Recent must not have to read through. */
const OTHER_TRANSITIONS = 300_000;

let ownerId = '';
let token = '';
let orgId = '';
let bigId = '';
let masterSession = '';
let deviceId = '';
const projectIds: string[] = [];

const rows = async <T>(q: ReturnType<typeof sql>) => [...((await db.execute(q)) as Iterable<T>)];

/** A pipeline run for a session to hang on, as a box's declaration makes one. */
async function pipelineRun(projectId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, created_at, started_at, metadata)
    VALUES (${id}, ${projectId}, 'system', 'running', now(), now(), '{}'::jsonb)`);
  return id;
}

/** `n` issues of `projectId`, in the mix of statuses a working project holds. */
async function seedIssues(projectId: string, n: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, created_at, priority, merged_at)
    SELECT gen_random_uuid(), ${projectId}, g, 'issue ' || g,
           CASE WHEN g % 30 = 0 THEN 'open'
                WHEN g % 97 = 0 THEN 'in_progress'
                WHEN g % 53 = 0 THEN 'awaiting_release'
                WHEN g % 41 = 0 THEN 'draft'
                ELSE 'closed' END,
           ${ownerId}, now() - (g || ' hours')::interval,
           CASE WHEN g % 3 = 0 THEN 'high' ELSE 'medium' END,
           CASE WHEN g % 53 = 0 OR (g % 30 <> 0 AND g % 97 <> 0 AND g % 41 <> 0)
                THEN now() - (g || ' hours')::interval END
      FROM generate_series(1, ${n}) g`);
  // four moves each, the newest over three hours old: none inside a lane's two hours
  await db.execute(sql`
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
    SELECT 'issue', i.id, 'open', 'in_progress', 'system', 'agent', 'test',
           i.created_at - interval '3 hours' + (k || ' minutes')::interval
      FROM issues i CROSS JOIN generate_series(1, 4) k
     WHERE i.project_id = ${projectId}`);
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  token = await userToken(ownerId);
  orgId = await seedOrg(ownerId);
  for (let i = 0; i < PROJECTS; i++) {
    const id = (await createTestProject(ownerId, { orgId })).id;
    projectIds.push(id);
    await seedIssues(id, i === 0 ? BIG_ISSUES : SMALL_ISSUES);
  }
  bigId = projectIds[0] as string;
  await db.execute(sql`
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
    SELECT CASE WHEN g % 2 = 0 THEN 'job' ELSE 'session' END, gen_random_uuid(), 'queued',
           CASE WHEN g % 2 = 0 THEN 'running' ELSE 'completed' END,
           'system', 'agent', 'test', now() - (g || ' seconds')::interval
      FROM generate_series(1, ${OTHER_TRANSITIONS}) g`);
  await db.execute(sql`ANALYZE kernel_transitions`);
  await db.execute(sql`ANALYZE issues`);

  // the big project's master, with passes today, as forge's was when Recent read nothing
  deviceId = await createTestDevice(ownerId);
  masterSession = randomUUID();
  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, started_at, created_at, last_heartbeat_at)
    VALUES (${masterSession}, ${bigId}, ${deviceId}, ${await pipelineRun(bigId)}, 'master', 'running', now() - interval '3 hours',
            now() - interval '3 hours', now() - interval '20 seconds')`);
  await db.execute(sql`
    INSERT INTO master_passes (project_id, master_session_id, verb, issue_key, started_at, ended_at)
    SELECT ${bigId}, ${masterSession}, 'dispatch', 'ISS-' || (g * 30), now() - (g * 14 || ' minutes')::interval,
           now() - (g * 14 - 3 || ' minutes')::interval
      FROM generate_series(1, 12) g`);
}, 300_000);

afterAll(async () => {
  await closeWorld();
});

const viewer = () => ({ userId: ownerId, agency: 'human' as const });

describe('ISS-951 round 3 (1) the workspace read answers under a second', () => {
  it('a cold read of thirteen projects waits on nothing kept off its path, whatever is read behind it', async () => {
    const { readOrgActivity, peopleGlances } = await import('../../src/activity/read.js');
    const { releaseGlances } = await import('../../src/activity/release-glance.js');
    peopleGlances.forget();
    releaseGlances.forget();
    const legs = new Map();
    const started = performance.now();
    const cold = await readOrgActivity(orgId, viewer(), new Date(), { legs });
    const took = performance.now() - started;
    expect(cold.projects).toHaveLength(PROJECTS);
    expect(
      took,
      `a cold read took ${took.toFixed(0)} ms: ${JSON.stringify([...legs])}`,
    ).toBeLessThan(READ_BUDGET_MS);
    // nothing was held, so nothing kept off the path is claimed: each says pending, never none
    expect(cold.refreshing).toBe(true);
    for (const row of cold.projects) {
      expect([row.peoplePending, row.releasePending, row.release]).toEqual([true, true, null]);
    }
    // behind it, the release forecasts run one at a time, never one per project at once
    expect(releaseGlances.inFlight).toBeLessThanOrEqual(1);
    expect(peopleGlances.inFlight).toBeLessThanOrEqual(1);
  });

  it('reads again under a second while everything kept off the path is still being read behind it', async () => {
    const { readOrgActivity } = await import('../../src/activity/read.js');
    for (let i = 0; i < 3; i++) {
      const legs = new Map();
      const started = performance.now();
      await readOrgActivity(orgId, viewer(), new Date(), { legs });
      const took = performance.now() - started;
      expect(
        took,
        `read ${i + 1} took ${took.toFixed(0)} ms: ${JSON.stringify([...legs])}`,
      ).toBeLessThan(READ_BUDGET_MS);
    }
  });

  it('the route names each leg on Server-Timing, with no data in it, and its counted statements are its own', async () => {
    const res = await api(token, 'GET', `/api/orgs/${orgId}/activity`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const timing = res.headers.get('server-timing') ?? '';
    for (const leg of [
      'projects',
      'inflight',
      'awaiting',
      'backlog',
      'people',
      'masters',
      'releases',
      'egress',
      'total',
    ]) {
      expect(timing, `no ${leg} on ${timing}`).toMatch(new RegExp(`(^|, )${leg};dur=[0-9.]+`));
    }
    expect(timing, 'Server-Timing carried a project id').not.toContain(bigId);
    // the people and release reads it started behind itself are not counted as its own statements
    const { readOrgActivity, peopleGlances } = await import('../../src/activity/read.js');
    const { releaseGlances } = await import('../../src/activity/release-glance.js');
    const { newQueryTiming, withQueryTiming } = await import('../../src/db/query-timing.js');
    peopleGlances.forget();
    releaseGlances.forget();
    const t = newQueryTiming();
    await withQueryTiming(t, () => readOrgActivity(orgId, viewer()));
    const counted = t.queries;
    // the reads behind it land well after; none of their statements reach the request's count
    await readOrgActivity(orgId, viewer(), new Date(), { waitMs: 60_000 });
    expect(t.queries, 'a read kept off the path counted its statements as the request’s').toBe(
      counted,
    );
  });

  it('once read behind the page, each row carries what was read', async () => {
    const { readOrgActivity } = await import('../../src/activity/read.js');
    const read = await readOrgActivity(orgId, viewer(), new Date(), { waitMs: 120_000 });
    expect(read.projects.map((p) => [p.peoplePending, p.releasePending])).toEqual(
      read.projects.map(() => [false, false]),
    );
    const big = read.projects.find((p) => p.projectId === bigId) as Doc;
    expect(big.next.total).toBe(BIG_ISSUES / 30);
  });
});

describe('ISS-951 round 3 (4) Recent answers what the project recorded today', () => {
  it('reads its passes and status moves, newest first, quickly among every other transition', async () => {
    // two moves today on the big project's issues
    await db.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
      SELECT 'issue', i.id, 'in_progress', 'awaiting_release', 'user', 'human', 'test', now() - interval '5 minutes'
        FROM issues i WHERE i.project_id = ${bigId} AND i.iss_seq IN (97, 194)`);
    const { readProjectRecent } = await import('../../src/activity/recent.js');
    const started = performance.now();
    const recent = await readProjectRecent(bigId);
    const took = performance.now() - started;
    expect(took, `Recent took ${took.toFixed(0)} ms`).toBeLessThan(500);
    const kinds = recent.items.map((i) => i.kind);
    expect(kinds, JSON.stringify(recent.items)).toContain('status');
    expect(kinds).toContain('pass_settled');
    expect(
      recent.items
        .filter((i) => i.kind === 'status')
        .map((i) => i.issueKey)
        .sort(),
    ).toEqual(['ISS-194', 'ISS-97']);
    const times = recent.items.map((i) => Date.parse(i.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));

    const res = await api(token, 'GET', `/api/orgs/${orgId}/activity/${bigId}/recent`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(((res.body as Doc).items as Doc[]).length).toBeGreaterThan(0);
  });

  it('a run that ended today reads as ended, found by its own session among every other', async () => {
    const run = randomUUID();
    await db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, kind, status, started_at, created_at, metadata)
      VALUES (${run}, ${bigId}, ${await pipelineRun(bigId)}, 'run_session', 'completed', now() - interval '2 minutes',
              now() - interval '2 minutes', ${JSON.stringify({ runIssues: ['ISS-30'] })}::jsonb)`);
    await db.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
      VALUES ('session', ${run}, 'running', 'completed', 'runner', 'agent', 'test', now() - interval '1 minute')`);
    const { readProjectRecent } = await import('../../src/activity/recent.js');
    const recent = await readProjectRecent(bigId);
    expect(recent.items[0]).toMatchObject({ kind: 'run_ended', issueKey: 'ISS-30' });
  });
});

describe('ISS-951 round 3 (6) each project draws a lane of its last two hours', () => {
  it('draws passes as ticks, runs and dialogs as bars, status moves as dots, from the one event read', async () => {
    const { recordMasterDialog } = await import('../../src/masters/service.js');
    await recordMasterDialog({
      deviceId,
      sessionId: masterSession,
      dialog: { text: 'Allow Bash(git push)?', source: 'pane' },
    });
    await recordMasterDialog({ deviceId, sessionId: masterSession, dialog: null });
    await recordMasterDialog({
      deviceId,
      sessionId: masterSession,
      dialog: { text: 'Allow Bash(rm)?', source: 'pane' },
    });
    const { readOrgActivity } = await import('../../src/activity/read.js');
    const read = await readOrgActivity(orgId, viewer());
    const lane = (read.projects.find((p) => p.projectId === bigId) as Doc).lane as Doc;
    expect(lane, 'a project with a master drew no lane').not.toBeNull();
    const from = Date.parse(lane.from);
    expect(Date.parse(read.generatedAt) - from).toBe(120 * 60_000);
    // twelve passes every 14 minutes: the eight inside two hours, and none before
    expect(lane.passes).toHaveLength(8);
    for (const at of lane.passes as string[]) expect(Date.parse(at)).toBeGreaterThanOrEqual(from);
    expect(lane.moves, 'the two moves made today drew no dots').toHaveLength(2);
    expect(lane.runs).toHaveLength(1);
    expect(lane.runs[0].to, 'an ended run drew as still running').not.toBeNull();
    expect(lane.dialogs, JSON.stringify(lane.dialogs)).toHaveLength(2);
    expect(lane.dialogs[0].to).not.toBeNull();
    expect(lane.dialogs[1].to, 'the dialog it stands on drew as ended').toBeNull();

    // Recent reads the same events: the dialog it stands on is its newest
    const { readProjectRecent } = await import('../../src/activity/recent.js');
    expect((await readProjectRecent(bigId)).items[0]?.kind).toBe('dialog_started');

    // a project with no master draws no lane, which the page says as "no master"
    const quiet = read.projects.filter((p) => p.projectId !== bigId);
    expect(quiet.map((p) => [p.master.state, p.lane])).toEqual(quiet.map(() => ['none', null]));
    await recordMasterDialog({ deviceId, sessionId: masterSession, dialog: null });
  });
});

describe('ISS-951 round 3 (3) a landing moves the step, and a landed issue leaves Now', () => {
  const claimed = async (seq: number, step: string, status = 'in_progress') => {
    const [row] = await rows<{ id: string }>(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, created_at, merged_at)
      VALUES (gen_random_uuid(), ${bigId}, ${seq}, ${`landed ${seq}`}, ${status}, ${ownerId}, now(),
              ${status === 'awaiting_release' ? new Date().toISOString() : null})
      RETURNING id`);
    const id = String(row?.id);
    await db.execute(sql`
      INSERT INTO issue_work_state (issue_id, step, step_started_at, updated_at)
      VALUES (${id}, ${step}, now() - interval '4 hours', now())`);
    return id;
  };
  const stepOf = async (id: string) =>
    (await rows<{ step: string }>(sql`SELECT step FROM issue_work_state WHERE issue_id = ${id}`))[0]
      ?.step;
  const record = async (issueId: string, evidence: Doc) => {
    const { recordIssueMerge } = await import('../../src/issues/merge-record.js');
    return db.transaction((tx) =>
      recordIssueMerge(tx as never, {
        issueId,
        evidence: evidence as never,
        actor: null,
        via: 'mark' as never,
      }),
    );
  };

  it('a merge mark recorded moves triage past build; an observed one too; neither moves release back', async () => {
    const marked = await claimed(5001, 'triage');
    expect((await record(marked, { kind: 'asserted' })).wrote).toBe(true);
    expect(await stepOf(marked), 'a landed issue still read triage').toBe('test');

    const observed = await claimed(5002, 'triage');
    await record(observed, {
      kind: 'observed',
      commitSha: 'a'.repeat(40),
      mergedAt: new Date(),
      target: 'dev',
    });
    expect(await stepOf(observed), 'a landing core observed left the step at triage').toBe('test');

    const releasing = await claimed(5003, 'release');
    await record(releasing, { kind: 'asserted' });
    expect(await stepOf(releasing), 'a landing moved a step back').toBe('release');
  });

  it('an issue moved to awaiting_release leaves Now, whatever its step; one a release carries stays', async () => {
    await claimed(5004, 'test', 'awaiting_release');
    await claimed(5005, 'release', 'awaiting_release');
    const { readOrgActivity } = await import('../../src/activity/read.js');
    const read = await readOrgActivity(orgId, viewer());
    const now = (read.projects.find((p) => p.projectId === bigId) as Doc).now as Doc[];
    expect(now.map((n) => n.key)).not.toContain('ISS-5004');
    expect(now.map((n) => n.key)).toContain('ISS-5005');
  });
});

describe('ISS-951 round 3 (2) a pane known only as of its last pass claims nothing of now', () => {
  it('a pass settled with the pane working reads idle by the pass state, not busy, and groups by its backlog', async () => {
    await db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now(), metadata = metadata || ${JSON.stringify({
        paneDialog: null,
        pane: {
          doing: 'working',
          lastEventAt: new Date(Date.now() - 10_000).toISOString(),
          turnBeganAt: new Date(Date.now() - 30_000).toISOString(),
          writtenAt: null,
          seenAt: new Date(Date.now() - 5_000).toISOString(),
          source: 'pass',
        },
      })}::jsonb WHERE id = ${masterSession}`);
    const { readOrgActivity } = await import('../../src/activity/read.js');
    const row = (await readOrgActivity(orgId, viewer())).projects.find(
      (p) => p.projectId === bigId,
    ) as Doc;
    expect(row.master.pane.source).toBe('pass');
    expect(row.master.state, 'a pane as of the last pass was read as working now').toBe('idle');
    expect(row.group).toBe('idle');

    await db.execute(sql`
      UPDATE agent_sessions SET metadata = jsonb_set(metadata, '{pane,source}', '"beat"')
       WHERE id = ${masterSession}`);
    const live = (await readOrgActivity(orgId, viewer())).projects.find(
      (p) => p.projectId === bigId,
    ) as Doc;
    expect(live.master.state, 'a live beat saying working was not read busy').toBe('busy');
  });
});
