/**
 * Fast delivery (REQ-79) against real Postgres over HTTP: the default and its off switch (BC-1), the
 * merge check on build and scoped tests with red as debt (BC-2, BC-3), impact ratings (BC-4), a change
 * rated high landing and promoted on its build while its debt waits for the audit (BC-5, BC-6), and
 * the cleanup window on a slot of its own (BC-7, BC-8). Its report (BC-9, BC-10) is
 * `cleanup-report-e2e.test.ts`'s.
 *
 * @direct-test-of packages/core/src/cleanup/service.ts
 * @direct-test-of packages/core/src/cleanup/store.ts
 * @direct-test-of packages/core/src/cleanup/fire.ts
 * @direct-test-of packages/core/src/cleanup/routes.ts
 * @direct-test-of packages/core/src/release-batch/blockers.ts
 * @direct-test-of packages/core/src/issues/merge-check.ts
 * @direct-test-of packages/core/src/project-config/fast-delivery.ts
 * @direct-test-of packages/core/src/release-batch/production-trigger.ts
 * @direct-test-of packages/core/src/schedules/cleanup-dispatch.ts
 * @direct-test-of packages/core/src/schedules/cleanup-window.ts
 */

import { FAST_LANE_MERGE_CHECKS } from '@forge/contracts/fast-lane';
import { REQUIRED_MERGE_CHECKS } from '@forge/contracts/merge-check';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupFirePlan } from '../../src/cleanup/index.js';
import { db } from '../../src/db/client.js';
import { schedules } from '../../src/db/schema.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { dispatchScheduleRun } from '../../src/schedules/dispatch.js';
import { api, userToken } from '../helpers/api.js';
import { plantSource } from '../helpers/cleanup-source.js';
import { turnCleanupWindowOn } from '../helpers/cleanup-window.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { passingCheck, passingReport } from '../helpers/merge-check-report.js';
import { releaseWorld, seedProductionDeployTrigger, stubProbe } from '../helpers/release-world.js';

// a cleanup report's base is read on the project's source host (ISS-912): planted, never a real one
vi.mock('../../src/integrations/source-host/index.js', async (original) =>
  (await import('../helpers/cleanup-source.js')).mockedSourceHost(
    await original<typeof import('../../src/integrations/source-host/index.js')>(),
  ),
);

let projectId: string;
let ownerId: string;
let token: string;
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
  plantSource(projectId, {
    dev: ['b'.repeat(40), 'c'.repeat(40)],
    main: ['b'.repeat(40), 'c'.repeat(40)],
  });
  token = await userToken(ownerId);
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
  stubProbe({});
});

const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
};
const codes = (res: { body: Doc }): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.code);

/** Turn the project's fast delivery off, as `delivery.fast: false` in its document does. */
async function fastOff(): Promise<void> {
  await db.execute(sql`
    UPDATE project_config_documents
       SET document = jsonb_set(document, '{delivery}', '{"fast": false}'::jsonb)
     WHERE project_id = ${projectId}`);
}

const rate = (issue: string, rating: 'low' | 'medium' | 'high', type = 'data') =>
  call('POST', `/api/issues/${issue}/impact`, { type, rating, reason: `rated ${rating}` });

const red = (rating: 'low' | 'medium' | 'high') => ({
  kind: 'red',
  check: 'verify',
  where: 'scripts/check-copy-budget.mjs',
  detail: 'copy budget over by 12 lines',
  impact: { type: 'config', rating, reason: 'a budget gate, the app is untouched' },
});

/** A field of the issue's newest merge-check record, as core wrote it. */
async function mergeRecord(issue: string): Promise<(key: string) => string | undefined> {
  const items = (await call('GET', `/api/issues/${issue}/events`)).body.items as Doc[];
  const [record] = items.filter(
    (e) => e.kind === 'verification' && (e.fields as Doc[]).some((f) => f.key === 'check'),
  );
  return (key) => (record?.fields as Doc[] | undefined)?.find((f) => f.key === key)?.value;
}

