/**
 * A workflow design read over MCP as it stands (`forge_design` design_get), against real Postgres:
 * a draft never proposed returns its current document and its steps as REST's GET returns them, a
 * proposed revision and an approved one redrawn each read, and a caller who cannot read the project
 * is refused by name. A redraw of a draft is drawn from this read.
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, patToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

type Json = Record<string, unknown>;
type Answer = { isError: boolean; text: string; json: Json };

let projectId: string;
const tokens = { owner: '', agent: '', member: '', viewer: '' };

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  tokens.owner = await patToken(ownerId, [projectId], 'mcp-owner');
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'admin');
  tokens.agent = await patToken(agentId, [projectId], 'mcp-agent');
  const memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  tokens.member = await patToken(memberId, [projectId], 'mcp-member');
  const viewerId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, viewerId, 'viewer');
  tokens.viewer = await patToken(viewerId, [projectId], 'mcp-viewer');
  await seedProjectDocument(projectId, ownerId, {
    environments: {},
    source: { type: 'none' },
    extra: { approvals: { designs: true } },
  });
});

async function mcpAs(token: string, name: string, args: Json): Promise<Answer> {
  const res = await api(
    token,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = res.body.result as { content: { text: string }[]; isError?: boolean };
  const text = result.content[0]?.text ?? '';
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {}
  return { isError: result.isError === true, text, json };
}
const mcp = (who: keyof typeof tokens, name: string, args: Json) => mcpAs(tokens[who], name, args);

const ok = (a: Answer): Json => {
  expect(a.isError, a.text).toBe(false);
  return a.json;
};
const codeOf = (a: Answer) => {
  expect(a.isError, a.text).toBe(true);
  return (a.json.error as { code?: string } | undefined)?.code ?? a.text;
};

const design = (): Json =>
  JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  ) as Json;

describe('design_get reads the design as it stands, whether or not a revision was proposed', () => {
  type Steps = { revision: number; stepCount: number; steps: Json[]; edges: Json[] };
  const stepIds = (steps: Json[]) => steps.map((s) => s.id);

  async function drawn(flow: string): Promise<{ workflowId: string; document: Json }> {
    const document = { ...design(), project: projectId, flow };
    const made = ok(
      await mcp('member', 'forge_design', {
        action: 'design_create',
        projectId,
        body: { baseRevision: null, document },
      }),
    );
    return { workflowId: String((made.document as Json).id), document };
  }
  const get = (who: keyof typeof tokens, workflowId: string, extra: Json = {}) =>
    mcp(who, 'forge_design', { action: 'design_get', projectId, workflowId, ...extra });

  it('a draft never proposed: every view returns its current document, as REST reads it', async () => {
    const { workflowId, document } = await drawn('draft-never-proposed');
    const rest = await api(
      tokens.viewer,
      'GET',
      `/api/projects/${projectId}/workflows/${workflowId}`,
    );
    expect(rest.status).toBe(200);
    const restSteps = (rest.body.document as { steps: Json[] }).steps;

    for (const who of ['viewer', 'agent'] as const) {
      const summary = ok(await get(who, workflowId));
      expect(summary).toMatchObject({ status: 'draft', revision: 1, revisions: [] });
      expect(summary.current).toEqual({
        revision: 1,
        stepCount: restSteps.length,
        edgeCount: (document.edges as unknown[]).length,
        updatedAt: expect.any(String),
      });

      const steps = ok(await get(who, workflowId, { view: 'steps' }));
      const read = steps.document as Steps;
      expect(read.revision).toBe(1);
      expect(read.stepCount).toBe(restSteps.length);
      expect(stepIds(read.steps)).toEqual(stepIds(restSteps));
      expect(read.edges.length).toBe((document.edges as unknown[]).length);

      const full = ok(await get(who, workflowId, { view: 'full' }));
      const current = full.current as { revision: number; document: { steps: Json[] } };
      expect(current.revision).toBe(1);
      expect(stepIds(current.document.steps)).toEqual(stepIds(restSteps));
    }

    const named = ok(await get('viewer', workflowId, { view: 'steps', revision: 1, stepTo: 2 }));
    expect(stepIds((named.document as Steps).steps)).toEqual(stepIds(restSteps.slice(0, 2)));
  });

  it('a revision neither proposed nor current is refused naming the revisions that read', async () => {
    const { workflowId } = await drawn('draft-wrong-revision');
    const refused = await get('viewer', workflowId, { view: 'steps', revision: 4 });
    expect(codeOf(refused)).toBe('BAD_REQUEST');
    expect(refused.text).toContain('revision 4');
    expect(refused.text).toContain('current revision 1');
    const unbound = await get('viewer', workflowId, { revision: 1 });
    expect(codeOf(unbound)).toBe('BAD_REQUEST');
    expect(unbound.text).toContain('view=steps');
  });

  it('a proposed design reads its proposed revision; an approved one redrawn reads both', async () => {
    const { workflowId, document } = await drawn('proposed-then-approved');
    ok(
      await mcp('member', 'forge_design', {
        action: 'design_propose',
        projectId,
        workflowId,
        revision: 1,
      }),
    );
    const proposed = ok(await get('viewer', workflowId, { view: 'steps' }));
    expect(proposed.proposedRevision).toBe(1);
    expect((proposed.document as Steps).revision).toBe(1);
    expect((proposed.document as Steps).stepCount).toBe((document.steps as unknown[]).length);

    ok(
      await mcp('owner', 'forge_design', {
        action: 'design_decide',
        projectId,
        workflowId,
        revision: 1,
        decision: 'approve',
      }),
    );
    const redrawnSays = 'The coordinator calls the patient within two working days.';
    const steps = (document.steps as Json[]).map((s) =>
      s.id === 'call' ? { ...s, does: redrawnSays } : s,
    );
    ok(
      await mcp('member', 'forge_design', {
        action: 'design_revise',
        projectId,
        workflowId,
        body: { baseRevision: 1, document: { ...document, steps } },
      }),
    );
    const says = (read: Json) => (read.document as Steps).steps.find((s) => s.id === 'call')?.does;
    const redrawn = ok(await get('viewer', workflowId, { view: 'steps' }));
    expect(redrawn).toMatchObject({ approvedRevision: 1, revision: 2 });
    expect((redrawn.document as Steps).revision).toBe(2);
    expect(says(redrawn)).toBe(redrawnSays);
    const approved = ok(await get('viewer', workflowId, { view: 'steps', revision: 1 }));
    expect((approved.document as Steps).revision).toBe(1);
    expect(says(approved)).not.toBe(redrawnSays);
  });

  it('a caller who cannot read the project is refused by name, draft or not', async () => {
    const { workflowId } = await drawn('draft-outsider');
    const outsiderId = (await createTestUser({ verified: true })).id;
    const outsider = await patToken(outsiderId, [projectId], 'mcp-outsider');
    const refused = await mcpAs(outsider, 'forge_design', {
      action: 'design_get',
      projectId,
      workflowId,
      view: 'steps',
    });
    expect(refused.isError).toBe(true);
    const text = refused.text;
    expect(text).toContain('project.read');
    expect(text).not.toContain('"steps"');
  });
});
