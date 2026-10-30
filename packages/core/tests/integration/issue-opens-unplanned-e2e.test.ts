/**
 * ISS-778: the plan is the run's to write, and a run starts only on an open issue, so the issue-ready
 * check (draft → open) no longer asks for one. A draft linked to an agreed requirement, its criteria
 * traced, opens against that requirement's current revision (Issue lifecycle ready-check, item 1:
 * "the revision it plans against"). The plan is asked where the run writes it: the work enters build
 * only with a plan written against a revision of the requirement the issue delivers, refused
 * PLAN_REQUIRED by name on the work step's write and resumed at design on a claim, under gate
 * `design_record` (off under yolo).
 *
 * The planted state is what the link door writes (`requirements/issue-links.ts:linkIssue` without
 * `adoptPlan`): the requirement linked, no revision planned, criteria traced to its BC.
 *
 * @direct-test-of packages/core/src/issues/checklist-record.ts
 * @direct-test-of packages/core/src/issues/plan-checkpoint.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  completeIssueReadyRecord,
  createTestIssue,
  createTestUser,
  rows,
  seedIssueStatus,
} from '../helpers/factories.js';
import { refusalCodes as codes, projectBuiltFrom, type Res } from '../helpers/pattern-world.js';

let adminId = '';
let owner = '';
let author = '';
const projects = { standard: '', yolo: '' };

async function call(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
}

const details = (res: Res): string =>
  (res.body?.error?.refusals ?? []).map((r: Doc) => r.detail).join(' | ');

function ok(res: Res): Doc {
  expect([res.status, details(res)]).toEqual([200, '']);
  return res.body;
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const admin = await createTestUser({ verified: true });
  const agent = await createTestUser({ kind: 'agent' });
  adminId = admin.id;
  for (const key of Object.keys(projects) as Array<keyof typeof projects>) {
    projects[key] = await projectBuiltFrom(admin.id, `github.com/acme/unplanned-${key}`);
    await addProjectMember(projects[key], admin.id, 'admin');
    await addProjectMember(projects[key], agent.id, 'member');
  }
  owner = await userToken(admin.id);
  author = await userToken(agent.id);
  const read = ok(await call(owner, 'GET', `/api/projects/${projects.yolo}/gates`));
  ok(
    await call(owner, 'PUT', `/api/projects/${projects.yolo}/gates`, {
      baseRevision: read.revision,
      profile: 'yolo',
      overrides: {},
      reason: 'planted: yolo for the unplanned build test',
    }),
  );
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

let seq = 0;

/**
 * A draft linked to its own agreed REQ at revision 1 with one criterion traced to BC-1, no revision
 * planned, and `plan` as given; its design passes the design check.
 */
async function linkedDraft(projectId: string, plan: string | null = null): Promise<string> {
  seq += 1;
  const { id } = await createTestIssue(projectId, adminId, seq, {
    status: 'draft',
    createdAt: new Date(),
  });
  await completeIssueReadyRecord(projectId, adminId, id, seq);
  await db.execute(sql`UPDATE issues SET planned_revision = NULL, plan = ${plan} WHERE id = ${id}`);
  ok(
    await call(author, 'PUT', `/api/issues/${id}/design`, {
      criteria: [{ criterion: 1, class: 'observable', pattern: null, proof: 'run it' }],
      modules: [],
      contracts: [],
    }),
  );
  return id;
}

const move = (issue: string, toStatus: string) =>
  call(owner, 'POST', `/api/issues/${issue}/transition`, { toStatus });

const step = (issue: string, to: string) =>
  call(author, 'PATCH', `/api/issues/${issue}`, { workState: { step: to } });

async function leased(issue: string): Promise<void> {
  const lease = sql`jsonb_build_object('holder', 'run-1', 'renewedAt', now()::text, 'minutes', 30)`;
  await db.execute(sql`
    INSERT INTO issue_work_state (issue_id, lease) VALUES (${issue}, ${lease})
    ON CONFLICT (issue_id) DO UPDATE SET lease = EXCLUDED.lease`);
}

async function rowOf(issue: string) {
  const [row] = await rows<{
    status: string;
    planned_revision: number | null;
    step: string | null;
  }>(
    sql`SELECT i.status, i.planned_revision, w.step
          FROM issues i LEFT JOIN issue_work_state w ON w.issue_id = i.id WHERE i.id = ${issue}`,
  );
  return row;
}

