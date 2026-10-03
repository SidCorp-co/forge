/**
 * ISS-54 — the ten-status issue lifecycle (workflow `issue-lifecycle`, approved revision 2), at the
 * REST door a client on that model uses: every move outside the lifecycle and every guard on a
 * move inside it is refused by name, and the parks return to the status they left. Each case
 * below is the planted input its guard exists to refuse; `issues/transition-guards.ts` is the rule.
 *
 * Real Postgres, because the guards read the row inside the transition's own transaction — the
 * holder on `issue_work_state`, the plan columns, the verdict comments — and the left status is
 * written there in the same write.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedProjectDocument,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let mintPat: typeof import('../../src/auth/pat.js')['mintPat'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV ??= 'test';

  const [transitionMod, routesMod, patMod, errMod] = await Promise.all([
    import('../../src/issues/transition.js'),
    import('../../src/issues/routes.js'),
    import('../../src/auth/pat.js'),
    import('../../src/middleware/error.js'),
  ]);
  mintPat = patMod.mintPat;
  app = new Hono();
  app.route('/api/issues', routesMod.issueRoutes);
  app.route('/api/issues', transitionMod.transitionRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

const PASSING_SHA = '33637c612ef15be6f924520c0d201a0889d8ed7e';

interface World {
  projectId: string;
  humanId: string;
  human: string;
  agent: string;
}

async function world(): Promise<World> {
  const human = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const agent = await createTestUser(harness.db, { kind: 'agent' });
  const project = await createTestProject(harness.db, human.id);
  await createTestProjectMember(harness.db, { userId: agent.id, projectId: project.id });
  const h = await mintPat({ userId: human.id, name: 'person', boundProjectId: project.id });
  const a = await mintPat({ userId: agent.id, name: 'agent', boundProjectId: project.id });
  return { projectId: project.id, humanId: human.id, human: h.plaintext, agent: a.plaintext };
}

async function insertIssue(
  w: World,
  status: string,
  extra: { plan?: string; criteria?: string; mergedAt?: boolean; waitingKind?: string } = {},
): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id, status, plan, acceptance_criteria,
                        merged_at, waiting_kind)
    VALUES (${w.projectId}::uuid, 'an issue', ${w.humanId}::uuid, ${status},
            ${extra.plan ?? null}, ${extra.criteria ?? null},
            ${extra.mergedAt ? sql`now()` : sql`NULL`}, ${extra.waitingKind ?? null})
    RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

/** A live lease on the issue's work state: what a claim leaves behind. */
async function holdLease(issueId: string): Promise<void> {
  const lease = { holder: 'run-iss54', renewedAt: new Date().toISOString(), minutes: 30 };
  await harness.db.execute(sql`
    INSERT INTO issue_work_state (issue_id, lease) VALUES (${issueId}, ${JSON.stringify(lease)}::jsonb)
    ON CONFLICT (issue_id) DO UPDATE SET lease = EXCLUDED.lease
  `);
}

