/**
 * An owed delivery check is a handoff, and one stuck item cannot spend the steward's day (ISS-1100).
 * On forge-dev, 2026-11-07, the sweep raised REQ-45's owed check only from its own leftover room,
 * which stuck diagnoses had spent by 02:00Z: REQ-45 alone was diagnosed every 5 minutes on one basis,
 * each run ending on a note because a decision on its standing forbade an ask, so it and agenfold
 * REQ-18 stayed `REQUIREMENT_UNCHECKED` all day. The budget read showed the handoffs' runner jobs as
 * "10 of 4", a ceiling they were never held to.
 * - An owed check is queued whatever room the sweep's share has left, billed as the handoff that
 *   owed it; where the whole day is spent it is queued due when the budget resumes, and the refusal
 *   names that time.
 * - A stuck item whose diagnosis ended on a note while an ask holds its standing is not diagnosed
 *   again on the same basis, and no basis is diagnosed more than twice a UTC day.
 * - The budget read never shows a side spent past what it may spend.
 *
 * @direct-test-of packages/core/src/steward/owed-checks.ts
 * @direct-test-of packages/core/src/steward/sweep.ts
 * @direct-test-of packages/core/src/steward/policy.ts
 * @direct-test-of packages/core/src/steward/runs-store.ts
 * @direct-test-of packages/core/src/requirements/delivery-check.ts
 */

import type { Said } from '@forge/contracts/said';
import { type ItemStanding, STEWARD_DEBOUNCE_MS } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
} from '../helpers/factories.js';

type Sweep = typeof import('../../src/steward/sweep.js');

