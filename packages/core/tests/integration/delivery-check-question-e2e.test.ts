/**
 * A requirement's delivery check names only what can be cleared, and a check owed is taken, never left
 * owed in silence (ISS-1084; FB-551, FB-558, FB-548).
 * - A question the check names is a real question: it reads at `questions/:id`, is listed on its
 *   requirement, is answered at `questions/:id/answer` by the project's master who owes it, and its
 *   answer clears the move. A question comment the steward posted before ISS-688 was named by the gate
 *   at `/questions/<comment id>`, a door that answered 404, and no door answered it (adminhub-api REQ-8,
 *   sidcorp-mail REQ-6): migration 0623 asks each one still open as the question it was, under the
 *   same id.
 * - A check finishes on its own: a run carrying the check beside another act ends the check alone, so
 *   that act's refusal no longer leaves the check owed (forge REQ-45 r8, 2026-11-07: the run's
 *   stuck_diagnosis note was refused and the whole run failed).
 * - A check owed and no longer running is taken by the standing sweep, and the refusal says so
 *   (adminhub-api REQ-22: owed since its agree, its one gap answered).
 *
 * @direct-test-of packages/core/src/requirements/delivery-check.ts
 * @direct-test-of packages/core/src/steward/dispatch.ts
 * @direct-test-of packages/core/src/steward/owed-checks.ts
 * @direct-test-of packages/core/src/steward/sweep.ts
 * @direct-test-of packages/core/src/steward/holds.ts
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
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
  addProjectMember,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
} from '../helpers/factories.js';
import { stewardChecked } from '../helpers/steward-checked.js';

/** Which acts the steward's turns were asked to take; a stuck diagnosis is refused, as REQ-45's was. */
const turns = vi.hoisted(() => ({ acts: [] as string[] }));

vi.mock('../../src/steward/turn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/steward/turn.js')>()),
  runGatewayAct: async ({ act }: { act: string }) => {
    turns.acts.push(act);
    return act === 'stuck_diagnosis'
      ? {
          refused: [
            'PUT /api/projects/p/steward-notes/requirement/REQ-1: STEWARD_NOTE_CONTRADICTS line 1 says "planned"',
          ],
          broken: [],
          acts: [],
          error: null,
        }
      : { refused: [], broken: [], acts: [], error: null };
  },
}));

const LIFT = new URL(
  '../../drizzle/migrations/0623_a_check_question_is_a_question.sql',
  import.meta.url,
);

let say: (method: string, path: string, body?: unknown) => Promise<Reply>;
let master: (method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let seq = 0;
const at = (path: string) => `/api/projects/${projectId}${path}`;

const refusalsOf = (r: Reply) =>
  (r.json.error?.refusals ?? []) as { code: string; path: string; detail: string }[];

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
  // the agree and the breakdown queued the steward's check: each test plants the check it reads
  await rows(sql`DELETE FROM steward_runs WHERE project_id = ${projectId}`);
  const [row] = await rows<{ id: string }>(
    sql`SELECT id FROM requirements WHERE project_id = ${projectId} AND req_seq = ${Number(key.slice(4))}`,
  );
  return { key, id: row?.id ?? '' };
}

/**
 * A question comment a steward check posted before ISS-688, as `door-writes.ts` wrote it on
 * 2026-10-28 (its body's own format) with the act that cites it; nobody has replied to it.
 */
