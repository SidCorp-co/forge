/**
 * `forge_design` action `design_withdraw` through `/mcp` with a token, against real Postgres: it calls
 * the service REST's `POST …/design/withdraw` calls, so a design never approved leaves the list, and
 * each refusal comes through by its code, as `design_decide`'s do.
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, patToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

type Json = Record<string, unknown>;
type Answer = { isError: boolean; text: string; json: Json };

let projectId: string;
const tokens = { owner: '', member: '', viewer: '' };

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
  const memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  tokens.member = await patToken(memberId, [projectId], 'mcp-member');
  const viewerId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, viewerId, 'viewer');
  tokens.viewer = await patToken(viewerId, [projectId], 'mcp-viewer');
});

async function mcp(who: keyof typeof tokens, name: string, args: Json): Promise<Answer> {
  const res = await api(
    tokens[who],
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

const ok = (a: Answer): Json => {
  expect(a.isError, a.text).toBe(false);
  return a.json;
};

const design = (): Json =>
  JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  ) as Json;

describe('forge_design design_withdraw', () => {
  it('withdraws a design never approved, and names each refusal as REST does', async () => {
    const write = async (flow: string) => {
      const made = ok(
        await mcp('member', 'forge_design', {
          action: 'design_create',
          projectId,
          body: { baseRevision: null, document: { ...design(), project: projectId, flow } },
        }),
      );
      const workflowId = String((made.document as Json).id);
      ok(
        await mcp('member', 'forge_design', {
          action: 'design_propose',
          projectId,
          workflowId,
          revision: 1,
        }),
      );
      return workflowId;
    };
    const throwaway = await write('mcp-throwaway');
    const byViewer = await mcp('viewer', 'forge_design', {
      action: 'design_withdraw',
      projectId,
      workflowId: throwaway,
    });
    expect(byViewer.isError, byViewer.text).toBe(true);

    const withdrawn = ok(
      await mcp('member', 'forge_design', {
        action: 'design_withdraw',
        projectId,
        workflowId: throwaway,
        reason: 'a QA judge drew it',
      }),
    );
    expect(withdrawn.status).toBe('withdrawn');
    const listed = ok(await mcp('member', 'forge_design', { action: 'design_list', projectId }));
    expect(listed.returned).toBe(0);

    const again = await mcp('member', 'forge_design', {
      action: 'design_withdraw',
      projectId,
      workflowId: throwaway,
    });
    expect(again.isError, again.text).toBe(true);
    expect(again.text).toContain('DESIGN_ALREADY_WITHDRAWN');

    const history = await write('mcp-history');
    ok(
      await mcp('owner', 'forge_design', {
        action: 'design_decide',
        projectId,
        workflowId: history,
        revision: 1,
        decision: 'approve',
      }),
    );
    const approved = await mcp('member', 'forge_design', {
      action: 'design_withdraw',
      projectId,
      workflowId: history,
    });
    expect(approved.isError, approved.text).toBe(true);
    expect(approved.text).toContain('DESIGN_WITHDRAW_APPROVED');
  });
});
