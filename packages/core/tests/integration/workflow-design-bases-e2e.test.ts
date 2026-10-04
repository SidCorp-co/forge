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
let ownerId: string;
const tokens: Record<'owner' | 'master', string> = { owner: '', master: '' };

const read = (rel: string): Doc => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const designDoc = (patch: (d: Doc) => void = () => {}): Doc => {
  const d = read('../../src/workflows/fixtures/post-discharge.design.json');
  d.project = projectId;
  patch(d);
  return d;
};

async function declareProject() {
  const doc = read('../../src/project-config/fixtures/examples/hop.project.json');
  doc.project = { ...doc.project, id: projectId, slug: `hop-${projectId.slice(0, 8)}` };
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
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
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
  await declareProject();
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

const create = async (flow: string, patch: (d: Doc) => void = () => {}) => {
  const made = await call('master', 'POST', at('/workflows'), {
    baseRevision: null,
    document: designDoc((d) => {
      d.flow = flow;
      patch(d);
    }),
  });
  return made;
};
const propose = (id: string, revision: number) =>
  call('master', 'POST', at(`/workflows/${id}/design/propose`), { revision });
const decide = (id: string, revision: number, decision: 'approve' | 'return', reason?: string) =>
  call('owner', 'POST', at(`/workflows/${id}/design/decision`), {
    revision,
    decision,
    ...(reason ? { reason } : {}),
  });
const refusalCodes = (r: { body: Doc }) =>
  r.body.error?.refusals?.map((x: Doc) => x.code) ?? [r.body.error?.code];

describe('FB-51 a design declares the designs it builds on, and is approved only on approved bases', () => {
  let baseId = '';
  let dependentId = '';

  it('refuses at write a base naming the design itself, a flow the project lacks, or a revision never held', async () => {
    const self = await create('dependent-self', (d) => {
      d.basedOn = [{ workflow: 'dependent-self', revision: 1 }];
    });
    expect(self.status, JSON.stringify(self.body)).toBe(422);
    expect(refusalCodes(self)).toEqual(['WORKFLOW_BASE_SELF']);
    const ghost = await create('dependent-ghost', (d) => {
      d.basedOn = [{ workflow: 'audit-ghost', revision: 1 }];
    });
    expect(refusalCodes(ghost)).toEqual(['WORKFLOW_BASE_UNKNOWN']);
  });

  it('refuses approving a dependent while its base revision is returned, naming the base and its state', async () => {
    const base = await create('audit-base');
    expect(base.status, JSON.stringify(base.body)).toBe(201);
    baseId = base.body.document.id;
    expect((await propose(baseId, 1)).status).toBe(200);
    expect((await decide(baseId, 1, 'return', 'the audit groups are missing')).status).toBe(200);

    const tooFar = await create('derived-state', (d) => {
      d.basedOn = [{ workflow: 'audit-base', revision: 2 }];
    });
    expect(refusalCodes(tooFar)).toEqual(['WORKFLOW_BASE_UNKNOWN']);

    const dependent = await create('derived-state', (d) => {
      d.basedOn = [{ workflow: 'audit-base', revision: 1 }];
    });
    expect(dependent.status, JSON.stringify(dependent.body)).toBe(201);
    dependentId = dependent.body.document.id;
    expect((await propose(dependentId, 1)).status).toBe(200);

    const refused = await decide(dependentId, 1, 'approve');
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refusalCodes(refused)).toEqual(['WORKFLOW_DESIGN_BASE_UNAPPROVED']);
    expect(JSON.stringify(refused.body)).toContain(
      '\\"audit-base\\" rev 1, which is returned, with no approved revision',
    );
    const design = await call('owner', 'GET', at(`/workflows/${dependentId}/design`));
    expect(design.body).toMatchObject({ status: 'proposed', approvedRevision: null });
  });

  it('still lets the approver return the dependent: a return reads no base', async () => {
    const returned = await decide(dependentId, 1, 'return', 'wait for the audit base');
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
  });

  it('approves the dependent once its base is approved at the revision it names', async () => {
    const rewrite = await call('master', 'PUT', at(`/workflows/${baseId}`), {
      baseRevision: 1,
      document: designDoc((d) => {
        d.flow = 'audit-base';
        d.summary = `${d.summary} Audit groups added.`;
      }),
    });
    expect(rewrite.status, JSON.stringify(rewrite.body)).toBe(200);
    expect((await decide(baseId, 2, 'approve')).status).toBe(200);

    const stale = await call('master', 'PUT', at(`/workflows/${dependentId}`), {
      baseRevision: 1,
      document: designDoc((d) => {
        d.flow = 'derived-state';
        d.summary = `${d.summary} Revised.`;
        d.basedOn = [{ workflow: 'audit-base', revision: 1 }];
      }),
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(200);
    const onOld = await decide(dependentId, 2, 'approve');
    expect(refusalCodes(onOld)).toEqual(['WORKFLOW_DESIGN_BASE_UNAPPROVED']);
    expect(JSON.stringify(onOld.body)).toContain('which is approved, with approved revision 2');

    const current = await call('master', 'PUT', at(`/workflows/${dependentId}`), {
      baseRevision: 2,
      document: designDoc((d) => {
        d.flow = 'derived-state';
        d.summary = `${d.summary} Revised.`;
        d.basedOn = [{ workflow: 'audit-base', revision: 2 }];
      }),
    });
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    const approved = await decide(dependentId, 3, 'approve');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', approvedRevision: 3 });
  });
});