/**
 * Standing at open, then claimed by a run and taken to design. Its open is seeded, so the build
 * check is judged on its own: the open through the door is the first describe's.
 */
async function atDesign(projectId: string, plan: string | null = null): Promise<string> {
  const issue = await linkedDraft(projectId, plan);
  await seedIssueStatus(issue, 'open');
  await leased(issue);
  expect(ok(await move(issue, 'in_progress')).step).toBe('triage');
  ok(await step(issue, 'design'));
  return issue;
}

describe('a draft linked to an agreed requirement, with no plan', () => {
  it('opens under standard against the current revision, recording that answer on the move', async () => {
    const issue = await linkedDraft(projects.standard);
    const res = await move(issue, 'open');
    expect([res.status, details(res)]).toEqual([200, '']);
    expect((await rowOf(issue))?.status).toBe('open');
    const [moved] = await rows<{ checklist_answers: Array<{ question: string; value: string }> }>(
      sql`SELECT checklist_answers FROM kernel_transitions
           WHERE entity = 'issue' AND entity_id = ${issue} AND to_status = 'open'`,
    );
    const answer = (q: string) => moved?.checklist_answers.find((a) => a.question === q)?.value;
    expect(answer('requirement')).toBe(
      `REQ-${seq} at revision 1, its current one, which the run's plan is written against`,
    );
    expect(answer('criteria')).toBe(`1 criterion, tracing BC-1 of REQ-${seq} revision 1`);
  });

  it('reads the checklist complete before the move, naming no plan', async () => {
    const issue = await linkedDraft(projects.standard);
    const read = ok(await call(owner, 'GET', `/api/issues/${issue}/checklist`));
    const ready = (read.checklists as Doc[]).find((c) => c.id === 'issue_ready');
    expect(ready?.now?.complete).toBe(true);
    expect(JSON.stringify(ready)).not.toMatch(/has no plan|write (the issue's|its) plan/i);
  });
});

describe('the plan is asked where the run writes it: the move into build', () => {
  it('refuses build by name until the plan is written, then records its revision and lets it in', async () => {
    const issue = await atDesign(projects.standard);
    const res = await step(issue, 'build');
    expect([res.status, codes(res)]).toEqual([422, ['PLAN_REQUIRED']]);
    const said = details(res);
    expect(said).toContain(`\`build\` waits for a plan: the issue delivers REQ-${seq}`);
    expect(said).toContain(`records REQ-${seq} revision 1 as the one it is written against`);
    expect(said).toContain('Gate design_record is enforced');
    expect((await rowOf(issue))?.step).toBe('design');

    ok(await call(author, 'PATCH', `/api/issues/${issue}`, { plan: 'Build it as REQ says.' }));
    expect((await rowOf(issue))?.planned_revision).toBe(1);
    ok(await step(issue, 'build'));
    expect((await rowOf(issue))?.step).toBe('build');
  });

  it('lets one write carry the plan and the move into build', async () => {
    const issue = await atDesign(projects.standard);
    ok(
      await call(author, 'PATCH', `/api/issues/${issue}`, {
        plan: 'Build it as REQ says.',
        workState: { step: 'build' },
      }),
    );
    expect(await rowOf(issue)).toMatchObject({ planned_revision: 1, step: 'build' });
  });

  it('names a plan saved before the link, which names no revision, and asks to save it again', async () => {
    const issue = await atDesign(projects.standard, 'An old plan, written before the link.');
    const res = await step(issue, 'build');
    expect(codes(res)).toEqual(['PLAN_REQUIRED']);
    expect(details(res)).toContain(
      `the issue's plan was saved before it was linked to REQ-${seq}, so it names no revision. Save the plan again`,
    );
  });

  it('resumes a claim from reopen at design while the plan is missing', async () => {
    const issue = await linkedDraft(projects.standard);
    await seedIssueStatus(issue, 'reopen');
    await leased(issue);
    expect(ok(await move(issue, 'in_progress')).step).toBe('design');
    expect(codes(await step(issue, 'build'))).toEqual(['PLAN_REQUIRED']);
  });

  it('asks nothing under yolo, whose design_record gate is off', async () => {
    const issue = await atDesign(projects.yolo);
    ok(await step(issue, 'build'));
    expect((await rowOf(issue))?.step).toBe('build');
  });
});
