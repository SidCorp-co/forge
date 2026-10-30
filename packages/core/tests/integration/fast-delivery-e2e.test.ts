/**
 * Fast delivery (REQ-79) against real Postgres over HTTP: the default and its off switch (BC-1), the
 * merge check on build and scoped tests with red as debt (BC-2, BC-3), impact ratings (BC-4), a change
 * rated high held from landing or from promotion (BC-5, BC-6), the cleanup window on a slot of its
 * own (BC-7, BC-8) and its report (BC-9).
 *
 * @direct-test-of packages/core/src/cleanup/service.ts
 * @direct-test-of packages/core/src/cleanup/store.ts
 * @direct-test-of packages/core/src/cleanup/fire.ts
 * @direct-test-of packages/core/src/cleanup/routes.ts
 * @direct-test-of packages/core/src/release-batch/cleanup-hold.ts
 * @direct-test-of packages/core/src/issues/merge-check.ts
 * @direct-test-of packages/core/src/project-config/fast-delivery.ts
 * @direct-test-of packages/core/src/release-batch/production-trigger.ts
 * @direct-test-of packages/core/src/schedules/cleanup-dispatch.ts
 * @direct-test-of packages/core/src/schedules/cleanup-window.ts
 */

import { FAST_LANE_MERGE_CHECKS } from '@forge/contracts/fast-lane';
import { REQUIRED_MERGE_CHECKS } from '@forge/contracts/merge-check';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupFirePlan } from '../../src/cleanup/index.js';
import { db } from '../../src/db/client.js';
import { schedules } from '../../src/db/schema.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { dispatchScheduleRun } from '../../src/schedules/dispatch.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { passingCheck, passingReport } from '../helpers/merge-check-report.js';
import { releaseWorld, seedProductionDeployTrigger, stubProbe } from '../helpers/release-world.js';

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
  it('is kept with its type and reason, newest first, and a high one opens the cleanup window', async () => {
    const issue = await fx.insertIssue('in_progress');
    expect((await rate(issue, 'medium')).status).toBe(201);
    const high = await rate(issue, 'high');
    expect(high.status).toBe(201);
    expect(high.body).toMatchObject({ waits: true, impact: { type: 'data', rating: 'high' } });
    expect(high.body.window).toMatchObject({ cron: '0 18 * * *', enabled: true });
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
    expect(res.body.window).toMatchObject({ cron: '0 18 * * *' });
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

describe('a change rated high lands only on a green base where production deploys on land (BC-5 r4)', () => {
  it('is refused on an open debt rated high, naming it and the cleanup, while a low or medium one lands', async () => {
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
    const window = (await ledger()).body.window as Doc;
    expect(((await ledger()).body.waiting as Doc[]).map((w) => w.issueId)).toEqual([high]);

    const refused = await checkLanding(high);
    expect([refused.status, codes(refused)]).toEqual([422, ['MERGE_CLEANUP_PENDING']]);
    const said = JSON.stringify(refused.body);
    for (const named of [owed, window.scheduleId, '0 18 * * *', 'Nothing was recorded']) {
      expect(said).toContain(named);
    }
    expect(await verifications(high)).toEqual([]);
    for (const issue of [medium, low]) {
      expect((await checkLanding(issue)).status).toBe(201);
    }
  });

  it('lands on a green report with a medium debt open, which only a person can clear', async () => {
    await debts({ items: [red('medium')] });
    const high = await fx.insertIssue('in_progress');
    await rate(high, 'high');
    const green = await reportCleanup({ remains: await remaining() });
    expect(green.status, JSON.stringify(green.body)).toBe(201);
    const landed = await checkLanding(high);
    expect(landed.status, JSON.stringify(landed.body)).toBe(201);
    expect(codes(await markLanding(high))).not.toContain('MERGE_CHECK_MISSING');
  });

  it('is refused on a red last report, and lands once a green one follows', async () => {
    const high = await fx.insertIssue('in_progress');
    await rate(high, 'high');
    expect((await checkLanding(high)).status).toBe(201);
    const red1 = await reportCleanup({ result: 'red' });
    const refused = await checkLanding(high);
    expect(codes(refused)).toEqual(['MERGE_CLEANUP_PENDING']);
    expect(JSON.stringify(refused.body)).toContain(red1.body.report.id);
    expect((await reportCleanup({})).status).toBe(201);
    expect((await checkLanding(high)).status).toBe(201);
  });

  it('is refused while no report on this base follows the last change rated high that landed', async () => {
    expect((await reportCleanup({})).status).toBe(201);
    const earlier = await fx.insertIssue('awaiting_release');
    await rate(earlier, 'high');
    const high = await fx.insertIssue('in_progress');
    await rate(high, 'high');
    const refused = await checkLanding(high);
    expect(codes(refused)).toEqual(['MERGE_CLEANUP_PENDING']);
    expect(JSON.stringify(refused.body)).toContain('since the last change rated high landed');
    expect((await reportCleanup({ base: { branch: 'main', sha: 'c'.repeat(40) } })).status).toBe(
      201,
    );
    expect(codes(await checkLanding(high))).toEqual(['MERGE_CLEANUP_PENDING']);
    expect((await reportCleanup({})).status).toBe(201);
    expect((await checkLanding(high)).status).toBe(201);
  });

  it('judges the rating the report carries and the high debt it would leave', async () => {
    await debts({ items: [highDebt] });
    const unrated = await fx.insertIssue('in_progress');
    const sentHigh = await checkLanding(unrated, {
      impact: { type: 'data', rating: 'high', reason: 'a migration' },
    });
    expect(codes(sentHigh)).toEqual(['MERGE_CLEANUP_PENDING']);
    expect((await checkLanding(unrated)).status).toBe(201);

    expect(
      (
        await reportCleanup({
          cleared: (await remaining()).map((r) => ({ debt: r.debt, how: 'fixed' })),
        })
      ).status,
    ).toBe(201);
    const own = await fx.insertIssue('in_progress');
    await rate(own, 'high');
    const leaving = await checkLanding(own, { debts: [highDebt] });
    expect(codes(leaving)).toEqual(['MERGE_CLEANUP_PENDING']);
    expect(JSON.stringify(leaving.body)).toContain('would leave 1 new cleanup debt rated high');
    expect((await checkLanding(own, { debts: [red('medium')] })).status).toBe(201);
  });

  it('owes the mark a passing merge check, which is itself refused while the base is not green', async () => {
    await debts({ items: [highDebt] });
    const high = await fx.insertIssue('in_progress');
    const low = await fx.insertIssue('in_progress');
    await rate(high, 'high');
    await rate(low, 'low');
    const unchecked = await markLanding(high);
    expect([unchecked.status, codes(unchecked)]).toEqual([422, ['MERGE_CHECK_MISSING']]);
    expect(codes(await markLanding(low))).not.toContain('MERGE_CHECK_MISSING');
    expect(codes(await checkLanding(high))).toEqual(['MERGE_CLEANUP_PENDING']);
  });
});

describe('a change rated high waits for a green cleanup before promotion (BC-5, BC-6)', () => {
  it('is not held by the sweep where production deploys on land: it was held from landing instead', async () => {
    const high = await fx.insertIssue('awaiting_release');
    const medium = await fx.insertIssue('awaiting_release');
    await rate(high, 'high');
    await rate(medium, 'medium');

    await sweepAutomaticReleases();
    expect((await ledger()).body.waiting).toEqual([]);

    expect((await fx.holdOf(high))?.code).not.toBe('RELEASE_CLEANUP_PENDING');
    expect((await fx.holdOf(medium))?.code).not.toBe('RELEASE_CLEANUP_PENDING');
    const cut = await call('POST', `/api/projects/${projectId}/release-batches`, {
      issueIds: [high],
    });
    expect(JSON.stringify(cut.body)).not.toContain('RELEASE_CLEANUP_PENDING');
  });

  it('is named at a cut where a person promotes, while a lower-rated change goes', async () => {
    await seedProductionDeployTrigger(projectId, ownerId, 'on-request');
    const high = await fx.insertIssue('awaiting_release');
    const medium = await fx.insertIssue('awaiting_release');
    await debts({ items: [red('low')] });
    await rate(high, 'high');
    await rate(medium, 'medium');

    const highLanding = await fx.insertIssue('in_progress');
    await rate(highLanding, 'high');
    const landed = await checkLanding(highLanding);
    expect(landed.status, JSON.stringify(landed.body)).toBe(201);

    const cut = await call('POST', `/api/projects/${projectId}/release-batches`, {
      issueIds: [high],
    });
    expect(JSON.stringify(cut.body)).toContain('RELEASE_CLEANUP_PENDING');
    const free = await call('POST', `/api/projects/${projectId}/release-batches`, {
      issueIds: [medium],
    });
    expect(JSON.stringify(free.body)).not.toContain('RELEASE_CLEANUP_PENDING');
    expect((await ledger()).body.waiting.map((w: Doc) => w.issueId)).toContain(high);
  });

  it('goes once a green cleanup report covers it, and not for a red one', async () => {
    await seedProductionDeployTrigger(projectId, ownerId, 'on-request');
    const high = await fx.insertIssue('awaiting_release');
    await rate(high, 'high');
    const onRed = await reportCleanup({ result: 'red', covers: [high] });
    expect(codes(onRed)).toEqual(['CLEANUP_COVERS_RED']);
    const green = await reportCleanup({ covers: [high] });
    expect(green.status, JSON.stringify(green.body)).toBe(201);
    expect(green.body.waiting).toEqual([]);
    const cut = await call('POST', `/api/projects/${projectId}/release-batches`, {
      issueIds: [high],
    });
    expect(JSON.stringify(cut.body)).not.toContain('RELEASE_CLEANUP_PENDING');
  });

  it('holds nothing on a project that turned fast delivery off', async () => {
    await seedProductionDeployTrigger(projectId, ownerId, 'on-request');
    await fastOff();
    const high = await fx.insertIssue('awaiting_release');
    await rate(high, 'high');
    const cut = await call('POST', `/api/projects/${projectId}/release-batches`, {
      issueIds: [high],
    });
    expect(JSON.stringify(cut.body)).not.toContain('RELEASE_CLEANUP_PENDING');
  });
});

describe('a cleanup report (BC-9)', () => {
  it('names every open debt, cleared with how or remaining with why, and clears those it cleared', async () => {
    const first = (await debts({ items: [red('low')] })).body.debts[0] as string;
    const second = (await debts({ items: [{ ...red('medium'), kind: 'simplify' }] })).body
      .debts[0] as string;

    const short = await reportCleanup({ cleared: [{ debt: first, how: 'trimmed the copy' }] });
    expect(codes(short)).toEqual(['CLEANUP_REPORT_INCOMPLETE']);
    expect(JSON.stringify(short.body)).toContain(second);

    const whole = await reportCleanup({
      cleared: [{ debt: first, how: 'trimmed the copy' }],
      remains: [{ debt: second, why: 'the module is mid-rewrite under ISS-9' }],
    });
    expect(whole.status, JSON.stringify(whole.body)).toBe(201);
    expect(whole.body.open).toBe(1);
    const read = await ledger();
    expect(read.body.open.map((d: Doc) => d.id)).toEqual([second]);
    expect(read.body.cleared[0]).toMatchObject({ id: first, cleared: { how: 'trimmed the copy' } });
    const listed = await call('GET', `/api/projects/${projectId}/cleanup-reports`);
    expect(listed.body.reports[0]).toMatchObject({
      result: 'green',
      remains: [{ debt: second, why: 'the module is mid-rewrite under ISS-9' }],
    });
  });

  it('covers only a change rated high, naming the one that is not', async () => {
    const medium = await fx.insertIssue('awaiting_release');
    await rate(medium, 'medium');
    const res = await reportCleanup({ covers: [medium] });
    expect(codes(res)).toEqual(['CLEANUP_COVERS_NOT_HIGH']);
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

  it('briefs the run with the open debt and the waiting changes, and starts nothing when all is clean', async () => {
    expect((await cleanupFirePlan({ projectId, fireId: 'f' })).kind).toBe('nothing');
    const high = await fx.insertIssue('awaiting_release');
    await rate(high, 'high');
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
