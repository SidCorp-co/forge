/**
 * ISS-642, REQ-2 BC-4 under REQ-76's gate plan_approval: where the gate is enforced, the work reaches
 * build only once the issue passed `approved` since its plan was last written (issue-lifecycle,
 * the back edge design-check -> in_progress). A run moving its work step into build, test or release
 * before that is refused PLAN_APPROVAL_PENDING, naming plans.approve, the gate, the profile and the
 * key that relaxes it (BC-11), and a claim from reopen resumes at design rather than build. Where the
 * gate is off (yolo, or standard without plan.approval.required) nothing changes. The profile is set
 * through the gates door, as a person sets it.
 *
 * @direct-test-of packages/core/src/issues/plan-checkpoint.ts
 * @direct-test-of packages/core/src/issues/update-service.ts
 * @direct-test-of packages/core/src/issues/apply-transition.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestUser,
  recordStatusMove,
  rows,
  seedIssueStatus,
} from '../helpers/factories.js';
import { refusalCodes as codes, projectBuiltFrom, type Res } from '../helpers/pattern-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

let adminId = '';
let owner = '';
let author = '';
const projects = { strict: '', yolo: '', standard: '', standardKeyed: '' };

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

async function setGates(projectId: string, profile: string): Promise<void> {
  const read = ok(await call(owner, 'GET', `/api/projects/${projectId}/gates`));
  ok(
    await call(owner, 'PUT', `/api/projects/${projectId}/gates`, {
      baseRevision: read.revision,
      profile,
      overrides: {},
      reason: `planted: ${profile} for the plan checkpoint test`,
    }),
  );
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const admin = await createTestUser({ verified: true });
  const agent = await createTestUser({ kind: 'agent' });
  adminId = admin.id;
  // no catalog and no module label: a design names no pattern and no module (ISS-609)
  for (const key of Object.keys(projects) as Array<keyof typeof projects>) {
    projects[key] = await projectBuiltFrom(admin.id, `github.com/acme/plan-gate-${key}`);
    await addProjectMember(projects[key], admin.id, 'admin');
    await addProjectMember(projects[key], agent.id, 'member');
  }
  // standard deferring to the project's own switch, set on
  await seedProjectDocument(projects.standardKeyed, admin.id, {
    environments: {
      dev: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
    },
    source: {
      type: 'git',
      git: {
        repository: 'github.com/acme/plan-gate-standardKeyed',
        defaultBranch: 'main',
        branches: ['main'],
      },
    },
    extra: { plan: { approval: { required: true } } } as never,
  });
  owner = await userToken(admin.id);
  author = await userToken(agent.id);
  await setGates(projects.strict, 'strict');
  await setGates(projects.yolo, 'yolo');
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

let seq = 0;

/** An issue at `status` with a plan, criteria and a design that passes the design check. */
async function issueAt(projectId: string, status: string): Promise<string> {
  seq += 1;
  const { id } = await createTestIssue(projectId, adminId, seq, {
    status: 'open',
    createdAt: new Date(),
  });
  ok(
    await call(owner, 'PATCH', `/api/issues/${id}`, {
      plan: 'Build it the way the plan says.',
      acceptanceCriteria: '1. It holds.\n2. It is refused by name.',
    }),
  );
  ok(
    await call(author, 'PUT', `/api/issues/${id}/design`, {
      criteria: [
        { criterion: 1, class: 'observable', pattern: null, proof: 'run it' },
        { criterion: 2, class: 'observable', pattern: null, proof: 'run it red' },
      ],
      modules: [],
      contracts: [],
    }),
  );
  if (status !== 'open') await seedIssueStatus(id, status);
  return id;
}

const step = (issue: string, to: string) =>
  call(author, 'PATCH', `/api/issues/${issue}`, { workState: { step: to } });

const stepOf = async (issue: string) =>
  (
    await rows<{ step: string | null }>(
      sql`SELECT step FROM issue_work_state WHERE issue_id = ${issue}`,
    )
  )[0]?.step ?? null;

const move = (issue: string, toStatus: string) =>
  call(owner, 'POST', `/api/issues/${issue}/transition`, { toStatus });

/** A lease on the issue, so a claim of it is a run's. */
async function leased(issue: string): Promise<void> {
  const lease = sql`jsonb_build_object('holder', 'run-1', 'renewedAt', now()::text, 'minutes', 30)`;
  await db.execute(sql`
    INSERT INTO issue_work_state (issue_id, lease) VALUES (${issue}, ${lease})
    ON CONFLICT (issue_id) DO UPDATE SET lease = EXCLUDED.lease`);
}