async function legacyQuestion(req: { key: string; id: string }): Promise<string> {
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  const steward = await stewardAccountOf(projectId);
  const [run] = await rows<{ id: string }>(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                              acts_to_run, state, not_before, started_at, ended_at, queued_at)
    VALUES (${projectId}, 'requirement', ${req.id}, ${req.key}, 'requirement.agreed', '[]'::jsonb,
            ARRAY['intake_check']::text[], 'done', '2026-10-28T03:00:00Z', '2026-10-28T03:00:00Z',
            '2026-10-28T03:01:00Z', '2026-10-28T03:00:00Z')
    RETURNING id`);
  const [comment] = await rows<{ id: string }>(sql`
    INSERT INTO comments (requirement_id, author_id, body, intent, created_at, updated_at)
    VALUES (${req.id}, ${steward},
            ${'Which environments count as production-tier for protected variables?\n\nOptions: marked-production: Use an environment marked Production; protected variables apply only there.; name-based: Treat environments named production or prod as production-tier.. Recommended: marked-production.'},
            'question', '2026-10-28T03:00:30Z', '2026-10-28T03:00:30Z')
    RETURNING id`);
  await rows(sql`
    INSERT INTO steward_acts (run_id, project_id, act, door, did, wrote, undo, at)
    VALUES (${run?.id}, ${projectId}, 'intake_check',
            ${`POST /api/projects/${projectId}/requirements/${req.key}/comments`},
            ${`Asked on ${req.key}: Which environments count as production-tier?`},
            ${JSON.stringify({ kind: 'comment', ref: comment?.id })}::jsonb,
            ${JSON.stringify({ door: `DELETE /api/projects/${projectId}/requirements/${req.key}/comments/${comment?.id}`, body: null })}::jsonb,
            '2026-10-28T03:00:30Z')`);
  return comment?.id ?? '';
}

/** Migration 0623 run over the rows a deploy finds, as the migrator runs it: statement by statement. */
async function lift(): Promise<void> {
  const { db } = await import('../../src/db/client.js');
  for (const statement of readFileSync(LIFT, 'utf8').split('--> statement-breakpoint')) {
    if (statement.replace(/--[^\n]*\n?/g, '').trim()) await db.execute(sql.raw(statement));
  }
}

async function checkOf(key: string) {
  return ok(await say('GET', `/requirements/${key}`)).deliveryCheck as {
    owed: boolean;
    checkedAt: string | null;
    questions: { id: string; owedBy: string }[];
    clear: boolean;
  };
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'member');
  const pat = await mintPat({
    permissions: ['*'],
    userId: agentId,
    name: 'master',
    projectIds: [projectId],
  });
  const as = requester(app, { owner: await signUserToken(ownerId), master: pat.plaintext });
  say = (method, path, body) =>
    as('owner', method, path.startsWith('/api/') ? path : at(path), body);
  master = (method, path, body) =>
    as('master', method, path.startsWith('/api/') ? path : at(path), body);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a question the delivery check names is a real question (FB-551, FB-558)', () => {
  let req = { key: '', id: '' };
  let legacy = '';

  it('names no question it cannot serve: every one it refuses on reads at its door, and says how it is answered', async () => {
    seq += 1;
    req = await agreedWithIssue(`Legacy check ${seq}`);
    legacy = await legacyQuestion(req);
    const refused = await say('POST', `/requirements/${req.key}/start-delivery`, {});
    expect(refused.status).toBe(422);
    for (const r of refusalsOf(refused).filter((x) => x.code === 'REQUIREMENT_QUESTION_OPEN')) {
      const read = await say('GET', `/api${r.path}`);
      expect(read.status, `the gate named ${r.path}, which reads ${read.status}`).toBe(200);
      expect(r.detail).toContain(`POST /api${r.path}/answer`);
    }
  });

  it('once lifted, the question reads at its own id, is listed on its requirement and owed by the master', async () => {
    await lift();
    // a second run converges: the lift takes nothing twice
    await lift();
    const read = ok(await say('GET', `/api/questions/${legacy}`));
    expect(read).toMatchObject({
      id: legacy,
      status: 'open',
      blockerKind: 'master_or_peer',
      answerShape: 'free_text',
      prompt: 'Which environments count as production-tier for protected variables?',
    });
    expect(read.needed).toContain('marked-production');
    const page = ok(await say('GET', `/requirements/${req.key}`));
    expect((page.questions as { id: string }[]).map((q) => q.id)).toContain(legacy);
    await stewardChecked(projectId, req.key);
    expect((await checkOf(req.key)).questions).toEqual([
      expect.objectContaining({ id: legacy, owedBy: 'master' }),
    ]);
    const refused = await say('POST', `/requirements/${req.key}/start-delivery`, {});
    expect(refusalsOf(refused).map((r) => [r.code, r.path])).toEqual([
      ['REQUIREMENT_QUESTION_OPEN', `/questions/${legacy}`],
    ]);
    const { breakdownsHeldBySteward } = await import('../../src/steward/holds.js');
    expect(await breakdownsHeldBySteward(projectId)).toContain(req.key);
  });

  it('is answered by the master at its answer door, and the answer clears the move', async () => {
    ok(
      await master('POST', `/api/questions/${legacy}/answer`, {
        round: 1,
        text: 'marked-production: only an environment marked Production is production-tier',
      }),
    );
    expect(await checkOf(req.key)).toMatchObject({ questions: [], clear: true });
    const decisions = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE requirement_id = ${req.id} AND intent = 'decision'`,
    );
    expect(decisions.map((d) => d.body).join('\n')).toContain('marked-production');
    const { breakdownsHeldBySteward } = await import('../../src/steward/holds.js');
    expect(await breakdownsHeldBySteward(projectId)).not.toContain(req.key);
    const moved = await say('POST', `/requirements/${req.key}/start-delivery`, {});
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
  });
});

