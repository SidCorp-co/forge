import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
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
let publish: MockInstance;
let readAdmissibleIssues: typeof import('../../src/devices/admissible.js').readAdmissibleIssues;
const tokens = { owner: '', master: '' };

const read = (rel: string): Doc => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

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
  ({ readAdmissibleIssues } = await import('../../src/devices/admissible.js'));
  const { roomManager } = await import('../../src/ws/server.js');
  publish = vi.spyOn(roomManager, 'publish');
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  tokens.owner = await signUserToken(owner.id);
  const agent = await createTestUser(harness.db, { kind: 'agent' });
  await createTestProjectMember(harness.db, { userId: agent.id, projectId, role: 'member' });
  tokens.master = (
    await mintPat({ userId: agent.id, name: 'master', projectIds: [projectId] })
  ).plaintext;
  const doc = read('../../src/project-config/fixtures/examples/hop.project.json');
  doc.project = { ...doc.project, id: projectId, slug: `hop-${projectId.slice(0, 8)}` };
  await harness.db.execute(sql`
    INSERT INTO project_config_documents (project_id, revision, document, updated_by)
    VALUES (${projectId}, 1, ${JSON.stringify(doc)}::jsonb, ${ownerId})
  `);
  deviceId = (await createTestDevice(harness.db, owner.id)).id;
  await bindTestRunner(harness.db, { projectId, deviceId });
}, 120_000);

afterAll(async () => {
  publish?.mockRestore();
  await server?.close();
  await harness?.cleanup();
});

beforeEach(() => {
  publish.mockClear();
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
const codesOf = (r: { body: Doc }) => (r.body.error?.refusals ?? []).map((x: Doc) => x.code);

let seq = 100;
async function plantIssue(status: string, mergedAt: Date | null = null): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`planted ${status}`}, ${status}, ${ownerId}, ${mergedAt?.toISOString() ?? null}::timestamptz)
  `);
  return id;
}
const admittedIds = async () =>
  (await readAdmissibleIssues({ deviceId, projectId })).items.map((a) => a.issueId);
const designWakes = () =>
  publish.mock.calls
    .map((c) => c[1] as Doc)
    .filter((e) => e.event === 'master.wake' && e.data.source === 'workflow_design')
    .map((e) => e.data);

async function proposedDesign(flow: string, issue?: string): Promise<string> {
  const d = read('../../src/workflows/fixtures/post-discharge.design.json');
  d.project = projectId;
  d.flow = flow;
  const made = await call('master', 'POST', at('/workflows'), { baseRevision: null, document: d });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const id = made.body.document.id as string;
  const proposed = await call('master', 'POST', at(`/workflows/${id}/design/propose`), {
    revision: 1,
    ...(issue ? { issue } : {}),
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
  return id;
}

describe('the admissible list takes what forge next calls takeable', () => {
  it('admits a reopened issue whose merge mark is still on it', async () => {
    const reopened = await plantIssue('reopen', new Date('2026-10-02T09:19:03Z'));
    const developed = await plantIssue('developed', new Date('2026-10-02T09:19:03Z'));
    const ids = await admittedIds();
    expect(ids).toContain(reopened);
    expect(ids).not.toContain(developed);
    const row = (await readAdmissibleIssues({ deviceId, projectId })).items.find(
      (a) => a.issueId === reopened,
    );
    expect(row).toMatchObject({ status: 'reopen', mergedAt: '2026-10-02T09:19:03.000Z' });
  });
});

describe('a design decision wakes its master', () => {
  it('on return, reopens the issue the design was drawn under, with the reason on its read', async () => {
    const designIssue = await plantIssue('developed', new Date());
    const key = `ISS-${seq}`;
    const workflowId = await proposedDesign('returned-flow', key);
    expect(await admittedIds()).not.toContain(designIssue);
    publish.mockClear();

    const returned = await call('owner', 'POST', at(`/workflows/${workflowId}/design/decision`), {
      revision: 1,
      decision: 'return',
      reason: 'the SLA is 48h by contract',
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    expect(returned.body.designIssue).toEqual({
      issueId: designIssue,
      action: 'reopened',
      status: 'reopen',
    });
    expect(designWakes()).toEqual([
      expect.objectContaining({
        projectId,
        workflowId,
        decision: 'return',
        issueId: designIssue,
      }),
    ]);
    expect(await admittedIds()).toContain(designIssue);
    const list = await call('owner', 'GET', at('/workflows'));
    expect(list.body.workflows.find((w: Doc) => w.document.id === workflowId)?.design).toEqual({
      status: 'returned',
      approvedRevision: null,
      returnReason: 'the SLA is 48h by contract',
    });

    const issue = await call('owner', 'GET', `/issues/${designIssue}`);
    expect(issue.body.status).toBe('reopen');
    expect(issue.body.proposesWorkflow).toMatchObject({
      workflowId,
      designStatus: 'returned',
      decision: 'return',
      reason: 'the SLA is 48h by contract',
    });
    const posted = (await harness.db.execute(sql`
      SELECT body FROM comments WHERE issue_id = ${designIssue}
    `)) as unknown as Array<{ body: string }>;
    expect(posted.map((c) => c.body).join('\n')).toContain('the SLA is 48h by contract');
  });

  it('on approve, wakes the master and leaves the design issue where it is', async () => {
    const designIssue = await plantIssue('developed', new Date());
    const workflowId = await proposedDesign('approved-flow', `ISS-${seq}`);
    publish.mockClear();
    const approved = await call('owner', 'POST', at(`/workflows/${workflowId}/design/decision`), {
      revision: 1,
      decision: 'approve',
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(designWakes()).toEqual([
      expect.objectContaining({ workflowId, decision: 'approve', issueId: designIssue }),
    ]);
    const issue = await call('owner', 'GET', `/issues/${designIssue}`);
    expect(issue.body.status).toBe('developed');
  });

  it('wakes on a return even when no issue was named on the proposal', async () => {
    const workflowId = await proposedDesign('unnamed-flow');
    publish.mockClear();
    const returned = await call('owner', 'POST', at(`/workflows/${workflowId}/design/decision`), {
      revision: 1,
      decision: 'return',
      reason: 'draw the consent check',
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    expect(returned.body.designIssue).toEqual({ issueId: null, action: 'none', status: null });
    expect(designWakes()).toEqual([
      expect.objectContaining({ workflowId, decision: 'return', issueId: null }),
    ]);
  });

  it('refuses the design issue as a build of its own design', async () => {
    await plantIssue('in_progress');
    const key = `ISS-${seq}`;
    const workflowId = await proposedDesign('self-build-flow', key);
    const linked = await call('master', 'POST', at(`/workflows/${workflowId}/builds`), {
      issue: key,
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(422);
    expect(codesOf(linked)).toEqual(['WORKFLOW_DESIGN_ISSUE_IS_BUILD']);
  });
});
