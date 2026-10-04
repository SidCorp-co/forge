import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WORKFLOW_SUMMARY_FIELDS } from '@forge/contracts/workflows';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
} from '../helpers/index.js';

// biome-ignore lint/suspicious/noExplicitAny: plants mutate fixtures at arbitrary depth
type Doc = Record<string, any>;

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownerId: string;
let deviceId: string;
let openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
let readAdmissibleIssues: typeof import('../../src/devices/admissible.js').readAdmissibleIssues;
const tokens: Record<'owner' | 'master' | 'otherMaster', string> = {
  owner: '',
  master: '',
  otherMaster: '',
};

const read = (rel: string): Doc => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const designDoc = (patch: (d: Doc) => void = () => {}): Doc => {
  const d = read('../../src/workflows/fixtures/post-discharge.design.json');
  d.project = projectId;
  patch(d);
  return d;
};

async function setApprover(approver: 'owner' | 'master' | null) {
  const doc = read('../../src/project-config/fixtures/examples/hop.project.json');
  doc.project = { ...doc.project, id: projectId, slug: `hop-${projectId.slice(0, 8)}` };
  if (approver) doc.workflows = { designApprover: approver };
  await harness.db.execute(sql`
    INSERT INTO project_config_documents (project_id, revision, document, updated_by)
    VALUES (${projectId}, 1, ${JSON.stringify(doc)}::jsonb, ${ownerId})
    ON CONFLICT (project_id) DO UPDATE SET document = EXCLUDED.document,
      revision = project_config_documents.revision + 1
  `);
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  server = await startTestServer();
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const { mintPat } = await import('../../src/auth/pat.js');
  ({ openRunSession } = await import('../../src/devices/run-session.js'));
  ({ readAdmissibleIssues } = await import('../../src/devices/admissible.js'));
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  const otherId = (await createTestProject(harness.db, owner.id)).id;
  tokens.owner = await signUserToken(owner.id);
  const masterOf = async (project: string) => {
    const agent = await createTestUser(harness.db, { kind: 'agent' });
    await createTestProjectMember(harness.db, {
      userId: agent.id,
      projectId: project,
      role: 'member',
    });
    return (await mintPat({ userId: agent.id, name: 'master', projectIds: [project] })).plaintext;
  };
  tokens.master = await masterOf(projectId);
  tokens.otherMaster = await masterOf(otherId);
  await setApprover(null);
  deviceId = (await createTestDevice(harness.db, owner.id)).id;
  await bindTestRunner(harness.db, { projectId, deviceId });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

async function call(who: keyof typeof tokens, method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.baseUrl}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Doc };
}
const at = (path: string) => `/projects/${projectId}${path}`;
const codesOf = (r: { status: number; body: Doc }) =>
  (r.body.error?.refusals ?? []).map((x: Doc) => x.code);

let workflowId = '';
let issueId = '';
const runOver = () =>
  openRunSession({
    deviceId,
    projectId,
    issueKeys: ['ISS-41'],
    name: `build-${randomUUID().slice(0, 6)}`,
  });

async function designProjections() {
  const whole = await call('owner', 'GET', at(`/workflows/${workflowId}/design`));
  const stepCount = whole.body.revisions[0].document.steps.length;
  const summary = await call('owner', 'GET', at(`/workflows/${workflowId}/design?view=summary`));
  expect(summary.status, JSON.stringify(summary.body)).toBe(200);
  expect(
    summary.body.revisions.map((r: Doc) => ['document' in r, r.revision, r.stepCount]),
  ).toEqual([
    [false, 3, stepCount],
    [false, 1, stepCount],
  ]);
  const steps = await call(
    'owner',
    'GET',
    at(`/workflows/${workflowId}/design?view=steps&revision=1&stepFrom=2&stepTo=3`),
  );
  expect(steps.status, JSON.stringify(steps.body)).toBe(200);
  expect(steps.body.document).toMatchObject({ revision: 1, stepCount, from: 2, to: 3 });
  expect(steps.body.document.steps).toEqual(whole.body.revisions[1].document.steps.slice(1, 3));
  const stray = await call('owner', 'GET', at(`/workflows/${workflowId}/design?stepFrom=2`));
  expect(stray.status).toBe(400);
  const unheld = await call(
    'owner',
    'GET',
    at(`/workflows/${workflowId}/design?view=steps&revision=2`),
  );
  expect(unheld.status).toBe(400);
  expect(JSON.stringify(unheld.body)).toContain('its revisions are 3, 1');
  const list = await call('owner', 'GET', at('/workflows?view=summary'));
  expect(Object.keys(list.body.workflows[0])).toEqual([...WORKFLOW_SUMMARY_FIELDS]);
  const junk = await call('owner', 'GET', at('/workflows?view=tiny'));
  expect(junk.status).toBe(400);
}

