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

type Body = Record<string, unknown> & { code?: string };

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

const refusedAs = (r: { status: number; body: Body }, status: number) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body.code;
};

const evidence = (environment = 'beta') => ({
  evidence: {
    environment,
    commit: BETA_SHA,
    reading: 'GET /api/health 200, build-info sha e7af418',
  },
});

async function cutOne() {
  const added = await fx.insertIssue('awaiting_release', {
    section: 'Added',
    userFacing: 'Ecosystem links have a strict schema',
  });
  const fixed = await fx.insertIssue('awaiting_release', {
    section: 'Fixed',
    userFacing: 'A create form posts once per submit',
  });
  const bare = await fx.insertIssue('awaiting_release', { section: 'Skip', userFacing: '-' });
  const draft = await call('owner', 'GET', '/releases');
  expect(draft.status).toBe(200);
  expect(draft.body).toMatchObject({
    versions: [],
    counts: { all: 0, awaitingApproval: 0, live: 0, rolledBack: 0 },
    draft: { version: '0.1.0' },
  });
  expect((draft.body.draft as { issues: unknown[] }).issues).toHaveLength(3);
  const cut = await call('owner', 'POST', '/release-batches', { issueIds: [added, fixed, bare] });
  expect(cut.status, JSON.stringify(cut.body)).toBe(201);
  return String(cut.body.runId);
}

const statusOf = async () => {
  const list = await call('owner', 'GET', '/releases');
  const [row] = list.body.versions as Array<{ status: string }>;
  return { status: row?.status, counts: list.body.counts, draft: list.body.draft };
};

describe('a version waits for an admin before its production acts', () => {
  it('lists the cut version, takes one request, and refuses every production act until it is approved', async () => {
    const runId = await cutOne();
    expect(await statusOf()).toMatchObject({ status: 'in_progress', draft: null });

    const approvals = `/release-batches/${runId}/approvals`;
    expect(refusedAs(await call('agent', 'POST', approvals, evidence('live')), 422)).toBe(
      'RELEASE_APPROVAL_EVIDENCE_ENVIRONMENT',
    );
    expect(refusedAs(await call('agent', 'POST', approvals, evidence('nowhere')), 422)).toBe(
      'RELEASE_APPROVAL_EVIDENCE_ENVIRONMENT',
    );
    expect(
      refusedAs(await call('agent', 'POST', approvals, { evidence: { environment: 'beta' } }), 422),
    ).toBe('RELEASE_APPROVAL_SHAPE');

    const asked = await call('agent', 'POST', approvals, evidence());
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ decision: null, evidence: { environment: 'beta' } });
    expect(refusedAs(await call('agent', 'POST', approvals, evidence()), 409)).toBe(
      'RELEASE_APPROVAL_PENDING',
    );
    expect(await statusOf()).toMatchObject({
      status: 'awaiting_approval',
      counts: { awaitingApproval: 1 },
    });

    const attempt = { stage: 'deploy', idempotencyKey: 'deploy-1' };
    expect(
      refusedAs(await call('agent', 'POST', `/release-batches/${runId}/attempts`, attempt), 409),
    ).toBe('RELEASE_AWAITING_APPROVAL');

    const decide = `${approvals}/${String(asked.body.id)}/decision`;
    expect(refusedAs(await call('agent', 'POST', decide, { decision: 'approve' }), 403)).toBe(
      'RELEASE_APPROVER_IS_AGENT',
    );
    expect(refusedAs(await call('member', 'POST', decide, { decision: 'approve' }), 403)).toBe(
      'RELEASE_APPROVER_NOT_ADMIN',
    );
    expect(refusedAs(await call('owner', 'POST', decide, { decision: 'ship' }), 422)).toBe(
      'RELEASE_DECISION_UNKNOWN',
    );
    expect(refusedAs(await call('owner', 'POST', decide, { decision: 'return' }), 422)).toBe(
      'RELEASE_RETURN_WITHOUT_REASON',
    );

    const returned = await call('owner', 'POST', decide, {
      decision: 'return',
      reason: 'The smoke on beta read 14 of 22 checks; read the other eight first.',
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    expect(returned.body).toMatchObject({ decision: 'returned' });
    expect(await statusOf()).toMatchObject({ status: 'returned' });
    expect(
      refusedAs(await call('agent', 'POST', `/release-batches/${runId}/attempts`, attempt), 409),
    ).toBe('RELEASE_APPROVAL_RETURNED');

    const again = await call('agent', 'POST', approvals, evidence());
    const decideAgain = `${approvals}/${String(again.body.id)}/decision`;
    expect((await call('owner', 'POST', decideAgain, { decision: 'approve' })).status).toBe(200);
    expect(refusedAs(await call('owner', 'POST', decideAgain, { decision: 'approve' }), 409)).toBe(
      'RELEASE_APPROVAL_NOT_PENDING',
    );
    const opened = await call('agent', 'POST', `/release-batches/${runId}/attempts`, attempt);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(await statusOf()).toMatchObject({ status: 'in_progress' });
  });

  it('reads one version with its changelog from the issues it carries, its attempts and its requests', async () => {
    const runId = await cutOne();
    await call('agent', 'POST', `/release-batches/${runId}/approvals`, evidence());
    const v = await call('owner', 'GET', '/releases/0.1.0');
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body).toMatchObject({
      version: '0.1.0',
      runId,
      status: 'awaiting_approval',
      issueCount: 3,
      environment: 'live',
      changelog: [
        { section: 'Added', entries: [{ userFacing: 'Ecosystem links have a strict schema' }] },
        { section: 'Fixed', entries: [{ userFacing: 'A create form posts once per submit' }] },
      ],
      withoutNotes: [],
      attempts: [],
    });
    expect(v.body.approvals).toHaveLength(1);
    expect(refusedAs(await call('owner', 'GET', '/releases/zero'), 422)).toBe(
      'RELEASE_VERSION_SHAPE',
    );
    expect(refusedAs(await call('owner', 'GET', '/releases/9.9.9'), 404)).toBe('NOT_FOUND');
  });
});
