/**
 * ISS-985, and the half of it only a real database can hold.
 *
 * The unit suites prove the CLI layer refuses. They cannot prove the other
 * assertion this issue rests on — that the SAME two bodies still go through
 * the REST route and the `forge_issues` create action and leave a row behind
 * them. If the API had moved, every refusal above would still be green and the
 * issue would have done the wrong thing; only this file catches that.
 *
 * So each body is sent three times: refused at the CLI door, accepted at REST,
 * accepted at the tool.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/** A feature body carrying every section the kind owes. */
const WHOLE = [
  '# The door refuses a malformed filing',
  '',
  '## Outcome',
  '',
  'A malformed filing is refused by name.',
  '',
  '## Rules',
  '',
  'The rule is that it always holds.',
  '',
  '## Out of scope',
  '',
  'Nothing else moves at all here.',
  '',
].join('\n');

/** The same body with the section the kind requires cut out of it. */
const MISSING_SECTION = WHOLE.replace('## Rules\n\nThe rule is that it always holds.\n\n', '');

const TITLE = 'The door refuses a malformed filing';

let harness: TestDatabase;
let schema: typeof import('../../src/db/schema.js');
let fileIssueThroughCli: typeof import('../../src/cli/file-issue.js')['fileIssueThroughCli'];
let forgeIssuesTool: typeof import('../../src/mcp/tools/forge-issues.js')['forgeIssuesTool'];
let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
let makeFakePrincipal: typeof import('../../src/mcp/fake-principal.fixture.js')['makeFakePrincipal'];
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

let userId: string;
let projectId: string;
let projectSlug: string;
let token: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  // cm:guard every core import here is DYNAMIC and happens after the env above is set — `db/client.ts` binds its pool at module load, so a static import resolves the wrong database before a case runs.
  ({ fileIssueThroughCli } = await import('../../src/cli/file-issue.js'));
  ({ forgeIssuesTool } = await import('../../src/mcp/tools/forge-issues.js'));
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ makeFakePrincipal } = await import('../../src/mcp/fake-principal.fixture.js'));
  schema = await import('../../src/db/schema.js');
  const { issueProjectRoutes } = await import('../../src/issues/routes.js');
  app = new Hono();
  app.route('/api/projects', issueProjectRoutes);
  // cm:why 300s rather than the 60s most suites take: this hook imports the REST issue router AND the `forge_issues` tool, which between them pull most of core's graph, and the pairing this file exists for needs both doors in one process. No `onError` mount: `middleware/error.js` costs another whole graph to import and every case here asserts a status, never a rendered message.
}, 300_000);

// cm:why the same budget the hook above needs, for the same reason: `harness.cleanup()` drains through `quiesceBackgroundWork`, which imports the outbox worker and the queue, and those are two more whole graphs to load before a single connection is closed. A hook budget is a ceiling and not a wait — a box that loads them in a second still finishes in a second.
afterAll(async () => {
  if (harness) await harness.cleanup();
}, 300_000);

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const project = await createTestProject(harness.db, userId);
  projectId = project.id;
  projectSlug = project.slug;
  token = await signUserToken(userId);
});

function writer() {
  return {
    createdById: userId,
    createdVia: 'mcp' as const,
    actor: { type: 'user' as const, id: userId, agency: 'human' as const },
  };
}

async function rowsTitled(title: string) {
  return harness.db
    .select({ id: schema.issues.id, category: schema.issues.category })
    .from(schema.issues)
    .where(and(eq(schema.issues.projectId, projectId), eq(schema.issues.title, title)));
}

async function postToRest(body: Record<string, unknown>) {
  return app.request(`/api/projects/${projectId}/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function sendToTool(data: Record<string, unknown>) {
  const tool = forgeIssuesTool({
    principal: makeFakePrincipal(randomUUID(), userId),
    projectSlug,
    boundProjectId: null,
  });
  return tool.handler({ action: 'create', data });
}

describe('a body missing a section its kind requires', () => {
  it('is refused at the CLI door, naming the section', async () => {
    const out = await fileIssueThroughCli(
      { projectId, title: TITLE, body: MISSING_SECTION, category: 'feature' },
      writer(),
    );
    expect(out.filed).toBe(false);
    expect(out.filed === false && out.because).toBe('section');
    expect(out.filed === false && out.refusal).toContain('rules, invariants or acceptance');
  });

  it('leaves no row behind when the CLI door refuses it', async () => {
    await fileIssueThroughCli(
      { projectId, title: TITLE, body: MISSING_SECTION, category: 'feature' },
      writer(),
    );
    expect(await rowsTitled(TITLE)).toHaveLength(0);
  });

  it('is ACCEPTED by the REST issue-create route', async () => {
    const res = await postToRest({ title: TITLE, description: MISSING_SECTION, category: 'feature' });
    expect(res.status).toBe(201);
  });

  it('leaves an issue row behind it at REST', async () => {
    await postToRest({ title: TITLE, description: MISSING_SECTION, category: 'feature' });
    expect(await rowsTitled(TITLE)).toHaveLength(1);
  });

  it('is ACCEPTED by the forge_issues create action', async () => {
    const out = (await sendToTool({
      title: TITLE,
      description: MISSING_SECTION,
      category: 'feature',
    })) as { documentId?: string };
    expect(out.documentId).toBeTruthy();
  });

  it('leaves an issue row behind it at the tool', async () => {
    await sendToTool({ title: TITLE, description: MISSING_SECTION, category: 'feature' });
    expect(await rowsTitled(TITLE)).toHaveLength(1);
  });
});

describe('a filing naming no category', () => {
  it('is refused at the CLI door, naming the four kinds', async () => {
    const out = await fileIssueThroughCli({ projectId, title: TITLE, body: WHOLE }, writer());
    expect(out.filed).toBe(false);
    expect(out.filed === false && out.because).toBe('category');
    expect(out.filed === false && out.refusal).toContain('bug, enhancement, feature, review');
  });

  it('leaves no row behind when the CLI door refuses it', async () => {
    await fileIssueThroughCli({ projectId, title: TITLE, body: WHOLE }, writer());
    expect(await rowsTitled(TITLE)).toHaveLength(0);
  });

  it('is ACCEPTED by the REST issue-create route', async () => {
    const res = await postToRest({ title: TITLE, description: WHOLE });
    expect(res.status).toBe(201);
  });

  // cm:guard the stored category must be NULL, not a default. A default filled in beneath the CLI layer is the API moving, which is the one thing ISS-985 says must not happen.
  it('leaves an issue row behind it at REST, carrying no category', async () => {
    await postToRest({ title: TITLE, description: WHOLE });
    const rows = await rowsTitled(TITLE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBeNull();
  });

  it('is ACCEPTED by the forge_issues create action', async () => {
    const out = (await sendToTool({ title: TITLE, description: WHOLE })) as { documentId?: string };
    expect(out.documentId).toBeTruthy();
  });

  it('leaves an issue row behind it at the tool, carrying no category', async () => {
    await sendToTool({ title: TITLE, description: WHOLE });
    const rows = await rowsTitled(TITLE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBeNull();
  });
});

describe('a whole body naming its kind', () => {
  it('is filed by the CLI door', async () => {
    const out = await fileIssueThroughCli(
      { projectId, title: TITLE, body: WHOLE, category: 'feature' },
      writer(),
    );
    expect(out.filed).toBe(true);
  });

  it('leaves exactly one row behind it, carrying the category it named', async () => {
    await fileIssueThroughCli(
      { projectId, title: TITLE, body: WHOLE, category: 'feature' },
      writer(),
    );
    const rows = await rowsTitled(TITLE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe('feature');
  });
});
