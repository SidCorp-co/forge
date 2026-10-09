/**
 * An issue records its design before build (REQ-36 BC-1, BC-2, BC-13; Issue lifecycle r15
 * `design-check`): each criterion's class, catalogued pattern and proof, and the modules and
 * contracts the change touches. Nothing reaches build without it: the work step's move into build,
 * test or release and the move to approved are refused by name, and a claim from approved or
 * reopen resumes at design where the check fails. A run already at build recording its head moves
 * nothing and is not refused. A code-property criterion is routed to the review: a verdict recorded
 * as QA's on it is refused.
 *
 * @direct-test-of packages/core/src/issues/design-record.ts
 * @direct-test-of packages/core/src/issues/design-routes.ts
 * @direct-test-of packages/core/src/issues/update-service.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-record.ts
 * @direct-test-of packages/core/src/issues/criteria/routes.ts
 * @direct-test-of packages/core/src/db/schema-issue-designs.ts
 * @direct-test-of packages/contracts/src/issue-design.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { THIS_REPOSITORY } from '../../src/lib/this-repository.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestModule,
  createTestProject,
  createTestUser,
  rows,
  seedIssueStatus,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const tokens = { admin: '', author: '', viewer: '' };
let adminId = '';
let forge = '';
let other = '';
let seq = 0;

const environments = {
  dev: {
    tier: 'production' as const,
    deploysFrom: 'main',
    deployment: { mode: 'external' as const },
  },
};

async function projectBuiltFrom(ownerId: string, repository: string): Promise<string> {
  const { id } = await createTestProject(ownerId);
  await seedProjectDocument(id, ownerId, {
    environments,
    source: { type: 'git', git: { repository, defaultBranch: 'main', branches: ['main'] } },
  });
  await createTestModule(id, 'issues');
  await createTestModule(id, 'db');
  await db.execute(
    sql`INSERT INTO labels (project_id, name, color, kind) VALUES (${id}, 'bug', '#888888', 'label')`,
  );
  return id;
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const admin = await createTestUser({ verified: true });
  const author = await createTestUser({ kind: 'agent' });
  const viewer = await createTestUser({ verified: true });
  adminId = admin.id;
  forge = await projectBuiltFrom(admin.id, THIS_REPOSITORY);
  other = await projectBuiltFrom(admin.id, 'github.com/acme/shop');
  for (const p of [forge, other]) {
    await addProjectMember(p, admin.id, 'admin');
    await addProjectMember(p, author.id, 'member');
    await addProjectMember(p, viewer.id, 'viewer');
  }
  tokens.admin = await userToken(admin.id);
  tokens.author = await userToken(author.id);
  tokens.viewer = await userToken(viewer.id);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function call(
  who: keyof typeof tokens,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Doc }> {
  const res = await api(tokens[who], method, path, body);
  return { status: res.status, body: res.body as Doc };
}

function ok(res: { status: number; body: Doc }, status = 200): Doc {
  expect([res.status, res.body]).toEqual([status, expect.anything()]);
  return res.body;
}

function refused(res: { status: number; body: Doc }): string[] {
  return (res.body.error?.refusals ?? []).map((r: Doc) => r.code);
}

function detailOf(res: { status: number; body: Doc }): string {
  return (res.body.error?.refusals ?? []).map((r: Doc) => r.detail).join(' | ');
}

/** An issue at `status` with two criteria written, as a run reaches the design step. */
async function issueAt(projectId: string, status: string): Promise<string> {
  seq += 1;
  const { id } = await createTestIssue(projectId, adminId, seq, {
    status: 'open',
    createdAt: new Date(),
  });
  ok(
    await call('admin', 'PATCH', `/api/issues/${id}`, {
      plan: 'Build it to the catalogued pattern.',
      acceptanceCriteria: '1. The page shows it.\n2. The rule lives in one module.',
    }),
  );
  if (status !== 'open') await seedIssueStatus(id, status);
  return id;
}

const design = (issue: string) => `/api/issues/${issue}/design`;
const step = (issue: string, to: string) =>
  call('author', 'PATCH', `/api/issues/${issue}`, { workState: { step: to } });

const whole = {
  criteria: [
    { criterion: 1, class: 'observable', pattern: 'screen', proof: 'open the page, see it' },
    {
      criterion: 2,
      class: 'code_property',
      pattern: 'core-module',
      proof: 'review: one writer of the table',
    },
  ],
  modules: ['issues', 'db'],
  contracts: [],
};

const stepOf = async (issue: string) =>
  (
    await rows<{ step: string | null }>(
      sql`SELECT step FROM issue_work_state WHERE issue_id = ${issue}`,
    )
  )[0]?.step ?? null;

