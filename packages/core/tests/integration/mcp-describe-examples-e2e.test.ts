/**
 * REQ-78 BC-3, through the real HTTP /mcp against real Postgres: describe is enough to call each
 * action. Every write a client sets a project up by answers an example in forge_describe, and that
 * example, sent through forge_call with only its placeholders filled, is accepted: a requirement, a
 * design created with no id, stamps or writtenBy and then revised, the project document, the gates
 * read and written, a feedback item with its one target, an issue and a project. A design created
 * with the stamps the served schema shows drops them and says so; a create naming no target is
 * refused by name.
 *
 * @direct-test-of packages/core/src/product-door/design-describe.ts
 * @direct-test-of packages/core/src/project-config/tool.ts
 * @direct-test-of packages/core/src/mcp/feedback-tool.ts
 * @direct-test-of packages/core/src/workflows/read-back.ts
 */

import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';

type Body = Record<string, unknown>;
let ownerId = '';
let projectId = '';
let projectSlug = '';
let orgId = '';

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  const made = await createTestProject(ownerId);
  projectId = made.id;
  projectSlug = made.slug;
  orgId = made.orgId;
  await addProjectMember(projectId, ownerId, 'owner');
});

const pat = async (projectIds: string[] | null) =>
  (
    await mintPat({
      permissions: ['*'],
      userId: ownerId,
      name: `mcp-1185-${randomBytes(4).toString('hex')}`,
      projectIds,
    })
  ).plaintext;

async function call(token: string, name: string, args: Body) {
  const res = await api(
    token,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = (res.body as { result: { content: { text: string }[]; isError?: boolean } })
    .result;
  const text = result.content.map((c) => c.text).join('\n');
  let body: Body = {};
  try {
    body = JSON.parse(result.content[0]?.text ?? '') as Body;
  } catch {}
  return { isError: result.isError === true, text, body };
}

/** The example describe answers for `action`, its placeholders filled with what the caller holds. */
async function example(token: string, action: string, held: Record<string, string> = {}) {
  const d = await call(token, 'forge_describe', { action });
  expect(d.isError, d.text).toBe(false);
  const fill: Record<string, string> = {
    '<project uuid>': projectId,
    '<project slug>': projectSlug,
    '<plugin sha>': '73225dedb41b5da26b4ce73518086e26e81f91b8',
    ...held,
  };
  const { args } = d.body.example as { args: Body };
  return JSON.parse(JSON.stringify(args), (_k, v) =>
    typeof v === 'string' && v in fill ? fill[v] : v,
  ) as Body;
}

/** forge_call with describe's example, as written but for its placeholders. */
async function callAsWritten(token: string, action: string, held: Record<string, string> = {}) {
  const args = await example(token, action, held);
  const r = await call(token, 'forge_call', { action, args });
  expect(r.isError, `${action}: ${r.text}`).toBe(false);
  return r.body;
}

describe("each write's example is accepted as written", () => {
  it('sets a project up: requirement, design, document, gates, feedback and issue', async () => {
    const token = await pat([projectId]);

    const first = await callAsWritten(token, 'requirements.create');
    expect((first.requirement as Body).key).toBe('REQ-1');
    await callAsWritten(token, 'requirements.create');
    const suggested = await callAsWritten(token, 'design.suggestion_create');
    expect((suggested.suggestion as Body).kind).toBe('duplicate');

    const templates = await callAsWritten(token, 'design.template_list');
    expect((templates.templates as Body[]).map((t) => t.id)).toContain('state-machine');
    const created = await callAsWritten(token, 'design.design_create');
    expect(created).toMatchObject({ created: true, revision: 1 });
    expect((created.document as Body).writtenBy).toEqual({});
    const revised = await callAsWritten(token, 'design.design_revise', {
      '<workflow uuid>': String(created.workflowId),
    });
    expect(revised.revision).toBe(2);

    const written = await callAsWritten(token, 'config.write');
    expect(written).toMatchObject({ declared: true, revision: 1, created: true });
    const gates = await callAsWritten(token, 'config.gates_write');
    expect(gates).toMatchObject({ profile: 'standard', revision: 2 });
    expect((gates.changes as Body[])[0]?.reason).toBe(
      'The team reviews every change before it lands.',
    );
    const read = await callAsWritten(token, 'config.gates_get');
    expect(read.profile).toBe('standard');
    const table = await callAsWritten(token, 'config.gate_profiles');
    expect(table.profiles).toEqual(['strict', 'standard', 'yolo']);

    const filed = await callAsWritten(token, 'project_feedback.submit');
    expect((filed.feedback as Body).key).toBe('FB-1');
    await callAsWritten(token, 'issues.create');
  });

  it('creates a project from an unfenced token, in the caller’s personal org', async () => {
    await db.execute(sql`UPDATE organizations SET is_personal = true WHERE id = ${orgId}`);
    const made = await callAsWritten(await pat(null), 'projects.create');
    expect(made.slug).toBe('shop');
  });
});

describe('what a create leaves to the server, and what it refuses', () => {
  it('drops the stamps the served schema shows on a design create, and lists them', async () => {
    const token = await pat([projectId]);
    const args = await example(token, 'design.design_create');
    const body = args.body as { document: Body };
    body.document = {
      ...body.document,
      id: '00000000-0000-4000-8000-000000001185',
      createdAt: '2026-11-09T00:00:00Z',
      updatedAt: '2026-11-09T00:00:00Z',
    };
    const r = await call(token, 'forge_call', { action: 'design.design_create', args });
    expect(r.isError, r.text).toBe(false);
    expect((r.body.document as Body).id).not.toBe('00000000-0000-4000-8000-000000001185');
    expect((r.body.ignored as { path: string }[]).map((i) => i.path)).toEqual([
      '/document/id',
      '/document/createdAt',
      '/document/updatedAt',
    ]);
  });

  it('refuses a feedback submit naming no target, and one naming a requirement loose, by name', async () => {
    const token = await pat([projectId]);
    const none = await call(token, 'forge_call', {
      action: 'project_feedback.submit',
      args: { projectId, kind: 'bug', title: 'Reorder leaves the cart empty' },
    });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/action submit needs target/);
    const loose = await call(token, 'forge_call', {
      action: 'project_feedback.submit',
      args: {
        projectId,
        kind: 'bug',
        title: 'Reorder leaves the cart empty',
        requirement: 'REQ-1',
      },
    });
    expect(loose.isError).toBe(true);
    expect(loose.text).toMatch(/submit names a requirement as its target/);
  });

  it('refuses gates written through config.write, naming the action that writes them', async () => {
    const token = await pat([projectId]);
    await callAsWritten(token, 'config.write');
    const args = await example(token, 'config.write');
    const r = await call(token, 'forge_call', {
      action: 'config.write',
      args: {
        ...args,
        baseRevision: 1,
        document: { ...(args.document as Body), gates: { profile: 'strict' } },
      },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/GATES_WRITTEN_THROUGH_THEIR_DOOR/);
    expect(r.text).toMatch(/config\.gates_write/);
  });
});
