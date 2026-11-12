// @direct-test-of packages/core/src/mcp/requirements-tool.ts
/**
 * A PM links an existing design to an existing requirement and traces a criterion onto its steps
 * through the MCP Product door (ISS-1219, FB-622), as the REST routes do: link_design and
 * unlink_design as POST/DELETE …/requirements/:req/workflows, trace_criterion as PUT
 * …/criteria/:code/steps, each refusing by name as its route does, and each listed with its grant.
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { api, type Body, patToken, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';

interface Called {
  isError: boolean;
  text: string;
  body: Body;
}

let token: string;
let pat: string;
let readOnly: string;
let projectId: string;
let key: string;

async function call(t: string, name: string, args: Record<string, unknown>): Promise<Called> {
  const res = await api(
    t,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = (res.body as { result: { content: { text: string }[]; isError?: boolean } })
    .result;
  const text = result.content[0]?.text ?? '';
  let body: Body = {};
  try {
    body = JSON.parse(text) as Body;
  } catch {}
  return { isError: result.isError === true, text, body };
}

const door = (action: string, args: Body, t = pat) =>
  call(t, 'forge_requirements', { action, projectId, requirement: key, ...args });
const refusals = (c: Called) =>
  (
    (c.body.error as { refusals?: { code: string; path: string }[] } | undefined)?.refusals ?? []
  ).map((r) => `${r.code} ${r.path}`);
const shown = (c: Called) => {
  expect(c.isError, c.text).toBe(false);
  return c.body.requirement as Body;
};

beforeAll(async () => {
  const owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  pat = await patToken(owner, [projectId]);
  readOnly = (
    await mintPat({
      permissions: ['projects:read'],
      userId: owner,
      name: 'ro',
      projectIds: [projectId],
    })
  ).plaintext;
  const d = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  ) as Body;
  const made = await api(token, 'POST', `/api/projects/${projectId}/workflows`, {
    baseRevision: null,
    document: { ...d, project: projectId, flow: 'traced' },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const req = await api(token, 'POST', `/api/projects/${projectId}/requirements`, {
    title: 'A discharged patient is followed up',
    reason: 'follow-up after discharge',
    criteria: [{ body: 'A discharged patient who needs follow-up has one owned case.' }],
  });
  expect(req.status).toBe(201);
  key = req.body.key as string;
}, 60_000);

describe('forge_requirements links a design and traces a criterion onto it', () => {
  it('refuses a trace onto a design the requirement does not link, by name', async () => {
    const c = await door('trace_criterion', { code: 'BC-1', workflow: 'traced', steps: ['his'] });
    expect(c.isError, c.text).toBe(true);
    expect(refusals(c)).toContain('REQUIREMENT_DESIGN_UNLINKED /workflow');
  });

  it('answers NOT_FOUND for a design the project lacks, and refuses a read-only token', async () => {
    const missing = await door('link_design', { workflow: 'no-such-flow' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/NOT_FOUND|holds no workflow no-such-flow/);
    const ro = await door('link_design', { workflow: 'traced' }, readOnly);
    expect(ro.isError).toBe(true);
    expect(shown(await door('get', {})).designs).toEqual([]);
  });

  it('links by flow name, traces steps, refuses an unknown step, and unlinks', async () => {
    const linked = shown(await door('link_design', { workflow: 'traced' }));
    expect(linked.designs).toEqual([expect.objectContaining({ flow: 'traced' })]);

    const wrong = await door('trace_criterion', {
      code: 'BC-1',
      workflow: 'traced',
      steps: ['nope'],
    });
    expect(refusals(wrong)).toContain('WORKFLOW_NODE_UNKNOWN /steps/0');

    const traced = shown(
      await door('trace_criterion', { code: 'BC-1', workflow: 'traced', steps: ['his'] }),
    );
    expect(traced.traces).toEqual([{ code: 'BC-1', flow: 'traced', steps: ['his'], edges: [] }]);
    const rest = await api(token, 'GET', `/api/projects/${projectId}/requirements/${key}`);
    expect(rest.body.traces).toEqual([expect.objectContaining({ code: 'BC-1', steps: ['his'] })]);

    const gone = shown(await door('unlink_design', { workflow: 'traced' }));
    expect(gone.designs).toEqual([]);
    expect(gone.traces).toEqual([]);
    const again = await door('trace_criterion', {
      code: 'BC-1',
      workflow: 'traced',
      steps: ['his'],
    });
    expect(refusals(again)).toContain('REQUIREMENT_DESIGN_UNLINKED /workflow');
  });

  it('lists the three actions with the grant each needs', async () => {
    for (const action of ['link_design', 'unlink_design', 'trace_criterion']) {
      const d = await call(pat, 'forge_describe', { action: `requirements.${action}` });
      expect(d.isError, d.text).toBe(false);
      expect(JSON.stringify(d.body), action).toMatch(/projects:write|project\.write/);
    }
  });
});