describe('strict: build waits for the plan checkpoint (criterion 1)', () => {
  it('refuses the work step into build, test and release by name until the issue passed approved', async () => {
    const issue = await issueAt(projects.strict, 'in_progress');
    ok(await step(issue, 'design'));
    for (const to of ['build', 'test', 'release']) {
      const res = await step(issue, to);
      expect([res.status, codes(res)]).toEqual([422, ['PLAN_APPROVAL_PENDING']]);
      const said = details(res);
      expect(said).toContain('plans.approve');
      expect(said).toContain('Gate plan_approval is enforced');
      expect(said).toContain('gate profile strict');
      expect(said).toContain('gates.overrides.plan_approval relaxes it');
    }
    expect(await stepOf(issue)).toBe('design');
  });

  it('refuses it where standard defers to plan.approval.required set on', async () => {
    const issue = await issueAt(projects.standardKeyed, 'in_progress');
    ok(await step(issue, 'design'));
    const res = await step(issue, 'build');
    expect([res.status, codes(res)]).toEqual([422, ['PLAN_APPROVAL_PENDING']]);
    expect(details(res)).toContain('plan.approval.required');
    expect(await stepOf(issue)).toBe('design');
  });
});

describe('after approved, build may start (criterion 2)', () => {
  it('allows the move once a holder of plans.approve moved the issue to approved', async () => {
    const issue = await issueAt(projects.strict, 'in_progress');
    ok(await step(issue, 'design'));
    ok(await move(issue, 'approved'));
    await leased(issue);
    const claim = ok(await move(issue, 'in_progress'));
    expect(claim.step).toBe('build');
    ok(await step(issue, 'design'));
    ok(await step(issue, 'build'));
    expect(await stepOf(issue)).toBe('build');
  });

  it('refuses it again once the plan is rewritten after that approval, and allows it after the next', async () => {
    const issue = await issueAt(projects.strict, 'in_progress');
    ok(await move(issue, 'approved'));
    await leased(issue);
    ok(await move(issue, 'in_progress'));
    ok(await step(issue, 'design'));
    // the same plan sent again is no rewrite
    ok(
      await call(owner, 'PATCH', `/api/issues/${issue}`, {
        plan: 'Build it the way the plan says.',
      }),
    );
    ok(await step(issue, 'build'));
    ok(await step(issue, 'design'));
    ok(
      await call(author, 'PATCH', `/api/issues/${issue}`, {
        plan: 'Build it another way.',
      }),
    );
    const res = await step(issue, 'build');
    expect([res.status, codes(res)]).toEqual([422, ['PLAN_APPROVAL_PENDING']]);
    expect(await stepOf(issue)).toBe('design');
    ok(await move(issue, 'approved'));
    await leased(issue);
    expect(ok(await move(issue, 'in_progress')).step).toBe('build');
  });

  it('refuses a write that rewrites the plan and moves into build at once', async () => {
    const issue = await issueAt(projects.strict, 'in_progress');
    ok(await move(issue, 'approved'));
    await leased(issue);
    ok(await move(issue, 'in_progress'));
    ok(await step(issue, 'design'));
    const res = await call(author, 'PATCH', `/api/issues/${issue}`, {
      plan: 'Build it a third way.',
      workState: { step: 'build' },
    });
    expect([res.status, codes(res)]).toEqual([422, ['PLAN_APPROVAL_PENDING']]);
    expect(details(res)).toContain('the plan changed after `approved`');
    expect(await stepOf(issue)).toBe('design');
    const plan = await rows<{ plan: string }>(sql`SELECT plan FROM issues WHERE id = ${issue}`);
    expect(plan[0]?.plan).toBe('Build it the way the plan says.');
  });

  it('lets a run already at build record its head: re-entering a step moves nothing', async () => {
    const issue = await issueAt(projects.strict, 'in_progress');
    await db.execute(sql`
      INSERT INTO issue_work_state (issue_id, step, step_started_at) VALUES (${issue}, 'build', now())
      ON CONFLICT (issue_id) DO UPDATE SET step = 'build', step_started_at = now()`);
    ok(
      await call(author, 'PATCH', `/api/issues/${issue}`, {
        workState: { step: 'build', branch: 'iss-x', headSha: 'a'.repeat(40) },
      }),
    );
  });
});

describe('where the gate is off, build starts as before (criterion 3)', () => {
  it('allows the move under yolo and under standard without plan.approval.required', async () => {
    for (const projectId of [projects.yolo, projects.standard]) {
      const issue = await issueAt(projectId, 'in_progress');
      ok(await step(issue, 'design'));
      ok(await step(issue, 'build'));
      expect(await stepOf(issue)).toBe('build');
    }
  });

  it('resumes a claim from reopen at build under yolo', async () => {
    const issue = await issueAt(projects.yolo, 'reopen');
    await leased(issue);
    expect(ok(await move(issue, 'in_progress')).step).toBe('build');
  });
});