describe('the move into build without a design (criterion 1)', () => {
  it('refuses the work step into build, test and release by name, at the REST door', async () => {
    const issue = await issueAt(forge, 'in_progress');
    ok(await step(issue, 'design'));
    for (const to of ['build', 'test', 'release']) {
      const res = await step(issue, to);
      expect([res.status, refused(res)]).toEqual([422, ['DESIGN_RECORD_MISSING']]);
      expect(detailOf(res)).toContain('PUT /api/issues/:id/design');
    }
    expect(await stepOf(issue)).toBe('design');
  });

  it('passes once the design is recorded, and names each part the record lacks once the criteria change', async () => {
    const issue = await issueAt(forge, 'in_progress');
    const recorded = ok(await call('author', 'PUT', design(issue), whole));
    expect(recorded.check).toEqual({ passed: true });
    expect(recorded.design).toMatchObject({
      revision: 1,
      modules: [{ name: 'issues' }, { name: 'db' }],
      contracts: [],
    });
    ok(await step(issue, 'build'));
    ok(await step(issue, 'plan'));
    ok(
      await call('admin', 'PATCH', `/api/issues/${issue}`, {
        acceptanceCriteria:
          '1. The page shows it.\n2. The rule lives in one module.\n3. The list shows it too.',
      }),
    );
    const res = await step(issue, 'build');
    expect([res.status, refused(res)]).toEqual([422, ['DESIGN_RECORD_INCOMPLETE']]);
    expect(detailOf(res)).toContain('criterion 3: no class, pattern or proof');
    const read = ok(await call('viewer', 'GET', design(issue)));
    expect(read.check).toMatchObject({ passed: false, code: 'DESIGN_RECORD_INCOMPLETE' });
  });

  it('lets a run already at build record its head without a design: re-entering a step moves nothing', async () => {
    const issue = await issueAt(forge, 'in_progress');
    await db.execute(sql`
      INSERT INTO issue_work_state (issue_id, step, step_started_at) VALUES (${issue}, 'build', now())
      ON CONFLICT (issue_id) DO UPDATE SET step = 'build', step_started_at = now()`);
    ok(
      await call('author', 'PATCH', `/api/issues/${issue}`, {
        workState: { step: 'build', branch: 'iss-x', headSha: 'a'.repeat(40) },
      }),
    );
    const res = await step(issue, 'test');
    expect(refused(res)).toEqual(['DESIGN_RECORD_MISSING']);
    ok(await call('author', 'PUT', design(issue), whole));
    ok(await step(issue, 'test'));
  });

  it('refuses the move to approved, the plan checkpoint, until the design passes', async () => {
    const issue = await issueAt(forge, 'in_progress');
    const res = await call('admin', 'POST', `/api/issues/${issue}/transition`, {
      toStatus: 'approved',
    });
    expect([res.status, refused(res)]).toEqual([422, ['DESIGN_RECORD_MISSING']]);
    ok(await call('author', 'PUT', design(issue), whole));
    ok(await call('admin', 'POST', `/api/issues/${issue}/transition`, { toStatus: 'approved' }));
  });

  it('resumes a claim from approved or reopen at design where the check fails, and at build where it passes', async () => {
    const lease = sql`jsonb_build_object('holder', 'run-1', 'renewedAt', now()::text, 'minutes', 30)`;
    for (const from of ['approved', 'reopen']) {
      const bare = await issueAt(forge, from);
      const designed = await issueAt(forge, from);
      ok(await call('author', 'PUT', design(designed), whole));
      for (const issue of [bare, designed]) {
        await db.execute(sql`
          INSERT INTO issue_work_state (issue_id, lease) VALUES (${issue}, ${lease})
          ON CONFLICT (issue_id) DO UPDATE SET lease = EXCLUDED.lease`);
        const claim = ok(
          await call('admin', 'POST', `/api/issues/${issue}/transition`, {
            toStatus: 'in_progress',
          }),
        );
        expect(claim.step).toBe(issue === bare ? 'design' : 'build');
      }
    }
  });
});

