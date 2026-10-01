import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusedByDb } from '../helpers/ecosystem-world.js';
import {
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
let otherId: string;
const tokens: Record<'owner' | 'agent' | 'viewerAgent' | 'otherAgent', string> = {
  owner: '',
  agent: '',
  viewerAgent: '',
  otherAgent: '',
};

const example = (file: string): Doc =>
  JSON.parse(
    readFileSync(new URL(`../../src/workflows/fixtures/${file}`, import.meta.url), 'utf8'),
  );

function releaseDoc(patch: (d: Doc) => void = () => {}): Doc {
  const d = example('release.workflow.json');
  d.project = projectId;
  patch(d);
  return d;
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
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  projectId = (await createTestProject(harness.db, owner.id)).id;
  otherId = (await createTestProject(harness.db, owner.id)).id;
  tokens.owner = await signUserToken(owner.id);
  const agentOn = async (project: string, role: 'member' | 'viewer') => {
    const agent = await createTestUser(harness.db, { kind: 'agent' });
    await createTestProjectMember(harness.db, { userId: agent.id, projectId: project, role });
    return (await mintPat({ userId: agent.id, name: 'master', projectIds: [project] })).plaintext;
  };
  tokens.agent = await agentOn(projectId, 'member');
  tokens.viewerAgent = await agentOn(projectId, 'viewer');
  tokens.otherAgent = await agentOn(otherId, 'member');
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

async function call(who: keyof typeof tokens, method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.baseUrl}/api/projects/${projectId}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Doc };
}

const codes = (r: { status: number; body: Doc }) => {
  expect(r.status, JSON.stringify(r.body)).toBe(422);
  return r.body.error.refusals.map((x: Doc) => `${x.code} ${x.path}`);
};

const ids: Record<string, string> = {};

describe("a project's own agent draws its workflows", () => {
  it('stores revision 1 and answers the workflow-v1 record', async () => {
    const made = await call('agent', 'POST', '/workflows', {
      baseRevision: null,
      document: releaseDoc(),
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ revision: 1, created: true });
    expect(made.body.document).toMatchObject({ ...releaseDoc(), id: expect.any(String) });
    ids.release = made.body.document.id;
  });

  it('refuses a person, a viewer agent and another project’s agent by name', async () => {
    for (const who of ['owner', 'viewerAgent', 'otherAgent'] as const) {
      const r = await call(who, 'POST', '/workflows', {
        baseRevision: null,
        document: releaseDoc(),
      });
      expect(r.status, `${who}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(r.body.code).toBe('WORKFLOW_WRITER_NOT_PROJECT');
    }
  });

  const plants: [string, (d: Doc) => void, string][] = [
    [
      'a cycle in after',
      (d) => (d.steps[0].after = ['reap']),
      'WORKFLOW_AFTER_CYCLE /steps/0/after',
    ],
    [
      'a dangling after',
      (d) => (d.steps[1].after = ['merge']),
      'WORKFLOW_AFTER_DANGLING /steps/1/after/0',
    ],
    [
      'a path outside the repo',
      (d) => (d.steps[0].evidence.file = '../etc/passwd'),
      'PATH_OUTSIDE_REPO /steps/0/evidence/file',
    ],
    ['an unknown kind', (d) => (d.kind = 'diagram'), 'WORKFLOW_KIND_UNKNOWN /kind'],
    ['an unknown status', (d) => (d.status = 'stale'), 'WORKFLOW_STATUS_UNKNOWN /status'],
  ];
  it.each(plants)('refuses %s by its code, writing nothing', async (_name, patch, expected) => {
    const doc = releaseDoc(patch);
    expect(
      codes(await call('agent', 'POST', '/workflows', { baseRevision: null, document: doc })),
    ).toEqual([expected]);
    const held = await harness.db.execute(
      sql`SELECT count(*)::int AS n, max(revision)::int AS rev FROM project_workflows WHERE project_id = ${projectId}`,
    );
    expect(held[0]).toMatchObject({ n: 1, rev: 1 });
  });

  it('refuses a second drawing of the same flow, and refreshes it by PUT at its revision', async () => {
    expect(
      codes(
        await call('agent', 'POST', '/workflows', { baseRevision: null, document: releaseDoc() }),
      ),
    ).toEqual(['WORKFLOW_DUPLICATE /flow']);
    const drifted = releaseDoc((d) => {
      d.status = 'rechecking';
      d.steps[3].status = 'rechecking';
      d.drift = { sha: d.refreshedAtSha, steps: ['reap'], reason: 'runs-cascade.ts changed' };
    });
    const put = await call('agent', 'PUT', `/workflows/${ids.release}`, {
      baseRevision: 1,
      document: drifted,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ revision: 2, document: { status: 'rechecking' } });
    const stale = await call('agent', 'PUT', `/workflows/${ids.release}`, {
      baseRevision: 1,
      document: drifted,
    });
    expect(codes(stale)).toEqual(['STALE_BASE /baseRevision']);
    const moved = await call('agent', 'PUT', `/workflows/${ids.release}`, {
      baseRevision: 2,
      document: releaseDoc((d) => (d.kind = 'state')),
    });
    expect(codes(moved)).toContain('WORKFLOW_IDENTITY_IMMUTABLE /kind');
  });

  it('is read by the project’s people, and the database refuses a kind core never wrote', async () => {
    const list = await call('owner', 'GET', '/workflows');
    expect(list.status).toBe(200);
    expect(list.body.workflows.map((w: Doc) => w.document.flow)).toEqual(['release']);
    const one = await call('owner', 'GET', `/workflows/${ids.release}`);
    expect(one.body.document.drift).toMatchObject({ steps: ['reap'] });
    await refusedByDb(
      harness.db.execute(
        sql`UPDATE project_workflows SET kind = 'diagram' WHERE id = ${ids.release}`,
      ),
      /project_workflows_kind_chk/,
    );
  });
});
