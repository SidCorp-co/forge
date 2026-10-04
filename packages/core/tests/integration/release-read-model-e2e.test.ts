import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';
import { declareProductionDocument } from '../helpers/production.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const BETA_SHA = 'e7af41887a0e90ed541bb0dbfb34d4f9cb4f8510';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownerId: string;
const tokens: Record<'owner' | 'member' | 'agent', string> = { owner: '', member: '', agent: '' };

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const { mintPat } = await import('../../src/auth/pat.js');
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  tokens.owner = await signUserToken(owner.id);
  const member = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  await createTestProjectMember(harness.db, { userId: member.id, projectId, role: 'member' });
  tokens.member = await signUserToken(member.id);
  const agent = await createTestUser(harness.db, { kind: 'agent' });
  await createTestProjectMember(harness.db, { userId: agent.id, projectId, role: 'admin' });
  tokens.agent = (
    await mintPat({ userId: agent.id, name: 'master', projectIds: [projectId] })
  ).plaintext;
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument(harness.db, {
    projectId,
    ownerId,
    bindingId,
    probes: 'none',
    others: { beta: { tier: 'staging', deployment: { mode: 'external' } } },
  });
});

type Body = Record<string, unknown>;

async function call(
  who: keyof typeof tokens,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${server.baseUrl}/api/projects/${projectId}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const evidence = {
  evidence: { environment: 'beta', commit: BETA_SHA, reading: 'GET /api/health 200' },
};

type Release = {
  key: string;
  state: string;
  attention: string;
  waiting: { kind: string; who: string; act: string };
  gates: Array<{ code: string; title: string; sentence: string; detail: string }>;
  can: { cut: boolean; decide: boolean };
  requirementsCompleted: Array<{
    key: string;
    completes: boolean;
    advances: Array<{ code: string }>;
    remaining: { issues: string[]; criteria: string[] };
  }>;
  issueCriteria: Array<{
    key: string;
    criteria: Array<{ n: number; standing: string; bc: string | null; identity: string | null }>;
  }>;
  contents: Array<{ requirement: { key: string } | null; issues: Array<{ key: string; proof: string }> }>;
  criteria: { proven: number; failing: number; open: number; total: number };
};

const detail = async (who: keyof typeof tokens, version: string) => {
  const r = await call(who, 'GET', `/releases/${version}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.release as Release;
};

const rows = async (sqlText: ReturnType<typeof sql>) => [...(await harness.db.execute(sqlText))];

async function agreedRequirement(): Promise<{ id: string; bc: Record<string, string> }> {
  const created = await call('owner', 'POST', '/requirements', {
    title: 'Reminders',
    reason: 'planted',
    criteria: [{ body: 'A nurse sees the reminder' }, { body: 'A doctor sees the report' }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const key = String(created.body.key);
  for (const [path, body] of [
    [`/requirements/${key}/revisions/1/propose`, {}],
    [`/requirements/${key}/revisions/1/accept`, {}],
    [`/requirements/${key}/agree`, { revision: 1 }],
  ] as const) {
    const r = await call('owner', 'POST', path, body);
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
  }
  const [req] = await rows(sql`SELECT id FROM requirements WHERE project_id = ${projectId}`);
  const bcs = await rows(
    sql`SELECT id, code FROM requirement_criteria WHERE requirement_id = ${(req as { id: string }).id}`,
  );
  return {
    id: (req as { id: string }).id,
    bc: Object.fromEntries(bcs.map((b) => [String(b.code), String(b.id)])),
  };
}

async function traceIssue(
  issueId: string,
  requirementId: string,
  criteria: Array<{ bc: string; verdict: 'pass' | 'fail' | null }>,
) {
  await harness.db.execute(
    sql`UPDATE issues SET requirement_id = ${requirementId}, planned_revision = 1 WHERE id = ${issueId}`,
  );
  let n = 0;
  for (const c of criteria) {
    n += 1;
    const [row] = await rows(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position, requirement_criterion_id)
      VALUES (${issueId}, ${n}, ${`criterion ${n} of ${issueId.slice(0, 4)}`}, ${n}, ${c.bc})
      RETURNING id`);
    if (c.verdict) {
      await harness.db.execute(sql`
        INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha,
                                        evidence, author_user_id, author_agency)
        VALUES (${(row as { id: string }).id}, ${issueId}, ${c.verdict}, 'commit', ${BETA_SHA},
                ARRAY['vitest']::text[], ${ownerId}, 'human')`);
    }
  }
}

