/**
 * ISS-950 — the generated diagrams against a real Postgres.
 *
 * Everything here is a claim SQL makes and a mocked client cannot: that the co-occurrence
 * self-join counts each unordered pair once, that a declared edge resolves through
 * `knowledge_edges`'s text ends, that a retracted edge is gone, and that a module with no
 * knowledge node still reaches the diagram. The shapes of the four kinds are pure and are proved
 * in `src/labels/module-diagrams.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  labelProjectRoutes: typeof import('../../src/labels/routes.js')['labelProjectRoutes'];
  moduleDiagramRoutes: typeof import('../../src/labels/module-diagram-routes.js')['moduleDiagramRoutes'];
  signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
  errorHandler: typeof import('../../src/middleware/error.js')['errorHandler'];
};

let harness: TestDatabase;
let mods: Mods;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let user: { id: string };
let outsider: { id: string };
let project: { id: string };
let token: string;
let outsiderToken: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [labelMod, diagramMod, jwtMod, errMod] = await Promise.all([
    import('../../src/labels/routes.js'),
    import('../../src/labels/module-diagram-routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  mods = {
    labelProjectRoutes: labelMod.labelProjectRoutes,
    moduleDiagramRoutes: diagramMod.moduleDiagramRoutes,
    signUserToken: jwtMod.signUserToken,
    errorHandler: errMod.errorHandler,
  };

  app = new Hono();
  app.route('/api/projects', mods.labelProjectRoutes);
  app.route('/api/projects', mods.moduleDiagramRoutes);
  app.onError(mods.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  user = await createTestUser(harness.db);
  outsider = await createTestUser(harness.db);
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id IN (${user.id}, ${outsider.id})`,
  );
  project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  token = await mods.signUserToken(user.id);
  outsiderToken = await mods.signUserToken(outsider.id);
});

const req = (path: string, as = token) =>
  app.request(`/api${path}`, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${as}` },
  });

const diagram = async (kind: string, as = token) => {
  const res = await req(`/projects/${project.id}/module-diagrams/${kind}`, as);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

async function createModule(
  name: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const res = await app.request(`/api/projects/${project.id}/labels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, kind: 'module', ...extra }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

async function insertNode(slug: string, body: string, metadata: unknown = {}): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO knowledge_entries (id, project_id, kind, slug, title, body, metadata)
    VALUES (${id}, ${project.id}, 'overview', ${slug}, ${slug}, ${body},
            ${JSON.stringify(metadata)}::jsonb)
  `);
  return id;
}

async function insertIssueWithModules(labelIds: string[]): Promise<void> {
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${project.id}, ${Math.floor(Math.random() * 1_000_000)},
            'Issue', 'open', ${user.id})
  `);
  for (const [i, labelId] of labelIds.entries()) {
    await harness.db.execute(sql`
      INSERT INTO issue_labels (issue_id, label_id, is_primary)
      VALUES (${issueId}, ${labelId}, ${i === 0})
    `);
  }
}

async function insertEdge(
  subject: string,
  predicate: string,
  object: string,
  validUntil: string | null = null,
): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO knowledge_edges (id, project_id, subject, predicate, object, valid_until)
    VALUES (${randomUUID()}, ${project.id}, ${subject}, ${predicate}, ${object},
            ${validUntil}::timestamptz)
  `);
}

const flowBody = (mermaid: string) => `# Node\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`;

describe('GET /api/projects/:id/module-diagrams/:kind', () => {
  it('refuses every kind on a project with no modules', async () => {
    for (const kind of ['mindmap', 'context', 'user-flow', 'swimlane']) {
      const { status, body } = await diagram(kind);
      expect(status).toBe(409);
      expect((body.cause as { code?: string } | undefined)?.code ?? body.code).toBe('NO_MODULES');
    }
  });

  it('refuses a caller who is not a member of the project', async () => {
    await createModule('Issue work');
    const { status } = await diagram('mindmap', outsiderToken);
    expect(status).toBe(403);
  });

  it('draws a module that has no knowledge node, with no count', async () => {
    await createModule('Issue work');
    const { status, body } = await diagram('mindmap');
    expect(status).toBe(200);
    expect(body.mermaid).toContain('Issue work');
    expect(body.mermaid).not.toContain('Issue work (');
  });

  it('counts a shared issue once per pair, not once per direction', async () => {
    const a = await createModule('Issue work');
    const b = await createModule('Runners');
    await insertIssueWithModules([a.id, b.id]);
    await insertIssueWithModules([a.id, b.id]);

    const { body } = await diagram('context');
    const mermaid = body.mermaid as string;
    expect(mermaid.match(/-\.->/g)).toHaveLength(1);
    expect(mermaid).toContain('2 shared');
  });

  it('draws a declared edge whose two ends both name modules of this project', async () => {
    await createModule('Issue work');
    await createModule('Runners');
    await insertEdge('issue-work', 'dispatches', 'Runners');
    await insertEdge('issue-work', 'mentions', 'something that is not a module');

    const mermaid = (await diagram('context')).body.mermaid as string;
    expect(mermaid).toContain('"dispatches"');
    expect(mermaid).not.toContain('"mentions"');
  });

  it('drops a declared edge whose validity has already run out', async () => {
    await createModule('Issue work');
    await createModule('Runners');
    await insertEdge('issue-work', 'dispatches', 'Runners', '2020-01-01T00:00:00Z');

    const mermaid = (await diagram('context')).body.mermaid as string;
    expect(mermaid).not.toContain('"dispatches"');
  });

  it('carries the related-issue count the bound node holds', async () => {
    const nodeId = await insertNode('module-issue-work', 'prose only');
    await harness.db.execute(sql`
      UPDATE knowledge_entries SET related_issue_ids = ${JSON.stringify([
        randomUUID(),
        randomUUID(),
      ])}::jsonb WHERE id = ${nodeId}
    `);
    await createModule('Issue work', { knowledgeEntryId: nodeId });

    expect((await diagram('mindmap')).body.mermaid).toContain('Issue work (2)');
  });

  it('refuses user-flow when no module node stores a flow', async () => {
    const nodeId = await insertNode('module-issue-work', 'prose only');
    await createModule('Issue work', { knowledgeEntryId: nodeId });

    const { status, body } = await diagram('user-flow');
    expect(status).toBe(409);
    expect((body.cause as { code?: string } | undefined)?.code ?? body.code).toBe(
      'NO_MODULE_FLOWS',
    );
  });

  it('refuses an unreadable stored flow by naming the module it came from', async () => {
    const nodeId = await insertNode('module-issue-work', flowBody('erDiagram\n  A ||--o{ B : has'));
    await createModule('Issue work', { knowledgeEntryId: nodeId });

    const { status, body } = await diagram('user-flow');
    expect(status).toBe(409);
    expect((body.cause as { code?: string } | undefined)?.code ?? body.code).toBe(
      'UNPARSABLE_MODULE_FLOW',
    );
    expect(body.message).toContain('issue-work');
  });

  it('answers the stored flow, and answers the edited one next time with no schedule run', async () => {
    const nodeId = await insertNode(
      'module-issue-work',
      flowBody('flowchart TD\n  A[Filed] --> B[Triaged]'),
    );
    await createModule('Issue work', { knowledgeEntryId: nodeId });

    const first = (await diagram('user-flow')).body.mermaid as string;
    expect(first).toContain('"Triaged"');
    expect((await diagram('user-flow')).body.mermaid).toBe(first);

    await harness.db.execute(sql`
      UPDATE knowledge_entries SET body = ${flowBody('flowchart TD\n  A[Filed] --> B[Shipped]')}
      WHERE id = ${nodeId}
    `);
    const second = (await diagram('user-flow')).body.mermaid as string;
    expect(second).toContain('"Shipped"');
    expect(second).not.toContain('"Triaged"');
  });

  it('takes a swimlane lane from the node metadata that declares an actor', async () => {
    const nodeId = await insertNode(
      'module-issue-work',
      flowBody('flowchart TD\n  A[Filed] --> B[Triaged]'),
      { actor: 'Reporter' },
    );
    await createModule('Issue work', { knowledgeEntryId: nodeId });

    expect((await diagram('swimlane')).body.mermaid).toContain('"Reporter"');
  });
});
