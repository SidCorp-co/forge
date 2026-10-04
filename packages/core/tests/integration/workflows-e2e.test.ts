import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

function designDoc(patch: (d: Doc) => void = () => {}): Doc {
  const d = example('post-discharge.design.json');
  d.project = projectId;
  patch(d);
  return d;
}

const SHA = 'e7af41887a0e90ed541bb0dbfb34d4f9cb4f8510';

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
  it('stores revision 1 of a design and answers it as written', async () => {
    const made = await call('agent', 'POST', '/workflows', {
      baseRevision: null,
      document: designDoc(),
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ revision: 1, created: true });
    expect(made.body.document).toMatchObject({ ...designDoc(), id: expect.any(String) });
    ids.design = made.body.document.id;
  });

  it('refuses a person, a viewer agent and another project’s agent by name', async () => {
    for (const who of ['owner', 'viewerAgent', 'otherAgent'] as const) {
      const r = await call(who, 'POST', '/workflows', {
        baseRevision: null,
        document: designDoc(),
      });
      expect(r.status, `${who}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(r.body.code).toBe('WORKFLOW_WRITER_NOT_PROJECT');
    }
  });

  const plants: [string, (d: Doc) => void, string][] = [
    [
      'a cycle in after',
      (d) => (d.steps[0].after = ['outcome']),
      'WORKFLOW_AFTER_CYCLE /steps/0/after',
    ],
    [
      'a step carrying evidence',
      (d) => (d.steps[0].evidence = null),
      'UNKNOWN_KEY /steps/0/evidence',
    ],
    ['a version-1 document', (d) => (d.version = 1), 'VERSION_UNSUPPORTED /version'],
  ];
  it.each(plants)('refuses %s by its code, writing nothing', async (_name, patch, expected) => {
    expect(
      codes(
        await call('agent', 'POST', '/workflows', {
          baseRevision: null,
          document: designDoc(patch),
        }),
      ),
    ).toEqual([expected]);
    const held = await harness.db.execute(
      sql`SELECT count(*)::int AS n, max(revision)::int AS rev FROM project_workflows WHERE project_id = ${projectId}`,
    );
    expect(held[0]).toMatchObject({ n: 1, rev: 1 });
  });
});

describe('what the code holds is an observation, stored apart from the design', () => {
  const step = (id: string, matches: string | null, symbol?: string) => ({
    id,
    matches,
    does: `observed ${id}`,
    after: [],
    evidence: { kind: 'repo', file: 'src/discharge.ts', ...(symbol ? { symbol } : {}) },
  });

  it('refuses an uncited node by name and stores nothing', async () => {
    const r = await call('agent', 'POST', `/workflows/${ids.design}/observations`, {
      atSha: SHA,
      steps: [step('discharged', 'discharged')],
    });
    expect(codes(r)).toEqual(['WORKFLOW_OBSERVATION_UNCITED /steps/0/evidence']);
    const held = await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM project_workflow_observations WHERE workflow_id = ${ids.design}`,
    );
    expect(held[0]).toMatchObject({ n: 0 });
  });

  it('stores a cited observation and leaves the design, its revision and its document untouched', async () => {
    const before = await call('owner', 'GET', `/workflows/${ids.design}`);
    const r = await call('agent', 'POST', `/workflows/${ids.design}/observations`, {
      atSha: SHA,
      steps: [step('discharged', 'discharged', 'onDischarge'), step('obs-extra', null, 'extra')],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.observation).toMatchObject({ atSha: SHA, revision: 1, stepCount: 2, matched: 1 });
    const after = await call('owner', 'GET', `/workflows/${ids.design}`);
    expect(after.body.revision).toBe(before.body.revision);
    expect(after.body.document).toEqual(before.body.document);
    const latest = await call('owner', 'GET', `/workflows/${ids.design}/observations/latest`);
    expect(latest.body.observation.document.steps.map((s: Doc) => s.id)).toEqual([
      'discharged',
      'obs-extra',
    ]);
  });
});