async function requirementLinks() {
  const created = await call('owner', 'POST', at('/requirements'), {
    title: 'Post-discharge reminders',
    reason: 'planted',
    criteria: [{ body: 'A nurse sees the reminder' }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const key = String(created.body.key);
  const link = await call('owner', 'POST', at(`/requirements/${key}/workflows`), { workflowId });
  expect(link.status, JSON.stringify(link.body)).toBe(200);
  const draft = await call('owner', 'GET', at(`/workflows/${workflowId}/design`));
  expect(draft.body.requirements).toEqual([
    { key, title: 'Post-discharge reminders', status: 'draft', pinnedRevision: null },
  ]);
  for (const [path, body] of [
    [`/requirements/${key}/revisions/1/propose`, {}],
    [`/requirements/${key}/revisions/1/accept`, {}],
    [`/requirements/${key}/agree`, { revision: 1 }],
  ] as const) {
    const r = await call('owner', 'POST', at(path), body);
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
  }
  const agreed = await call('owner', 'GET', at(`/workflows/${workflowId}/design`));
  expect(agreed.body.requirements).toEqual([
    { key, title: 'Post-discharge reminders', status: 'agreed', pinnedRevision: 1 },
  ]);
  expect(agreed.body.gate.open).toBe(true);
  expect(agreed.body.waitingOn.kind).toBe('none');
}

async function standingWhileProposed(design: { body: Doc }) {
  expect(design.body.waitingOn).toMatchObject({
    kind: 'you',
    act: 'approve or return revision 3',
  });
  expect(design.body.revisions.map((r: Doc) => r.state)).toEqual(['proposed', 'current']);
  expect(design.body.gate.open).toBe(false);
  expect(design.body.requirements.map((r: Doc) => r.pinnedRevision)).toEqual([1]);
  const asMaster = await call('master', 'GET', at(`/workflows/${workflowId}/design`));
  expect(asMaster.body.waitingOn).toMatchObject({ kind: 'you', who: 'You' });
  await setApprover('owner');
  const ownerPolicy = await call('master', 'GET', at(`/workflows/${workflowId}/design`));
  expect(ownerPolicy.body.waitingOn).toMatchObject({
    kind: 'person',
    who: 'An org owner or admin',
  });
  await setApprover('master');
}

describe('a workflow design is approved before anything builds it', () => {
  it('starts a v2 design as a draft the master proposes', async () => {
    const made = await call('master', 'POST', at('/workflows'), {
      baseRevision: null,
      document: designDoc(),
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.design).toEqual({ status: 'draft', approvedRevision: null });
    workflowId = made.body.document.id;
    const proposed = await call('master', 'POST', at(`/workflows/${workflowId}/design/propose`), {
      revision: 1,
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    expect(proposed.body).toMatchObject({
      status: 'proposed',
      proposedRevision: 1,
      approver: 'owner',
    });
  });

  it("refuses a repo file as this storefront project's evidence", async () => {
    const r = await call('master', 'POST', at('/workflows'), {
      baseRevision: null,
      document: designDoc((d) => {
        d.flow = 'readmission';
        d.status = 'writing';
        d.steps[0].status = 'current';
        d.steps[0].evidence = {
          kind: 'repo',
          file: 'src/discharge.ts',
          coverage: { reading: 'unmeasured', atSha: null },
        };
      }),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(codesOf(r)).toEqual(['WORKFLOW_EVIDENCE_KIND_MISMATCH']);
  });

  it('refuses the master deciding while the approver is the owner', async () => {
    const r = await call('master', 'POST', at(`/workflows/${workflowId}/design/decision`), {
      revision: 1,
      decision: 'approve',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error.code).toBe('WORKFLOW_DESIGN_APPROVER_NOT_PERSON');
  });

  it('refuses a run over an issue that builds the proposed design, and says why on the issue', async () => {
    issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, 41, 'build post-discharge', 'open', ${ownerId})
    `);
    const linked = await call('master', 'POST', at(`/workflows/${workflowId}/builds`), {
      issue: 'ISS-41',
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.builds.map((b: Doc) => b.displayId)).toEqual(['ISS-41']);

    await expect(runOver()).rejects.toMatchObject({ code: 'WORKFLOW_DESIGN_NOT_APPROVED' });
    const admitted = (await readAdmissibleIssues({ deviceId, projectId })).items;
    expect(admitted.map((a) => a.issueId)).not.toContain(issueId);
    const issue = await call('owner', 'GET', `/issues/${issueId}`);
    expect(issue.body.buildsWorkflow).toMatchObject({
      workflowId,
      designStatus: 'proposed',
      dispatchable: false,
      refusal: { code: 'WORKFLOW_DESIGN_NOT_APPROVED' },
    });
  });

  it("refuses another project's master once the approver is master, and lets this one approve", async () => {
    await setApprover('master');
    const other = await call(
      'otherMaster',
      'POST',
      at(`/workflows/${workflowId}/design/decision`),
      {
        revision: 1,
        decision: 'approve',
      },
    );
    expect(other.status, JSON.stringify(other.body)).toBe(422);
    expect(other.body.error.code).toBe('WORKFLOW_DESIGN_APPROVER_NOT_PROJECT');
    const own = await call('master', 'POST', at(`/workflows/${workflowId}/design/decision`), {
      revision: 1,
      decision: 'approve',
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body).toMatchObject({ status: 'approved', approvedRevision: 1 });
    const session = await runOver();
    expect(session.runId).toEqual(expect.any(String));
    await harness.db.execute(sql`DELETE FROM issue_leases WHERE project_id = ${projectId}`);
  });

  it(
    'names the requirement drawn with it and the revision its agreed baseline pins',
    requirementLinks,
  );

  it('keeps it approved through a refresh of evidence, and sends a design change back to proposed', async () => {
    const refreshed = await call('master', 'PUT', at(`/workflows/${workflowId}`), {
      baseRevision: 1,
      document: designDoc((d) => {
        d.status = 'writing';
        d.steps[0].status = 'current';
        d.steps[0].evidence = {
          kind: 'storefront',
          provider: 'autoflow',
          ref: 'workflow',
          id: 'post_discharge',
        };
      }),
    });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body.design).toEqual({ status: 'approved', approvedRevision: 1 });

    const changed = await call('master', 'PUT', at(`/workflows/${workflowId}`), {
      baseRevision: 2,
      document: designDoc((d) => {
        d.steps[3].node.sla = '24h';
      }),
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.design).toEqual({ status: 'proposed', approvedRevision: 1 });
    const design = await call('owner', 'GET', at(`/workflows/${workflowId}/design`));
    expect(design.body).toMatchObject({
      status: 'proposed',
      proposedRevision: 3,
      approvedRevision: 1,
    });
    expect(design.body.revisions.map((r: Doc) => [r.revision, r.decision])).toEqual([
      [3, null],
      [1, 'approve'],
    ]);
    expect(design.body.canDecide).toBe(true);
    await standingWhileProposed(design);
    await expect(runOver()).rejects.toMatchObject({ code: 'WORKFLOW_DESIGN_NOT_APPROVED' });
  });

  it(
    'answers the design read in the projection asked for, and whole by default',
    designProjections,
  );

  it('lets the owner return it, and only with a reason', async () => {
    const bare = await call('owner', 'POST', at(`/workflows/${workflowId}/design/decision`), {
      revision: 3,
      decision: 'return',
    });
    expect(codesOf(bare)).toEqual(['WORKFLOW_DESIGN_REASON_MISSING']);
    const stale = await call('owner', 'POST', at(`/workflows/${workflowId}/design/decision`), {
      revision: 1,
      decision: 'approve',
    });
    expect(codesOf(stale)).toEqual(['WORKFLOW_DESIGN_REVISION_STALE']);
    const returned = await call('owner', 'POST', at(`/workflows/${workflowId}/design/decision`), {
      revision: 3,
      decision: 'return',
      reason: 'the SLA is 48h by contract',
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    expect(returned.body).toMatchObject({ status: 'returned', approvedRevision: 1 });
    expect(returned.body.revisions[0]).toMatchObject({
      decision: 'return',
      reason: 'the SLA is 48h by contract',
      state: 'returned',
    });
    expect(returned.body.waitingOn).toMatchObject({ kind: 'agent', act: 'revise revision 3' });
  });

  it('refuses unlinking the build to anyone but the approver', async () => {
    await setApprover('owner');
    const r = await call('master', 'DELETE', at(`/workflows/${workflowId}/builds/${issueId}`));
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error.code).toBe('WORKFLOW_DESIGN_APPROVER_NOT_PERSON');
  });
});