describe('a claim resumes at design until the plan checkpoint is passed (criterion 4)', () => {
  it('resumes a claim from reopen at design, and at build once the issue passed approved', async () => {
    const issue = await issueAt(projects.strict, 'reopen');
    await leased(issue);
    expect(ok(await move(issue, 'in_progress')).step).toBe('design');
    const res = await step(issue, 'build');
    expect(codes(res)).toEqual(['PLAN_APPROVAL_PENDING']);
    ok(await move(issue, 'approved'));
    await leased(issue);
    expect(ok(await move(issue, 'in_progress')).step).toBe('build');
  });
});

const gateSentence = /\s*Gate plan_approval is .*$/;
const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

describe('an approval recorded before kernel_transitions held issue moves counts (criterion 2, K131 finding 1)', () => {
  it('reads an approval the activity log alone recorded', async () => {
    const issue = await issueAt(projects.strict, 'approved');
    // the move to approved as the feed recorded it before issues were audited in kernel_transitions
    await recordStatusMove(issue, adminId, 'in_progress', 'approved', new Date(Date.now() + 1_000));
    await leased(issue);
    expect(ok(await move(issue, 'in_progress')).step).toBe('build');
  });

  it('counts an issue standing at approved whose move there no record holds, its plan written at its create', async () => {
    seq += 1;
    const [row] = await rows<{ id: string }>(sql`
      INSERT INTO issues (project_id, iss_seq, title, status, plan, created_by_id)
      VALUES (${projects.strict}, ${seq}, 'legacy approved', 'open', 'Build it.', ${adminId})
      RETURNING id`);
    const issue = row?.id ?? '';
    // criteria alone: the plan keeps the time its create stamped
    ok(await call(owner, 'PATCH', `/api/issues/${issue}`, { acceptanceCriteria: '1. It holds.' }));
    ok(
      await call(author, 'PUT', `/api/issues/${issue}/design`, {
        criteria: [{ criterion: 1, class: 'observable', pattern: null, proof: 'run it' }],
        modules: [],
        contracts: [],
      }),
    );
    await seedIssueStatus(issue, 'approved');
    await leased(issue);
    expect(ok(await move(issue, 'in_progress')).step).toBe('build');
  });

  it('does not count an unrecorded approval its plan was written after', async () => {
    // the plan is written after the create and after every recorded move; the move to approved is in no record
    const issue = await issueAt(projects.strict, 'approved');
    await leased(issue);
    expect(ok(await move(issue, 'in_progress')).step).toBe('design');
  });
});

describe('the refusal says which step waits, what relaxes it first, in few words (criterion 1, K131 finding 2)', () => {
  it('names the step moved into, and keeps its own prose within 20 words', async () => {
    const issue = await issueAt(projects.strict, 'in_progress');
    ok(await step(issue, 'design'));
    for (const to of ['build', 'test', 'release']) {
      const said = details(await step(issue, to));
      const own = said.replace(gateSentence, '');
      expect(own).toContain(`\`${to}\``);
      for (const other of ['build', 'test', 'release'].filter((s) => s !== to)) {
        expect(own).not.toContain(`\`${other}\``);
      }
      expect(words(own)).toBeLessThanOrEqual(20);
      expect(own).toContain('plans.approve');
    }
  });

  it('names the setting standard defers to before the override that relaxes it', async () => {
    const issue = await issueAt(projects.standardKeyed, 'in_progress');
    ok(await step(issue, 'design'));
    const said = details(await step(issue, 'build'));
    const relaxes = said.slice(said.indexOf('Gate plan_approval'));
    expect(relaxes).toMatch(
      /changing plan\.approval\.required, or gates\.overrides\.plan_approval, relaxes it\.$/,
    );
  });
});

describe('a plan cleared after approval owes a plan (criterion 1, K131 finding 3)', () => {
  it('asks for a plan to be written, not for an approval of a rewrite', async () => {
    const issue = await issueAt(projects.strict, 'in_progress');
    ok(await move(issue, 'approved'));
    await leased(issue);
    ok(await move(issue, 'in_progress'));
    ok(await step(issue, 'design'));
    ok(await call(author, 'PATCH', `/api/issues/${issue}`, { plan: null }));
    const res = await step(issue, 'build');
    expect([res.status, codes(res)]).toEqual([422, ['PLAN_APPROVAL_PENDING']]);
    const own = details(res).replace(gateSentence, '');
    expect(own).toContain('no plan');
    expect(own).not.toContain('rewritten');
    expect(words(own)).toBeLessThanOrEqual(20);
    expect(await stepOf(issue)).toBe('design');
  });
});
