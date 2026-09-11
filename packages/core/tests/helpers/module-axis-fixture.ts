// The two surfaces a module-axis case needs before it can assert anything: the REST
// route project-settings drives, for authoring the taxonomy, and an MCP client for
// consuming it.
//
// Extracted from `module-attribution-mcp-e2e.test.ts` when ISS-587's fixes to three
// assertions pushed that file's outer `describe` past its line budget. The write half
// and the read half are now two suites over one fixture, and a second hand-typed copy
// of this setup is how one of them ends up proving its own plumbing instead of the axis.

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from './index.js';
import { connectClientAsPat, parseToolResult } from './mcp-harness.js';

export type IssueLabel = { id: string; name: string; kind: string; isPrimary: boolean };

export type JunctionRow = { label_id: string; is_primary: boolean };

export interface ModuleAxisFixture {
  db(): TestDatabase;
  projectId(): string;
  /** Define a label through the surface project-settings drives, not through MCP. */
  defineLabel(body: Record<string, unknown>): Promise<{ id: string; name: string }>;
  defineModule(
    name: string,
    extra?: Record<string, unknown>,
  ): Promise<{ id: string; name: string }>;
  createIssue(title: string): Promise<string>;
  setLabels(issueId: string, labels: unknown[]): Promise<unknown>;
  labelsOf(issueId: string): Promise<IssueLabel[]>;
  listIds(filters: Record<string, unknown>): Promise<string[]>;
  junction(issueId: string): Promise<JunctionRow[]>;
  /** The message an MCP refusal carries, or `null` when the call did not refuse. */
  refusalText(res: unknown): string | null;
  /** Just the code token of an MCP refusal, or `null` when the call did not refuse by a code. */
  refusalCode(res: unknown): string | null;
}

/** Installs the suite's own hooks, so each calling `describe` gets a clean project per case. */
export function installModuleAxisFixture(): ModuleAxisFixture {
  let harness: TestDatabase;
  let mintPat: typeof import('../../src/auth/pat.js').mintPat;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  // biome-ignore lint/suspicious/noExplicitAny: test-only mount
  let rest: any;
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
    const user = await createTestUser(harness.db);
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

  async function defineLabel(body: Record<string, unknown>): Promise<{ id: string; name: string }> {
    const res = await rest.request(`/api/projects/${project.id}/labels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; name: string };
  }

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

  // cm:guard the refusal's CODE is what a test may assert, never `isError` alone — `module-service.ts` declares "the code IS the contract … MCP as the `CODE: message` prefix, and both are asserted", and an assertion on `isError` holds just as green when `MULTIPLE_PRIMARY` degrades to a bare `BAD_REQUEST`, which is the contract going out from under the agent with no test noticing (ISS-587).
  function refusalText(res: unknown): string | null {
    const r = res as { isError?: boolean; content?: Array<{ type: string; text: string }> };
    if (r.isError !== true) return null;
    const first = r.content?.[0];
    return first?.type === 'text' ? first.text : '';
  }

  // cm:edge contract -> packages/core/src/mcp/server.ts — the shape parsed here is that handler's `Error: ${text}`, after it has stripped its own `BAD_REQUEST:`/`FORBIDDEN:`/`NOT_FOUND:` class prefix; what is left leads with the domain code, and a test asserting the code as a SUBSTRING would pass on `MULTIPLE_PRIMARY_LEGACY` too, so the token is matched whole (ISS-587).
  function refusalCode(res: unknown): string | null {
    const text = refusalText(res);
    return text === null ? null : (/^Error:\s*([A-Z][A-Z0-9_]*):\s/.exec(text)?.[1] ?? null);
  }

  return {
    db: () => harness,
    projectId: () => project.id,
    defineLabel,
    defineModule: (name, extra = {}) => defineLabel({ name, kind: 'module', ...extra }),
    createIssue,
    setLabels: (issueId, labels) =>
      tool({ action: 'update', projectId: project.id, documentId: issueId, data: { labels } }),
    labelsOf: async (issueId) => {
      const res = await tool({ action: 'get', projectId: project.id, documentId: issueId });
      return (parseToolResult(res as never) as { labels?: IssueLabel[] }).labels ?? [];
    },
    listIds: async (filters) => {
      const res = await tool({ action: 'list', projectId: project.id, filters });
      const out = parseToolResult(res as never) as { issues: Array<{ documentId: string }> };
      return out.issues.map((i) => i.documentId);
    },
    junction: async (issueId) => {
      const rows = await harness.db.execute<JunctionRow>(
        sql`SELECT label_id, is_primary FROM issue_labels WHERE issue_id = ${issueId}`,
      );
      return [...rows];
    },
    refusalText,
    refusalCode,
  };
}