const debts = (body: unknown) => call('POST', `/api/projects/${projectId}/debts`, body);
const ledger = () => call('GET', `/api/projects/${projectId}/debts`);
const reportCleanup = (body: Doc) =>
  call('POST', `/api/projects/${projectId}/cleanup-reports`, {
    base: { branch: 'dev', sha: 'c'.repeat(40) },
    result: 'green',
    cleared: [],
    remains: [],
    ...body,
  });

describe('the impact a building agent rates its change at (BC-4)', () => {
  it('is kept with its type and reason, newest first, and a high one names the window, never making one', async () => {
    const issue = await fx.insertIssue('in_progress');
    expect((await rate(issue, 'medium')).status).toBe(201);
    const high = await rate(issue, 'high');
    expect(high.status).toBe(201);
    expect(high.body).toMatchObject({ impact: { type: 'data', rating: 'high' } });
    expect(high.body).not.toHaveProperty('waits');
    expect(high.body.window).toBeNull();
    const read = await call('GET', `/api/issues/${issue}/impact`);
    expect(read.body.current).toMatchObject({ rating: 'high', reason: 'rated high' });
    expect(read.body.history.map((h: Doc) => h.rating)).toEqual(['high', 'medium']);
  });

  it('refuses a type that is no surface, naming the surfaces', async () => {
    const issue = await fx.insertIssue('in_progress');
    const res = await rate(issue, 'low', 'database');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('ui, api, logic, data, config, runner');
  });
});

describe('cleanup debt (BC-3, BC-1)', () => {
  it('records a red rated below high on its issue, and the ledger surfaces it', async () => {
    const issue = await fx.insertIssue('in_progress');
    const res = await debts({ issue, items: [red('medium')] });
    expect(res.status).toBe(201);
    expect(res.body.window).toBeNull();
    const read = await ledger();
    expect(read.body.fast).toBe(true);
    expect(read.body.open).toHaveLength(1);
    expect(read.body.open[0]).toMatchObject({
      issueId: issue,
      kind: 'red',
      check: 'verify',
      impact: { rating: 'medium' },
      cleared: null,
    });
  });

  it('refuses a red rated high by name: it holds the issue, which fixes it', async () => {
    const res = await debts({ items: [red('medium'), red('high')] });
    expect([res.status, codes(res)]).toEqual([422, ['DEBT_RED_HOLDS_THE_ISSUE']]);
    expect((await ledger()).body.open).toEqual([]);
  });

  it('is refused on a project that turned fast delivery off', async () => {
    await fastOff();
    const res = await debts({ items: [red('low')] });
    expect([res.status, codes(res)]).toEqual([422, ['FAST_DELIVERY_OFF']]);
  });
});

