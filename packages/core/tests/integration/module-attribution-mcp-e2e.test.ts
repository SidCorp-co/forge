/**
 * ISS-588 — the Tier-2 parent's end-to-end pass, at the seam none of its three children owned.
 *
 * ISS-593 proved the module taxonomy against Postgres through REST, ISS-594 proved the web-v2
 * surfaces, ISS-595 proved the taxonomy reaching an agent's prompt. What no test reached is
 * `forge_issues` — the surface the issue's own acceptance names — where the filter and the
 * primary-module designation are hand-copied from the MCP boundary into the service call. A
 * mapping is exactly the thing a unit suite agrees with itself about: `complexity` reached all
 * three projections and the strict schema with no way to filter on it, and every unit test was
 * green throughout (ISS-912).
 *
 * The cross-surface direction is the other half: a taxonomy an admin defines through
 * `labels/routes.ts` (what project-settings drives) being consumed by an agent through MCP. Both
 * halves of that handshake live in different packages and neither child's suite crosses it.
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
import { connectClientAsPat, parseToolResult } from '../helpers/mcp-harness.js';

type IssueLabel = { id: string; name: string; kind: string; isPrimary: boolean };

describe('ISS-588 · the module axis through forge_issues', () => {
  let harness: TestDatabase;
  let mintPat: typeof import('../../src/auth/pat.js').mintPat;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  // biome-ignore lint/suspicious/noExplicitAny: test-only mount
  let rest: any;
  let user: { id: string };
  let project: { id: string };
  let token: string;
  let ctx: Awaited<ReturnType<typeof connectClientAsPat>>;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';

    const [labelMod, jwtMod, errMod, patMod] = await Promise.all([
      import('../../src/labels/routes.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/middleware/error.js'),
      import('../../src/auth/pat.js'),
    ]);
    ({ mintPat } = patMod);
    ({ signUserToken } = jwtMod);

    rest = new Hono();
    rest.route('/api/projects', labelMod.labelProjectRoutes);
    rest.onError(errMod.errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    token = await signUserToken(user.id);
    const { plaintext } = await mintPat({ userId: user.id, name: 'test-cli' });
    ctx = await connectClientAsPat(plaintext);
  });

  /** Define a label through the surface project-settings drives, not through MCP. */
  async function defineLabel(body: Record<string, unknown>): Promise<{ id: string; name: string }> {
    const res = await rest.request(`/api/projects/${project.id}/labels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; name: string };
  }

  const defineModule = (name: string, extra: Record<string, unknown> = {}) =>
    defineLabel({ name, kind: 'module', ...extra });

  async function tool(args: Record<string, unknown>) {
    return ctx.client.callTool({ name: 'forge_issues', arguments: args });
  }

  async function createIssue(title: string): Promise<string> {
    const res = await tool({
      action: 'create',
      projectId: project.id,
      data: { title, status: 'draft', priority: 'low' },
    });
    return (parseToolResult(res as never) as { documentId: string }).documentId;
  }

  async function setLabels(issueId: string, labels: unknown[]) {
    return tool({ action: 'update', projectId: project.id, documentId: issueId, data: { labels } });
  }

  async function labelsOf(issueId: string): Promise<IssueLabel[]> {
    const res = await tool({ action: 'get', projectId: project.id, documentId: issueId });
    return (parseToolResult(res as never) as { labels?: IssueLabel[] }).labels ?? [];
  }

  async function listIds(filters: Record<string, unknown>): Promise<string[]> {
    const res = await tool({ action: 'list', projectId: project.id, filters });
    const out = parseToolResult(res as never) as { issues: Array<{ documentId: string }> };
    return out.issues.map((i) => i.documentId);
  }

  async function junction(issueId: string) {
    const rows = await harness.db.execute<{ label_id: string; is_primary: boolean }>(
      sql`SELECT label_id, is_primary FROM issue_labels WHERE issue_id = ${issueId}`,
    );
    return [...rows];
  }

  it('carries a taxonomy defined through REST into an attribution written through MCP', async () => {
    const parent = await defineModule('platform');
    const child = await defineModule('platform/labels', { parentId: parent.id });
    const issueId = await createIssue('an issue against the labels module');

    const res = await setLabels(issueId, [{ labelId: child.name, isPrimary: true }]);
    expect((res as { isError?: boolean }).isError ?? false).toBe(false);

    expect(await junction(issueId)).toEqual([{ label_id: child.id, is_primary: true }]);
    expect(await labelsOf(issueId)).toEqual([
      expect.objectContaining({ id: child.id, kind: 'module', isPrimary: true }),
    ]);
  });

  it('keeps exactly one primary when a set carries a primary and a secondary', async () => {
    const primary = await defineModule('core');
    const secondary = await defineModule('web');
    const issueId = await createIssue('cross-cutting work');

    await setLabels(issueId, [{ labelId: primary.name, isPrimary: true }, secondary.name]);

    const rows = await junction(issueId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.is_primary)).toEqual([{ label_id: primary.id, is_primary: true }]);
  });

  // cm:guard the assertion is that the junction is UNCHANGED, not merely that the call errored — the refusal happens outside the transaction in `resolveLabelIdsForWrite`, and a version that refused after opening one would leave the issue holding a set nobody asked for while still answering with an error.
  it('refuses a second primary in one set through MCP, and writes nothing', async () => {
    const first = await defineModule('core');
    const second = await defineModule('web');
    const issueId = await createIssue('two primaries');
    await setLabels(issueId, [{ labelId: first.name, isPrimary: true }]);

    const res = await setLabels(issueId, [
      { labelId: first.name, isPrimary: true },
      { labelId: second.name, isPrimary: true },
    ]);

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(await junction(issueId)).toEqual([{ label_id: first.id, is_primary: true }]);
  });

  it('refuses a plain label marked primary through MCP, and writes nothing', async () => {
    const plain = await defineLabel({ name: 'bug', color: '#ff0000' });
    const issueId = await createIssue('a plain label cannot be primary');

    const res = await setLabels(issueId, [{ labelId: plain.name, isPrimary: true }]);

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(await junction(issueId)).toEqual([]);
  });

  // cm:guard assert the OTHER issue is ABSENT, not merely that the wanted one is present. `filters.module` is hand-copied into the search params in `mcp/tools/forge-issues.ts`; a mapping that drops it returns EVERY issue in the project, which an assertion that only looks for its own issue passes against just as happily.
  it('narrows the list to the module and leaves the others out', async () => {
    const wanted = await defineModule('core');
    const other = await defineModule('web');
    const tagged = await createIssue('against core');
    const untagged = await createIssue('against web');
    await setLabels(tagged, [{ labelId: wanted.name, isPrimary: true }]);
    await setLabels(untagged, [{ labelId: other.name, isPrimary: true }]);

    const ids = await listIds({ module: wanted.name });

    expect(ids).toContain(tagged);
    expect(ids).not.toContain(untagged);
  });

  it('narrows by module uuid exactly as it does by name', async () => {
    const wanted = await defineModule('core');
    const other = await defineModule('web');
    const tagged = await createIssue('against core');
    const untagged = await createIssue('against web');
    await setLabels(tagged, [{ labelId: wanted.name, isPrimary: true }]);
    await setLabels(untagged, [{ labelId: other.name, isPrimary: true }]);

    const ids = await listIds({ module: wanted.id });

    expect(ids).toContain(tagged);
    expect(ids).not.toContain(untagged);
  });

  it('matches nothing for the name of a plain label, rather than behaving as filters.label', async () => {
    const plain = await defineLabel({ name: 'bug', color: '#ff0000' });
    const issueId = await createIssue('carries a plain label');
    await setLabels(issueId, [plain.name]);

    expect(await listIds({ module: plain.name })).toEqual([]);
  });

  it('matches nothing for a module no project defines', async () => {
    await defineModule('core');
    const issueId = await createIssue('against core');
    await setLabels(issueId, ['core']);

    expect(await listIds({ module: 'a-module-nobody-defined' })).toEqual([]);
  });

  it('leaves filters.label answering as it did before the module axis existed', async () => {
    const plain = await defineLabel({ name: 'bug', color: '#ff0000' });
    const module = await defineModule('core');
    const tagged = await createIssue('carries the plain label');
    const untagged = await createIssue('carries only a module');
    await setLabels(tagged, [plain.name]);
    await setLabels(untagged, [{ labelId: module.name, isPrimary: true }]);

    const ids = await listIds({ label: plain.name });

    expect(ids).toContain(tagged);
    expect(ids).not.toContain(untagged);
  });

  it('does not narrow to another project’s module of the same name', async () => {
    const otherOwner = await createTestUser(harness.db);
    const otherProject = await createTestProject(harness.db, otherOwner.id);
    await harness.db.execute(sql`
      INSERT INTO labels (id, project_id, name, color, kind)
      VALUES (${randomUUID()}, ${otherProject.id}, 'core', '#123456', 'module')
    `);
    const issueId = await createIssue('this project has no module called core');
    void issueId;

    expect(await listIds({ module: 'core' })).toEqual([]);
  });
});