let sweep: Sweep;
let say: (method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let seq = 0;
/** What the standing read answers for this project, test by test. */
let standings: ItemStanding[] = [];
const at = (path: string) => `/api/projects/${projectId}${path}`;
const tally = () => ({ projects: 0, stuck: 0, changed: 0, settledAsks: 0, paced: 0, checks: 0 });

const refusalsOf = (r: Reply) =>
  (r.json.error?.refusals ?? []) as { code: string; path: string; detail: string }[];

/** The UTC midnight after `now`: when the steward's budget resumes. */
const resumesAfter = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

/** An agreed requirement with one live issue, so only its delivery check can hold its delivery. */
async function agreedWithIssue(title: string): Promise<{ key: string; id: string }> {
  const key = ok(
    await say('POST', '/requirements', {
      title,
      reason: 'the rule it states',
      criteria: [{ body: `${title}: a saved board shows every card it had.` }],
    }),
    201,
  ).key as string;
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  ok(await say('POST', `/requirements/${key}/revisions/1/propose`, {}));
  ok(await say('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'BA review' }));
  ok(await say('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'owner signed r1' }));
  const proposed = ok(
    await say('POST', '/suggestions', {
      kind: 'breakdown',
      requirement: key,
      baseRevision: 1,
      payload: {
        issues: [
          {
            title: `Build ${title}`,
            criteria: [{ body: 'a reload shows every card', tracesTo: 'BC-1' }],
            complexity: 's',
            builds: null,
          },
        ],
      },
    }),
    201,
  );
  ok(await say('POST', `/suggestions/${proposed.suggestion.id}/accept`, { reason: 'one slice' }));
  await settleOutbox();
  const [row] = await rows<{ id: string }>(
    sql`SELECT id FROM requirements WHERE project_id = ${projectId} AND req_seq = ${Number(key.slice(4))}`,
  );
  const id = row?.id ?? '';
  // the agree and the breakdown queued the check: plant it agreed 3 hours ago, its check failed 2
  await rows(sql`DELETE FROM steward_runs WHERE subject_id = ${id}`);
  await rows(sql`
    UPDATE requirement_revisions
       SET created_at = now() - interval '3 hours', decided_at = now() - interval '3 hours'
     WHERE requirement_id = ${id}`);
  await rows(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                              acts_to_run, state, failure, failure_kind, not_before, queued_at,
                              started_at, ended_at)
    VALUES (${projectId}, 'requirement', ${id}, ${key}, 'requirement.agreed', '[]'::jsonb,
            ARRAY['intake_check']::text[], 'failed', 'intake_check: the turn did not finish: timeout',
            'error', now() - interval '2 hours', now() - interval '2 hours',
            now() - interval '2 hours', now() - interval '2 hours')`);
  return { key, id };
}

/**
 * Today's spend, planted as one ended run of `trigger` on an item of its own: `standing.stuck`
 * spends the sweep's share, any other trigger the handoffs'.
 */
async function spend(trigger: 'standing.stuck' | 'feedback.filed', turns: number): Promise<void> {
  await rows(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                              acts_to_run, state, turns, not_before, queued_at, started_at, ended_at)
    VALUES (${projectId}, 'feedback', gen_random_uuid(), 'FB-900', ${trigger}, '[]'::jsonb,
            ARRAY['note']::text[], 'done', ${turns}, now(), now(), now(), now())`);
}

/** The check runs queued on the requirement: their trigger and when each is due. */
const checksQueued = (id: string) =>
  rows<{ trigger: string; due: string }>(sql`
    SELECT trigger, not_before AS due FROM steward_runs
     WHERE subject_id = ${id} AND state = 'queued' AND 'intake_check' = ANY(acts_to_run)`);

/** A sentence the fake read carries; nothing here renders it. */
const said = (text: string) => ({ key: text }) as unknown as Said;

function stuckIssue(issue: { id: string; key: string }, basis: string): ItemStanding {
  const says = { who: said('Master'), act: said('re-plan it'), rule: said('replan owed') };
  return {
    subject: { kind: 'issue', id: issue.id, key: issue.key },
    title: 'issue',
    group: 'stuck',
    waitingOn: {
      kind: 'master',
      who: 'Master',
      act: 're-plan it',
      rule: 'replan owed',
      ref: null,
      dueAt: null,
      says,
    },
    note: null,
    actClass: 'master_take',
    since: '2026-10-29T08:49:59.341Z',
    dueAt: null,
    stuck: {
      code: 'overdue',
      since: '2026-10-29T08:49:59.341Z',
      reason: `${issue.key} owes a re-plan for the agreed revision`,
      via: null,
      says: { reason: said('a re-plan is overdue') },
    },
    carriedBy: null,
    basis,
  };
}

/** One sweep of the project, its events delivered: the steward's consumer folds each into a run. */
async function swept(t = tally()) {
  await sweep.sweepProjectStandings(projectId, new Date(), t);
  await settleOutbox();
  return t;
}

/** Every stuck diagnosis on the item, live or ended. */
const diagnosesOf = (id: string) =>
  rows<{ id: string; state: string }>(sql`
    SELECT id, state FROM steward_runs
     WHERE subject_id = ${id} AND 'stuck_diagnosis' = ANY(acts_to_run) ORDER BY queued_at, id`);

/** End the item's queued diagnosis done on a note alone, as REQ-45's runs ended. */
async function endedOnNote(id: string, key: string): Promise<void> {
  const [run] = await rows<{ id: string }>(sql`
    UPDATE steward_runs SET state = 'done', started_at = now(), ended_at = now(), turns = 1
     WHERE subject_id = ${id} AND state = 'queued' RETURNING id`);
  await rows(sql`
    INSERT INTO steward_acts (run_id, project_id, act, door, did)
    VALUES (${run?.id}, ${projectId}, 'stuck_diagnosis',
            ${`PUT /api/projects/${projectId}/steward-notes/issue/${key}`},
            ${`Wrote the note on ${key}: it remains stuck, and an ask already stands.`})`);
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { provideStewardStandings } = await import('../../src/steward/index.js');
  provideStewardStandings(async (pid) => (pid === projectId ? standings : []));
  await startQueue();
  sweep = await import('../../src/steward/sweep.js');
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const as = requester(app, { owner: await signUserToken(ownerId) });
  say = (method, path, body) => as('owner', method, path.startsWith('/api/') ? path : at(path), body);
}, 120_000);

afterEach(async () => {
  standings = [];
  await rows(sql`DELETE FROM steward_runs WHERE project_id = ${projectId}`);
});

afterAll(async () => {
  await closeWorld();
});

describe('an owed check is a handoff, whatever room the sweep has left', () => {
  it("is queued though the sweep's share of the day is spent, as the handoff that owed it", async () => {
    seq += 1;
    const req = await agreedWithIssue(`Spent sweep ${seq}`);
    await spend('standing.stuck', 120);
    const now = new Date();
    const t = tally();
    await sweep.sweepProjectStandings(projectId, now, t);
    const queued = await checksQueued(req.id);
    expect(queued.map((q) => q.trigger)).toEqual(['requirement.agreed']);
    expect(new Date(queued[0]?.due ?? 0).getTime()).toBeLessThanOrEqual(
      now.getTime() + STEWARD_DEBOUNCE_MS,
    );
    expect(t.checks).toBe(1);
  });

  it('is queued due when the budget resumes where the whole day is spent, and its refusal names that time', async () => {
    seq += 1;
    const req = await agreedWithIssue(`Spent day ${seq}`);
    await spend('standing.stuck', 120);
    await spend('feedback.filed', 80);
    const now = new Date();
    const before = refusalsOf(await say('POST', `/requirements/${req.key}/start-delivery`, {}));
    expect(before.map((r) => r.code)).toEqual(['REQUIREMENT_UNCHECKED']);
    // not yet queued: it promises no hour the budget cannot keep, and names when the budget resumes
    expect(before[0]?.detail).toContain(resumesAfter(now).toISOString());

    await sweep.sweepProjectStandings(projectId, now, tally());
    const queued = await checksQueued(req.id);
    expect(queued.map((q) => [q.trigger, new Date(q.due).toISOString()])).toEqual([
      ['requirement.agreed', resumesAfter(now).toISOString()],
    ]);
    const refused = refusalsOf(await say('POST', `/requirements/${req.key}/start-delivery`, {}));
    expect(refused[0]?.code).toBe('REQUIREMENT_UNCHECKED');
    expect(refused[0]?.detail).toContain(`due at ${resumesAfter(now).toISOString()}`);
    expect(refused[0]?.detail).toContain('budget resumes');
    const check = ok(await say('GET', `/requirements/${req.key}`)).deliveryCheck;
    expect(check.attempt).toMatchObject({
      state: 'queued',
      dueAt: resumesAfter(now).toISOString(),
    });
  });
});

describe('one stuck item cannot spend the day (REQ-45, 2026-11-07)', () => {
  it('is not diagnosed again on an unchanged basis while an ask holds its standing', async () => {
    seq += 1;
    const issue = await createTestIssue(projectId, ownerId, 100 + seq, {
      status: 'reopen',
      createdAt: new Date(),
    });
    standings = [stuckIssue(issue, `stuck|replan|${seq}`)];
    await swept();
    expect(await diagnosesOf(issue.id)).toHaveLength(1);
    await endedOnNote(issue.id, issue.key);
    // the master was asked about it on this standing by the run of the requirement it carries, as
    // REQ-45's run asked about ISS-726, and the ask still stands
    const [asker] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, turns, not_before, queued_at, started_at, ended_at)
      VALUES (${projectId}, 'requirement', gen_random_uuid(), 'REQ-900', 'standing.stuck', '[]'::jsonb,
              ARRAY['stuck_diagnosis']::text[], 'done', 1, now(), now(), now(), now())
      RETURNING id`);
    await rows(sql`
      INSERT INTO steward_acts (run_id, project_id, act, door, did, master_ask)
      VALUES (${asker?.id}, ${projectId}, 'stuck_diagnosis', 'WAKE master.wake steward',
              ${`Asked the master about ${issue.key}`}, ${`${issue.key}: re-plan it for the agreed revision`})`);
    const { askedAlready } = await import('../../src/steward/asks.js');
    expect(await askedAlready(projectId, standings[0] as ItemStanding, new Date())).toMatch(
      /still stands/,
    );

    await swept();
    await swept();
    expect(await diagnosesOf(issue.id)).toHaveLength(1);
  });

  it('is diagnosed at most twice a day on one basis, whatever ended each (boundary)', async () => {
    seq += 1;
    const issue = await createTestIssue(projectId, ownerId, 100 + seq, {
      status: 'reopen',
      createdAt: new Date(),
    });
    standings = [stuckIssue(issue, `stuck|replan|${seq}`)];
    await swept();
    await endedOnNote(issue.id, issue.key);
    // nobody was asked, so the second diagnosis is owed (ISS-654) ...
    await swept();
    expect(await diagnosesOf(issue.id)).toHaveLength(2);
    await endedOnNote(issue.id, issue.key);
    // ... and a third is not, though it too ended on a note alone
    expect((await swept()).stuck).toBe(0);
    expect(await diagnosesOf(issue.id)).toHaveLength(2);
    // its basis moving is a new question, diagnosed at once
    standings = [stuckIssue(issue, `stuck|replan|${seq}|moved`)];
    await swept();
    expect(await diagnosesOf(issue.id)).toHaveLength(3);
  });
});

describe('the budget read never shows a side spent past what it may spend', () => {
  it("reads the handoffs' runner jobs within the day the sweep left them, their kept share apart", async () => {
    for (let i = 0; i < 10; i += 1) {
      await rows(sql`
        INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                  acts_to_run, state, not_before, queued_at, started_at)
        VALUES (${projectId}, 'feedback', gen_random_uuid(), ${`FB-${700 + i}`}, 'feedback.filed',
                '[]'::jsonb, ARRAY['triage_draft']::text[], 'running', now(), now(), now())`);
    }
    await spend('standing.stuck', 117);
    const budget = ok(await say('GET', '/steward-budget'));
    expect(budget.handoff.runnerJobs).toEqual({ spent: 10, of: 10 });
    expect(budget.handoff.kept).toEqual({ gatewayTurns: 80, runnerJobs: 4 });
    expect(budget.sweep.runnerJobs).toEqual({ spent: 0, of: 0 });
    expect(budget.sweep.gatewayTurns).toEqual({ spent: 117, of: 120 });
    expect(budget.handoff.gatewayTurns).toEqual({ spent: 0, of: 83 });
    for (const side of [budget.handoff, budget.sweep]) {
      for (const unit of [side.gatewayTurns, side.runnerJobs]) {
        expect(unit.spent).toBeLessThanOrEqual(unit.of);
      }
    }
  });
});