describe('a merge check on a project delivering fast (BC-2, BC-3)', () => {
  const head = 'a'.repeat(40);
  const report = (checks: Doc[], over: Doc = {}) => ({
    ...passingReport({
      base: { branch: 'main', sha: 'b'.repeat(40) },
      head,
      touched: [{ path: 'packages/core/src/x.ts', change: 'changed' }],
      checks: checks as never,
    }),
    ...over,
  });

  it('lands on build and scoped tests, keeping its rating and the red it passed as debt', async () => {
    const issue = await fx.insertIssue('in_progress');
    const checks = [
      ...FAST_LANE_MERGE_CHECKS.map((n) => passingCheck(n)),
      { ...passingCheck('verify'), result: 'fail' },
    ];
    const res = await call(
      'POST',
      `/api/issues/${issue}/merge-check`,
      report(checks, {
        impact: { type: 'logic', rating: 'medium', reason: 'one service' },
        debts: [red('low')],
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await call('GET', `/api/issues/${issue}/impact`)).body.current).toMatchObject({
      rating: 'medium',
      commit: head,
    });
    const open = (await ledger()).body.open as Doc[];
    expect(open.map((d) => d.issueId)).toEqual([issue]);
    // the record names the red it passed and its debt, and the lane it was held to
    const record = await mergeRecord(issue);
    expect(record('lead')).toContain(
      `\`verify\` ended red and passed as cleanup debt ${open[0]?.id}`,
    );
    expect(record('debts')).toContain(`red \`verify\` passed, debt ${open[0]?.id}`);
    expect(record('lane')).toBe('fast-delivery');
  });

  it('asks every check and passes no red where the project turned fast delivery off (BC-1)', async () => {
    await fastOff();
    const issue = await fx.insertIssue('in_progress');
    const fast = await call(
      'POST',
      `/api/issues/${issue}/merge-check`,
      report(FAST_LANE_MERGE_CHECKS.map((n) => passingCheck(n))),
    );
    expect(codes(fast)).toEqual(['MERGE_CHECK_INCOMPLETE']);
    const checks = REQUIRED_MERGE_CHECKS.map((n) =>
      n === 'verify' ? { ...passingCheck(n), result: 'fail' } : passingCheck(n),
    );
    const owed = await call(
      'POST',
      `/api/issues/${issue}/merge-check`,
      report(checks, { debts: [red('low')] }),
    );
    expect(codes(owed)).toEqual(['MERGE_DEBT_FAST_DELIVERY_OFF']);
    await rate(issue, 'high');
    const whole = await call(
      'POST',
      `/api/issues/${issue}/merge-check`,
      report(REQUIRED_MERGE_CHECKS.map((n) => passingCheck(n))),
    );
    expect(whole.status, JSON.stringify(whole.body)).toBe(201);
    const record = await mergeRecord(issue);
    expect([record('lane'), record('debts')]).toEqual(['full', undefined]);
    expect(record('lead')).not.toContain('debt');
  });
});

/** A merge check report on the fast delivery set, as a building run sends it. */
const landing = (over: Doc = {}) => ({
  ...passingReport({
    base: { branch: 'dev', sha: 'b'.repeat(40) },
    head: 'a'.repeat(40),
    touched: [{ path: 'packages/core/src/x.ts', change: 'changed' }],
    checks: FAST_LANE_MERGE_CHECKS.map((n) => passingCheck(n)) as never,
  }),
  ...over,
});
const checkLanding = (issue: string, over: Doc = {}) =>
  call('POST', `/api/issues/${issue}/merge-check`, landing(over));
const markLanding = (issue: string) =>
  call('POST', `/api/issues/${issue}/merge`, { target: 'dev', commit: 'a'.repeat(40), note: 'ok' });
const verifications = async (issue: string) =>
  (await call('GET', `/api/issues/${issue}/events`)).body.items.filter(
    (e: Doc) => e.kind === 'verification',
  );
const highDebt = { ...red('high'), kind: 'debt', check: undefined };
const remaining = async () =>
  ((await ledger()).body.open as Doc[]).map((d) => ({ debt: d.id, why: 'a person owes it' }));
/** A debt carried as a priced amnesty, which a green report may leave (BC-10). */
const carry = (debt: string) =>
  call('POST', `/api/projects/${projectId}/debts/${debt}/carry`, {
    trades: 'Deploy dev stays red',
    costs: 'hand deploys',
    endsWhen: 'a person sets the token',
  });

describe('a change rated high lands on its build, and the audit window takes its debt (BC-5)', () => {
  it('lands while the base carries an open debt rated high, and the debt stays open for the window', async () => {
    await turnCleanupWindowOn(projectId, ownerId);
    const owed = (await debts({ items: [highDebt] })).body.debts[0] as string;
    const [high, medium, low] = [
      await fx.insertIssue('in_progress', undefined, false),
      await fx.insertIssue('in_progress'),
      await fx.insertIssue('in_progress'),
    ] as [string, string, string];
    for (const [issue, rating] of [
      [high, 'high'],
      [medium, 'medium'],
      [low, 'low'],
    ] as const) {
      await rate(issue, rating);
    }
    expect((await ledger()).body).not.toHaveProperty('waiting');

    for (const issue of [high, medium, low]) {
      const landed = await checkLanding(issue);
      expect(landed.status, JSON.stringify(landed.body)).toBe(201);
      expect(codes(landed)).not.toContain('MERGE_CLEANUP_PENDING');
    }
    expect((await verifications(high)).length).toBeGreaterThan(0);
    expect(((await ledger()).body.open as Doc[]).map((d) => d.id)).toContain(owed);
    expect((await cleanupFirePlan({ projectId, fireId: 'f' })).kind).toBe('run');
  });

  it('lands on a green report leaving a medium debt only a person can clear, once it is carried', async () => {
    expect((await carry((await debts({ items: [red('medium')] })).body.debts[0])).status).toBe(200);
    const high = await fx.insertIssue('in_progress');
    await rate(high, 'high');
    const green = await reportCleanup({ remains: await remaining() });
    expect(green.status, JSON.stringify(green.body)).toBe(201);
    const landed = await checkLanding(high);
    expect(landed.status, JSON.stringify(landed.body)).toBe(201);
    expect(codes(await markLanding(high))).not.toContain('MERGE_CHECK_MISSING');
  });

  it('lands and is marked on a red last report, whose debt stays open for the window', async () => {
    const high = await fx.insertIssue('in_progress');
    await rate(high, 'high');
    const debt = (await debts({ items: [red('low')] })).body.debts[0] as string;
    expect(
      (await reportCleanup({ result: 'red', remains: [{ debt, why: 'still red' }] })).status,
    ).toBe(201);
    const landed = await checkLanding(high);
    expect(landed.status, JSON.stringify(landed.body)).toBe(201);
    expect(codes(await markLanding(high))).not.toContain('MERGE_CHECK_MISSING');
    expect(((await ledger()).body.open as Doc[]).map((d) => d.id)).toContain(debt);
    expect((await cleanupFirePlan({ projectId, fireId: 'f' })).kind).toBe('run');
  });

  it('lands and is marked while no report follows the last change rated high, and the window owes that report', async () => {
    expect((await reportCleanup({})).status).toBe(201);
    const earlier = await fx.insertIssue('awaiting_release');
    await rate(earlier, 'high');
    const high = await fx.insertIssue('in_progress');
    await rate(high, 'high');
    const landed = await checkLanding(high);
    expect(landed.status, JSON.stringify(landed.body)).toBe(201);
    expect(codes(await markLanding(high))).not.toContain('MERGE_CHECK_MISSING');
    expect((await cleanupFirePlan({ projectId, fireId: 'f' })).kind).toBe('run');
  });

  it('records the high debt a landing report leaves, open for the window, and lands', async () => {
    const own = await fx.insertIssue('in_progress');
    await rate(own, 'high');
    const leaving = await checkLanding(own, { debts: [highDebt] });
    expect(leaving.status, JSON.stringify(leaving.body)).toBe(201);
    const open = (await ledger()).body.open as Doc[];
    expect(open.some((d) => d.impact?.rating === 'high' && d.issueKey)).toBe(true);
  });

  it('owes the mark of a change rated high a passing merge check, which then lands', async () => {
    await debts({ items: [highDebt] });
    const high = await fx.insertIssue('in_progress');
    const low = await fx.insertIssue('in_progress');
    await rate(high, 'high');
    await rate(low, 'low');
    const unchecked = await markLanding(high);
    expect([unchecked.status, codes(unchecked)]).toEqual([422, ['MERGE_CHECK_MISSING']]);
    expect(codes(await markLanding(low))).not.toContain('MERGE_CHECK_MISSING');
    expect((await checkLanding(high)).status).toBe(201);
    expect(codes(await markLanding(high))).not.toContain('MERGE_CHECK_MISSING');
  });
});

describe('a change rated high is never held from promotion by the audit (BC-6)', () => {
  it('is not held by the sweep where production deploys on land', async () => {
    const high = await fx.insertIssue('awaiting_release');
    const medium = await fx.insertIssue('awaiting_release');
    await rate(high, 'high');
    await rate(medium, 'medium');

    await sweepAutomaticReleases();
    expect((await fx.holdOf(high))?.code).not.toBe('RELEASE_CLEANUP_PENDING');
    expect((await fx.holdOf(medium))?.code).not.toBe('RELEASE_CLEANUP_PENDING');
    const cut = await call('POST', `/api/projects/${projectId}/release-batches`, {
      issueIds: [high],
    });
    expect(JSON.stringify(cut.body)).not.toContain('RELEASE_CLEANUP_PENDING');
  });

  it('is cut where a person promotes, with no green cleanup covering it', async () => {
    await seedProductionDeployTrigger(projectId, ownerId, 'on-request');
    const high = await fx.insertIssue('awaiting_release');
    await debts({ items: [red('low')] });
    await rate(high, 'high');
    const cut = await call('POST', `/api/projects/${projectId}/release-batches`, {
      issueIds: [high],
    });
    expect(JSON.stringify(cut.body)).not.toContain('RELEASE_CLEANUP_PENDING');
  });
});

describe('the cleanup window fires a run on a slot of its own (BC-7, BC-8)', () => {
  const windowRow = async () => {
    const [row] = await db
      .select()
      .from(schedules)
      .where(sql`${schedules.projectId} = ${projectId}`);
    if (!row) throw new Error('no cleanup window was saved');
    return { ...row, params: null };
  };
  const jobs = async () =>
    (
      await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM jobs WHERE project_id = ${projectId}`,
      )
    )[0]?.n;
  const fires = async () =>
    rows<{ status: string; reason: string | null; refusal: string | null }>(
      sql`SELECT status, reason, refusal FROM schedule_runs WHERE project_id = ${projectId} ORDER BY created_at`,
    );

  it('briefs the run with the open debt, and starts nothing when all is clean', async () => {
    expect((await cleanupFirePlan({ projectId, fireId: 'f' })).kind).toBe('nothing');
    const id = (await debts({ items: [red('low')] })).body.debts[0] as string;
    const plan = await cleanupFirePlan({ projectId, fireId: 'fire-1' });
    expect(plan.kind).toBe('run');
    const prompt = plan.kind === 'run' ? plan.prompt : '';
    expect(prompt).toContain(id);
    expect(prompt).toContain('"fire-1"');
    expect(prompt).toContain(`/api/projects/${projectId}/cleanup-reports`);
    await fastOff();
    expect((await cleanupFirePlan({ projectId, fireId: 'f' })).kind).toBe('off');
  });

  it('starts its run as a session, never a pool job, and one at a time', async () => {
    await turnCleanupWindowOn(projectId, ownerId);
    await debts({ items: [red('low')] });
    const schedule = await windowRow();
    expect(schedule).toMatchObject({ kind: 'cleanup', cron: '0 18 * * *', ownerId });

    const first = await dispatchScheduleRun({ schedule, tick: true });
    // no box is paired here: the run goes the way a prompt session does, and the job pool is untouched
    expect(first).toMatchObject({ ok: false, reason: 'no-device', status: 'skipped' });
    expect(await jobs()).toBe(0);

    // the first window's run, still live: a chat session, as a cleanup fire starts
    const [run] = await rows<{ id: string }>(sql`
      INSERT INTO pipeline_runs (project_id, kind, status, started_at, metadata)
      VALUES (${projectId}, 'system', 'running', now(), '{}'::jsonb) RETURNING id`);
    const [session] = await rows<{ id: string }>(sql`
      INSERT INTO agent_sessions (project_id, pipeline_run_id, kind, status)
      VALUES (${projectId}, ${run?.id}, 'chat', 'running') RETURNING id`);
    await db.execute(sql`
      INSERT INTO schedule_runs (schedule_id, project_id, trigger, status, session_id, started_at)
      VALUES (${schedule.id}, ${projectId}, 'scheduled', 'running', ${session?.id}, now())`);
    const second = await dispatchScheduleRun({ schedule, tick: true });
    expect(second).toMatchObject({ ok: false, reason: 'rule-refused', status: 'skipped' });
    expect((await fires()).at(-1)).toMatchObject({
      status: 'skipped',
      reason: 'gate-refused',
      refusal: 'CLEANUP_RUN_LIVE',
    });
  });
});