async function postVerdicts(
  w: World,
  issueId: string,
  verdicts: Array<{ criterion: number; verdict: string; identity?: boolean }>,
): Promise<void> {
  const blocks = verdicts.flatMap((v) => [
    `criterion: ${v.criterion} — exercised`,
    `verdict: ${v.verdict}`,
    ...(v.identity === false ? [] : [`runtime: ${PASSING_SHA}`]),
    'why: exercised directly',
    '',
  ]);
  const body = [
    '## Judged',
    '',
    '```forge-record',
    ...blocks,
    '```',
    '',
    '`forge-record: verdict · contract 1`',
  ].join('\n');
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, body)
    VALUES (gen_random_uuid(), ${issueId}, ${w.humanId}, ${body})
  `);
}

async function move(
  issueId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(`/api/issues/${issueId}/transition`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'X-Forge-Lifecycle': '10',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function statusOf(issueId: string): Promise<{ status: string; waitingKind: string | null }> {
  const rows = (await harness.db.execute(sql`
    SELECT status, waiting_kind FROM issues WHERE id = ${issueId}
  `)) as unknown as Array<{ status: string; waiting_kind: string | null }>;
  const row = rows[0] as { status: string; waiting_kind: string | null };
  return { status: row.status, waitingKind: row.waiting_kind };
}

async function workStateOf(issueId: string) {
  const rows = (await harness.db.execute(sql`
    SELECT step, left_status, legacy_status FROM issue_work_state WHERE issue_id = ${issueId}
  `)) as unknown as Array<{
    step: string | null;
    left_status: string | null;
    legacy_status: string | null;
  }>;
  return rows[0] ?? null;
}

function expectRefused(
  res: { status: number; body: Record<string, unknown> },
  http: number,
  code: string,
) {
  expect(res.body.code, JSON.stringify(res.body)).toBe(code);
  expect(res.status).toBe(http);
}

describe('ILLEGAL_TRANSITION: only the lifecycle edges are moves', () => {
  it('refuses a move the table does not hold, naming the moves that are legal', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open', { plan: 'p', criteria: '1. c' });
    const res = await move(id, w.human, { toStatus: 'approved' });
    expectRefused(res, 409, 'ILLEGAL_TRANSITION');
    expect(String(res.body.message)).toContain('`in_progress`');
    expect((await statusOf(id)).status).toBe('open');
  });

  it('never re-enters draft', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    const res = await move(id, w.human, { toStatus: 'draft' });
    expectRefused(res, 409, 'ILLEGAL_TRANSITION');
    expect(String(res.body.message)).toContain('never entered again');
  });

  it('maps a retired name it is sent, and says so in a warning', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    await holdLease(id);
    const res = await move(id, w.human, { toStatus: 'confirmed' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_progress');
    expect(String((res.body.warnings as string[])[0])).toContain('STATUS_RETIRED');
  });
});

describe('NO_HOLDER: in_progress says a run holds it', () => {
  it('refuses the claim move while nothing holds the issue', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    const res = await move(id, w.agent, { toStatus: 'in_progress' });
    expectRefused(res, 409, 'NO_HOLDER');
    expect((await statusOf(id)).status).toBe('open');
  });

  it('takes it once a live lease holds it, and opens the triage step', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    await holdLease(id);
    const res = await move(id, w.agent, { toStatus: 'in_progress' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.step).toBe('triage');
    expect((await workStateOf(id))?.step).toBe('triage');
  });

  it('an expired lease holds nothing', async () => {
    const w = await world();
    const id = await insertIssue(w, 'approved', { plan: 'p', criteria: '1. c' });
    const stale = { holder: 'run-old', renewedAt: '2020-01-01T00:00:00Z', minutes: 30 };
    await harness.db.execute(sql`
      INSERT INTO issue_work_state (issue_id, lease) VALUES (${id}, ${JSON.stringify(stale)}::jsonb)
    `);
    expectRefused(await move(id, w.agent, { toStatus: 'in_progress' }), 409, 'NO_HOLDER');
  });

  it('an unexpired lease whose holder stopped beating holds nothing', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    const now = Date.now();
    const silent = {
      holder: 'run-quiet',
      renewedAt: new Date(now - 60_000).toISOString(),
      minutes: 60,
      heartbeat: { at: new Date(now - 10 * 60_000).toISOString(), everySeconds: 30 },
    };
    await harness.db.execute(sql`
      INSERT INTO issue_work_state (issue_id, lease) VALUES (${id}, ${JSON.stringify(silent)}::text::jsonb)
    `);
    expectRefused(await move(id, w.agent, { toStatus: 'in_progress' }), 409, 'NO_HOLDER');
  });
});

describe('PLAN_REQUIRED: approved is the plan checkpoint', () => {
  it('refuses approved with no plan or criteria written, naming each', async () => {
    const w = await world();
    const id = await insertIssue(w, 'in_progress');
    const res = await move(id, w.agent, { toStatus: 'approved' });
    expectRefused(res, 422, 'PLAN_REQUIRED');
    expect((res.body.details as { missing: string[] }).missing).toEqual([
      'plan',
      'acceptanceCriteria',
    ]);
  });

  it('takes approved once both are written', async () => {
    const w = await world();
    const id = await insertIssue(w, 'in_progress', { plan: 'the plan', criteria: '1. it works' });
    expect((await move(id, w.agent, { toStatus: 'approved' })).status).toBe(200);
  });

  it('where the project requires a person, refuses an agent and takes a person', async () => {
    const w = await world();
    await seedProjectDocument(harness.db, w.projectId, w.humanId, { environments: {} });
    await harness.db.execute(sql`
      UPDATE project_config_documents
         SET document = jsonb_set(document, '{plan}', '{"approval":{"required":true}}'::jsonb)
       WHERE project_id = ${w.projectId}
    `);
    const id = await insertIssue(w, 'in_progress', { plan: 'the plan', criteria: '1. it works' });
    const refused = await move(id, w.agent, { toStatus: 'approved' });
    expectRefused(refused, 422, 'PLAN_REQUIRED');
    expect((refused.body.details as { rule: string }).rule).toBe('plan.approval.required');
    expect((await move(id, w.human, { toStatus: 'approved' })).status).toBe(200);
  });
});

describe('awaiting_release needs a passing verdict on every criterion', () => {
  it('refuses with no numbered criteria (NO_WORK_EVIDENCE)', async () => {
    const w = await world();
    const id = await insertIssue(w, 'in_progress');
    expectRefused(
      await move(id, w.agent, { toStatus: 'awaiting_release' }),
      409,
      'NO_WORK_EVIDENCE',
    );
  });

  it('refuses while a criterion has no verdict or a failing one, naming them', async () => {
    const w = await world();
    const id = await insertIssue(w, 'in_progress', { criteria: '1. one\n2. two\n3. three' });
    await postVerdicts(w, id, [
      { criterion: 1, verdict: 'pass' },
      { criterion: 2, verdict: 'fail' },
    ]);
    const res = await move(id, w.agent, { toStatus: 'awaiting_release' });
    expectRefused(res, 409, 'NO_WORK_EVIDENCE');
    expect((res.body.details as { unpassed: unknown[] }).unpassed).toEqual([
      { criterion: 2, verdict: 'fail' },
      { criterion: 3, verdict: null },
    ]);
  });

  it('refuses a passing verdict that names no identity (VERDICT_IDENTITY_REQUIRED)', async () => {
    const w = await world();
    const id = await insertIssue(w, 'in_progress', { criteria: '1. one' });
    await postVerdicts(w, id, [{ criterion: 1, verdict: 'pass', identity: false }]);
    expectRefused(
      await move(id, w.agent, { toStatus: 'awaiting_release' }),
      422,
      'VERDICT_IDENTITY_REQUIRED',
    );
  });

  it('takes it when the newest verdict on each criterion passes', async () => {
    const w = await world();
    const id = await insertIssue(w, 'in_progress', { criteria: '1. one\n2. two' });
    await postVerdicts(w, id, [{ criterion: 1, verdict: 'fail' }]);
    await postVerdicts(w, id, [
      { criterion: 1, verdict: 'pass' },
      { criterion: 2, verdict: 'short' },
    ]);
    const res = await move(id, w.agent, { toStatus: 'awaiting_release' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('closed means shipped', () => {
  it('refuses a close with no merged_at (CLOSE_REQUIRES_SHIPPED)', async () => {
    const w = await world();
    const id = await insertIssue(w, 'awaiting_release');
    expectRefused(await move(id, w.human, { toStatus: 'closed' }), 422, 'CLOSE_REQUIRES_SHIPPED');
  });

  it('takes it once the shipped claim is on the row', async () => {
    const w = await world();
    await seedProjectDocument(harness.db, w.projectId, w.humanId, { environments: {} });
    const id = await insertIssue(w, 'awaiting_release', { mergedAt: true });
    const res = await move(id, w.human, { toStatus: 'closed' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('reasons and kinds', () => {
  it('needs_info without a question is TRANSITION_REASON_REQUIRED', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    expectRefused(
      await move(id, w.human, { toStatus: 'needs_info', waitingKind: 'needs_answer' }),
      422,
      'TRANSITION_REASON_REQUIRED',
    );
  });

  it('needs_info without a kind is WAITING_KIND_REQUIRED', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    expectRefused(
      await move(id, w.human, { toStatus: 'needs_info', reason: 'which tenant?' }),
      422,
      'WAITING_KIND_REQUIRED',
    );
  });

  it('on_hold and reopen without a reason are TRANSITION_REASON_REQUIRED', async () => {
    const w = await world();
    const open = await insertIssue(w, 'open');
    expectRefused(
      await move(open, w.human, { toStatus: 'on_hold' }),
      422,
      'TRANSITION_REASON_REQUIRED',
    );
    const shipped = await insertIssue(w, 'closed', { mergedAt: true });
    expectRefused(
      await move(shipped, w.human, { toStatus: 'reopen' }),
      422,
      'TRANSITION_REASON_REQUIRED',
    );
  });

  it('dropped without a reason is VOID_REASON_REQUIRED', async () => {
    const w = await world();
    const id = await insertIssue(w, 'draft');
    expectRefused(await move(id, w.human, { toStatus: 'dropped' }), 422, 'VOID_REASON_REQUIRED');
    expect(
      (await move(id, w.human, { toStatus: 'dropped', reason: 'a duplicate of another' })).status,
    ).toBe(200);
  });

  it('a kind on any target but needs_info is WAITING_KIND_NOT_APPLICABLE', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    expectRefused(
      await move(id, w.human, {
        toStatus: 'on_hold',
        reason: 'paused',
        waitingKind: 'needs_decision',
      }),
      422,
      'WAITING_KIND_NOT_APPLICABLE',
    );
  });
});

describe('a park returns to the status it left', () => {
  it('records the left status on the way in, and refuses any other way back', async () => {
    const w = await world();
    const id = await insertIssue(w, 'approved', { plan: 'p', criteria: '1. c' });
    const parked = await move(id, w.human, {
      toStatus: 'needs_info',
      reason: 'which tenant?',
      waitingKind: 'needs_decision',
    });
    expect(parked.status, JSON.stringify(parked.body)).toBe(200);
    expect(await statusOf(id)).toEqual({ status: 'needs_info', waitingKind: 'needs_decision' });
    expect((await workStateOf(id))?.left_status).toBe('approved');

    const wrong = await move(id, w.human, { toStatus: 'open' });
    expectRefused(wrong, 409, 'ILLEGAL_TRANSITION');
    expect(String(wrong.body.message)).toContain(
      'returns to the status it left, which is `approved`',
    );

    const back = await move(id, w.human, { toStatus: 'approved' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await statusOf(id)).toEqual({ status: 'approved', waitingKind: null });
    expect((await workStateOf(id))?.left_status).toBeNull();
  });

  it('crossing to the other park keeps the status first left', async () => {
    const w = await world();
    const id = await insertIssue(w, 'awaiting_release');
    const held = await move(id, w.human, { toStatus: 'on_hold', reason: 'freeze week' });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const asked = await move(id, w.human, {
      toStatus: 'needs_info',
      reason: 'ship it?',
      waitingKind: 'needs_decision',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect((await workStateOf(id))?.left_status).toBe('awaiting_release');
    expectRefused(await move(id, w.human, { toStatus: 'open' }), 409, 'ILLEGAL_TRANSITION');
    expect((await move(id, w.human, { toStatus: 'awaiting_release' })).status).toBe(200);
  });

  it('a park returning to in_progress is the park edge, not a claim', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    await holdLease(id);
    expect((await move(id, w.agent, { toStatus: 'in_progress' })).status).toBe(200);
    await harness.db.execute(sql`UPDATE issue_work_state SET lease = NULL WHERE issue_id = ${id}`);
    expect(
      (await move(id, w.human, { toStatus: 'on_hold', reason: 'paused by the owner' })).status,
    ).toBe(200);
    expect((await move(id, w.human, { toStatus: 'in_progress' })).status).toBe(200);
    expect((await workStateOf(id))?.step).toBe('triage');
  });
});