describe('a draft release reads its gate as words', () => {
  it('is stuck on a missing release note, with the sentence on the face and the code behind it', async () => {
    await fx.insertIssue('awaiting_release', null);
    const list = await call('owner', 'GET', '/releases');
    expect(list.body).toMatchObject({
      releases: [
        {
          key: '0.1.0',
          state: 'draft',
          attention: 'stuck',
          waiting: { kind: 'system', who: 'Release gate', act: 'release note missing' },
        },
      ],
      counts: { stuck: 1, you: 0 },
    });
    const draft = await detail('owner', '0.1.0');
    expect(draft.can).toEqual({ cut: false, decide: false });
    expect(draft.gates).toHaveLength(1);
    expect(draft.gates[0]).toMatchObject({ code: 'RELEASE_RECORD_MISSING', title: 'Release note missing' });
    expect(draft.gates[0]?.sentence).toMatch(/have no release note/);
    expect(draft.gates[0]?.sentence).not.toMatch(/RELEASE_|\/api\//);
    expect(draft.gates[0]?.detail).toMatch(/RELEASE_RECORD_REMEDY|release note/);
  });

  it('waits on an admin to cut it once nothing holds it, and offers the cut to an admin only', async () => {
    await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A new thing' });
    const owner = await detail('owner', '0.1.0');
    expect(owner).toMatchObject({
      attention: 'you',
      waiting: { kind: 'you', act: 'cut 0.1.0' },
      can: { cut: true },
    });
    const member = await detail('member', '0.1.0');
    expect(member).toMatchObject({
      attention: 'others',
      waiting: { kind: 'person', who: 'A project admin' },
      can: { cut: false },
    });
  });

  it('refuses a version that is neither cut nor the draft, by name', async () => {
    await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A new thing' });
    expect((await call('owner', 'GET', '/releases/0.9.0')).status).toBe(404);
  });
});

describe('a release awaiting approval names its approver', () => {
  it('shows a member the one admin who can decide, by name and never by address', async () => {
    await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A new thing' });
    const cut = await call('owner', 'POST', '/release-batches', {
      issueIds: [(await rows(sql`SELECT id FROM issues WHERE project_id = ${projectId}`))[0]?.id],
    });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    const runId = String(cut.body.runId);
    const asked = await call('agent', 'POST', `/release-batches/${runId}/approvals`, evidence);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const member = await detail('member', '0.1.0');
    expect(member.attention).toBe('others');
    expect(member.waiting).toMatchObject({ kind: 'person', act: 'approve' });
    expect(member.waiting.who).not.toContain('@');
    expect(JSON.stringify(member)).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
    const owner = await detail('owner', '0.1.0');
    expect(owner).toMatchObject({ attention: 'you', can: { decide: true } });
    const agent = await detail('agent', '0.1.0');
    expect(agent.can.decide).toBe(false);
  });
});

describe('the requirements a release completes and the criteria of its issues', () => {
  it('reads each criterion with its standing, the criterion it proves and what it was judged against', async () => {
    const req = await agreedRequirement();
    const a = await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A' });
    const b = await fx.insertIssue('awaiting_release', { section: 'Fixed', userFacing: 'B' });
    await traceIssue(a, req.id, [{ bc: req.bc['BC-1'] as string, verdict: 'pass' }]);
    await traceIssue(b, req.id, [
      { bc: req.bc['BC-2'] as string, verdict: 'pass' },
      { bc: req.bc['BC-2'] as string, verdict: null },
    ]);
    const draft = await detail('owner', '0.1.0');
    const first = draft.issueCriteria.find((i) => i.criteria.length === 1);
    expect(first?.criteria[0]).toMatchObject({
      n: 1,
      standing: 'pass',
      bc: 'BC-1',
      identity: `commit ${BETA_SHA.slice(0, 12)}`,
    });
    const second = draft.issueCriteria.find((i) => i.criteria.length === 2);
    expect(second?.criteria.map((c) => c.standing)).toEqual(['pass', 'unjudged']);
    expect(draft.criteria).toEqual({ proven: 2, failing: 0, open: 1, total: 3 });
    expect(draft.contents).toHaveLength(1);
    expect(draft.contents[0]?.requirement?.key).toBe('REQ-1');
    expect(draft.contents[0]?.issues.map((i) => i.proof).sort()).toEqual(['open', 'proven']);
  });

  it('is partial while another issue of the requirement is open, and completes once nothing is owed', async () => {
    const req = await agreedRequirement();
    const a = await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A' });
    const b = await fx.insertIssue('awaiting_release', { section: 'Fixed', userFacing: 'B' });
    await traceIssue(a, req.id, [{ bc: req.bc['BC-1'] as string, verdict: 'pass' }]);
    await traceIssue(b, req.id, [{ bc: req.bc['BC-2'] as string, verdict: 'pass' }]);
    const open = await fx.insertIssue('in_progress', null, false);
    await harness.db.execute(
      sql`UPDATE issues SET requirement_id = ${req.id}, planned_revision = 1 WHERE id = ${open}`,
    );
    const partial = (await detail('owner', '0.1.0')).requirementsCompleted[0];
    expect(partial).toMatchObject({ key: 'REQ-1', completes: false });
    expect(partial?.advances.map((x) => x.code).sort()).toEqual(['BC-1', 'BC-2']);
    expect(partial?.remaining.issues).toHaveLength(1);
    await harness.db.execute(sql`UPDATE issues SET merged_at = now(), status = 'closed' WHERE id = ${open}`);
    expect((await detail('owner', '0.1.0')).requirementsCompleted[0]).toMatchObject({
      completes: true,
      remaining: { issues: [], criteria: [] },
    });
  });

  it('is partial while a criterion fails, naming it', async () => {
    const req = await agreedRequirement();
    const a = await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A' });
    await traceIssue(a, req.id, [
      { bc: req.bc['BC-1'] as string, verdict: 'pass' },
      { bc: req.bc['BC-2'] as string, verdict: 'fail' },
    ]);
    const r = (await detail('owner', '0.1.0')).requirementsCompleted[0];
    expect(r).toMatchObject({ completes: false, remaining: { criteria: ['BC-2'] } });
  });
});