describe('the design record (criteria 2 and 3)', () => {
  it('classes each criterion and routes it to its judge on the criteria read', async () => {
    const issue = await issueAt(forge, 'in_progress');
    const recorded = ok(await call('author', 'PUT', design(issue), whole));
    expect(
      recorded.design.criteria.map((c: Doc) => [c.criterion, c.class, c.judge, c.pattern]),
    ).toEqual([
      [1, 'observable', 'qa', 'screen'],
      [2, 'code_property', 'review', 'core-module'],
    ]);
    const read = ok(await call('viewer', 'GET', `/api/issues/${issue}/criteria`));
    expect(read.criteria.map((c: Doc) => [c.n, c.class, c.judge])).toEqual([
      [1, 'observable', 'qa'],
      [2, 'code_property', 'review'],
    ]);
  });

  it('refuses a QA verdict on a code property and a review verdict on an observable criterion', async () => {
    const issue = await issueAt(forge, 'in_progress');
    ok(await call('author', 'PUT', design(issue), whole));
    const verdict = (criterion: number, judge?: string) =>
      call('author', 'POST', `/api/issues/${issue}/verdicts`, {
        criterion,
        verdict: 'pass',
        reason: 'shown',
        identity: { kind: 'commit', sha: 'b'.repeat(40) },
        ...(judge ? { judge } : {}),
      });
    expect(refused(await verdict(2))).toEqual(['VERDICT_JUDGED_BY_REVIEW']);
    expect(refused(await verdict(1, 'review'))).toEqual(['VERDICT_JUDGED_BY_QA']);
    ok(await verdict(2, 'review'), 201);
    ok(await verdict(1), 201);
    const judges = await rows<{ judge: string }>(
      sql`SELECT judge FROM criterion_verdicts WHERE issue_id = ${issue} ORDER BY created_at`,
    );
    expect(judges.map((j) => j.judge)).toEqual(['review', 'qa']);
  });

  it('refuses a pattern that is neither catalogued nor approved as new, naming it', async () => {
    const issue = await issueAt(forge, 'in_progress');
    const body = {
      ...whole,
      criteria: [{ ...whole.criteria[0], pattern: 'webhook-door' }, whole.criteria[1]],
    };
    const res = await call('author', 'PUT', design(issue), body);
    expect([res.status, refused(res)]).toEqual([422, ['DESIGN_PATTERN_UNCATALOGUED']]);
    expect(detailOf(res)).toContain('`webhook-door`');
    const named = ok(
      await call('author', 'POST', `/api/issues/${issue}/patterns`, {
        pattern: 'webhook-door',
        summary: 'an inbound webhook as a door of its own',
      }),
      201,
    );
    expect(refused(await call('author', 'PUT', design(issue), body))).toEqual([
      'DESIGN_PATTERN_UNCATALOGUED',
    ]);
    ok(
      await call('admin', 'POST', `/api/issues/${issue}/patterns/${named.pattern.id}/decision`, {
        decision: 'approved',
        reason: 'no catalogued door takes vendor traffic in',
      }),
    );
    const recorded = ok(await call('author', 'PUT', design(issue), body));
    expect(recorded.design.criteria[0].pattern).toBe('webhook-door');
  });

  it('refuses each wrong part by name and writes nothing', async () => {
    const issue = await issueAt(forge, 'in_progress');
    const res = await call('author', 'PUT', design(issue), {
      criteria: [
        { criterion: 1, class: 'observable', pattern: null, proof: 'probe' },
        { criterion: 9, class: 'observable', pattern: 'screen', proof: 'probe' },
      ],
      modules: ['issues', 'bug', 'nowhere'],
      contracts: ['acme/none'],
    });
    expect(res.status).toBe(422);
    expect(refused(res).sort()).toEqual(
      [
        'DESIGN_CONTRACT_UNKNOWN',
        'DESIGN_CRITERION_LEFT_OUT',
        'DESIGN_CRITERION_UNKNOWN',
        'DESIGN_MODULE_UNKNOWN',
        'DESIGN_MODULE_UNKNOWN',
        'DESIGN_PATTERN_REQUIRED',
      ].sort(),
    );
    expect(ok(await call('viewer', 'GET', design(issue))).design).toBeNull();
    const shape = await call('author', 'PUT', design(issue), { ...whole, modules: [] });
    expect(shape.status).toBe(400);
    const viewer = await call('viewer', 'PUT', design(issue), whole);
    expect([viewer.status, viewer.body.error.code]).toEqual([403, 'PERMISSION_FORBIDDEN']);
  });

  it('takes no pattern on a project that reads no catalog, and refuses one there', async () => {
    const issue = await issueAt(other, 'in_progress');
    const named = await call('author', 'PUT', design(issue), whole);
    expect(refused(named)).toEqual(['DESIGN_PATTERN_UNDECLARED', 'DESIGN_PATTERN_UNDECLARED']);
    const bare = {
      ...whole,
      criteria: whole.criteria.map((c) => ({ ...c, pattern: null })),
    };
    const recorded = ok(await call('author', 'PUT', design(issue), bare));
    expect([recorded.catalogDeclared, recorded.check.passed]).toEqual([false, true]);
    ok(await step(issue, 'build'));
  });
});