describe('a check finishes on its own, and one owed is taken (FB-548)', () => {
  it("finishes the check though another act its run carried was refused (REQ-45's run)", async () => {
    seq += 1;
    const req = await agreedWithIssue(`Folded check ${seq}`);
    await rows(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, not_before, queued_at)
      VALUES (${projectId}, 'requirement', ${req.id}, ${req.key}, 'requirement.agreed', '[]'::jsonb,
              ARRAY['intake_check', 'stuck_diagnosis']::text[], 'queued', now() - interval '1 minute',
              now() - interval '3 minutes')`);
    turns.acts = [];
    const { dispatchStewardRuns } = await import('../../src/steward/dispatch.js');
    await dispatchStewardRuns(new Date());
    expect(turns.acts).toEqual(['intake_check']);
    expect((await checkOf(req.key)).checkedAt).not.toBeNull();
    // the diagnosis is not dropped: it waits in the run the check's end queued
    const next = await rows<{ acts: string[]; state: string }>(sql`
      SELECT acts_to_run AS acts, state FROM steward_runs
       WHERE subject_id = ${req.id} AND state = 'queued'`);
    expect(next).toEqual([{ acts: ['stuck_diagnosis'], state: 'queued' }]);
  });

  it('a check owed after its gap was answered is refused naming the sweep, then taken by it and finished', async () => {
    seq += 1;
    const req = await agreedWithIssue(`Owed check ${seq}`);
    // the check asked about its one gap and its run failed on another act, two hours ago
    await rows(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, failure, failure_kind, not_before, queued_at,
                                started_at, ended_at)
      VALUES (${projectId}, 'requirement', ${req.id}, ${req.key}, 'requirement.agreed', '[]'::jsonb,
              ARRAY['intake_check', 'stuck_diagnosis']::text[], 'failed',
              'stuck_diagnosis: the door refused PUT …/steward-notes/requirement: STEWARD_NOTE_CONTRADICTS',
              'refused', now() - interval '2 hours', now() - interval '2 hours',
              now() - interval '2 hours', now() - interval '2 hours')`);
    const asked = ok(
      await master('POST', '/api/questions', {
        projectId,
        about: { requirement: req.key },
        blockerKind: 'master_or_peer',
        prompt: `${req.key} names no workflow it changes. Which one should delivery use?`,
        options: [
          {
            id: 'none',
            label: 'None: it changes no drawn workflow',
            authority: 'writer',
            bindsTo: 'session',
            executedBy: 'agent',
          },
          {
            id: 'link',
            label: 'Link the board workflow',
            authority: 'writer',
            bindsTo: 'session',
            executedBy: 'agent',
          },
        ],
        recommendedOptionId: 'none',
      }),
      201,
    );
    ok(await master('POST', `/api/questions/${asked.id}/answer`, { round: 1, optionId: 'none' }));
    expect(await checkOf(req.key)).toMatchObject({ owed: true, checkedAt: null, questions: [] });
    const refused = await say('POST', `/requirements/${req.key}/start-delivery`, {});
    const [unchecked] = refusalsOf(refused);
    expect(unchecked?.code).toBe('REQUIREMENT_UNCHECKED');
    expect(unchecked?.detail).toMatch(/ended failed/);
    expect(unchecked?.detail).toMatch(/sweep/);

    const { sweepProjectStandings } = await import('../../src/steward/sweep.js');
    const tally = { projects: 0, stuck: 0, changed: 0, settledAsks: 0, paced: 0, checks: 0 };
    await sweepProjectStandings(projectId, new Date(), tally);
    const raised = await rows<{ acts: string[] }>(sql`
      SELECT acts_to_run AS acts FROM steward_runs
       WHERE subject_id = ${req.id} AND state = 'queued'`);
    expect(raised.map((r) => r.acts)).toContainEqual(['intake_check']);
    // a second sweep while it is queued raises nothing more
    await sweepProjectStandings(projectId, new Date(), tally);
    const live = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM steward_runs
       WHERE subject_id = ${req.id} AND state IN ('queued', 'running')`);
    expect(live[0]?.n).toBe(1);

    turns.acts = [];
    const { dispatchStewardRuns } = await import('../../src/steward/dispatch.js');
    await dispatchStewardRuns(new Date(Date.now() + 10 * 60_000));
    expect(turns.acts).toContain('intake_check');
    expect((await checkOf(req.key)).checkedAt).not.toBeNull();
    const moved = await say('POST', `/requirements/${req.key}/start-delivery`, {});
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
  });

  it('a check that failed within the hour is not raised again yet', async () => {
    seq += 1;
    const req = await agreedWithIssue(`Fresh failure ${seq}`);
    await rows(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, failure, failure_kind, not_before, queued_at,
                                started_at, ended_at)
      VALUES (${projectId}, 'requirement', ${req.id}, ${req.key}, 'requirement.agreed', '[]'::jsonb,
              ARRAY['intake_check']::text[], 'failed', 'intake_check: the turn did not finish: timeout',
              'error', now() - interval '20 minutes', now() - interval '20 minutes',
              now() - interval '20 minutes', now() - interval '10 minutes')`);
    const refused = await say('POST', `/requirements/${req.key}/start-delivery`, {});
    expect(refusalsOf(refused)[0]?.detail).toMatch(/the turn did not finish/);
    const { sweepProjectStandings } = await import('../../src/steward/sweep.js');
    const tally = { projects: 0, stuck: 0, changed: 0, settledAsks: 0, paced: 0, checks: 0 };
    await sweepProjectStandings(projectId, new Date(), tally);
    const raised = await rows<{ id: string }>(sql`
      SELECT id FROM steward_runs
       WHERE subject_id = ${req.id} AND state = 'queued' AND 'intake_check' = ANY(acts_to_run)`);
    expect(raised).toEqual([]);
  });
});
