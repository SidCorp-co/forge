/**
 * An MCP tool action's declared permission is checked by the door before its handler runs (REQ-12
 * BC-20, ISS-824): through `/mcp` with a token, against real Postgres. Each case picks a call the
 * handler would refuse for another reason before its own permission check (a missing argument, an
 * issue key naming nothing), so only the door's check answers PERMISSION_FORBIDDEN: removing the
 * declaration, or lowering it to a permission the caller holds, turns the answer into the handler's
 * own refusal. A holder of the permission passes the door and reaches the handler.
 *
 * An action whose project the handler resolves (project_feedback: the projectId argument, else the
 * slug header or the token's one project) declares it `onResolved`, and its service checks with
 * requireDeclaredOn: there the declaration answers wherever the service's own floor is lower, so
 * lowering that floor leaves the refusal standing, and lowering the declaration too turns it.
 *
 * @direct-test-of packages/core/src/project-config/tool.ts
 * @direct-test-of packages/core/src/product-door/questions-tool.ts
 * @direct-test-of packages/core/src/product-door/releases-tool.ts
 * @direct-test-of packages/core/src/product-door/context.ts
 * @direct-test-of packages/core/src/mcp/feedback-tool.ts
 * @direct-test-of packages/core/src/permissions/declared.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, patToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

type Json = Record<string, unknown>;
type Answer = { isError: boolean; text: string; json: Json };

let projectId: string;
let projectSlug: string;
let ownerId: string;
const tokens = { owner: '', member: '', viewer: '', outsider: '' };

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  ownerId = (await createTestUser({ verified: true })).id;
  const project = await createTestProject(ownerId);
  projectId = project.id;
  projectSlug = project.slug;
  tokens.owner = await patToken(ownerId, [projectId], 'decl-owner');
  const memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  tokens.member = await patToken(memberId, [projectId], 'decl-member');
  const viewerId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, viewerId, 'viewer');
  tokens.viewer = await patToken(viewerId, [projectId], 'decl-viewer');
  const outsiderId = (await createTestUser({ verified: true })).id;
  tokens.outsider = await patToken(outsiderId, [projectId], 'decl-outsider');
});

async function mcp(
  who: keyof typeof tokens,
  name: string,
  args: Json,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const res = await api(
    tokens[who],
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream', ...headers },
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
const codeOf = (a: Answer) => {
  expect(a.isError, a.text).toBe(true);
  return (a.json.error as { code?: string } | undefined)?.code ?? a.text;
};

describe('forge_bindings and forge_config (declared in part 11)', () => {
  it('refuses a member forge_bindings write at the door, before its missing binding is named', async () => {
    const refused = await mcp('member', 'forge_bindings', { action: 'write', projectId });
    expect(codeOf(refused)).toBe('PERMISSION_FORBIDDEN');
    expect(refused.text).toContain('project.admin');
  });

  it('lets a project admin through the door, to the handler naming the missing binding', async () => {
    const reached = await mcp('owner', 'forge_bindings', { action: 'write', projectId });
    expect(codeOf(reached)).not.toBe('PERMISSION_FORBIDDEN');
    expect(reached.text).toContain('binding');
  });

  it('reads the project document for a viewer, who holds project.read', async () => {
    const read = ok(await mcp('viewer', 'forge_config', { action: 'get', projectId }));
    expect(read).toHaveProperty('declared');
  });
});

describe('forge_questions ask', () => {
  it('refuses a viewer at the door, before the issue key is looked up', async () => {
    const refused = await mcp('viewer', 'forge_questions', {
      action: 'ask',
      projectId,
      issue: 'ISS-9999',
      body: 'Which locale does the receipt use?',
    });
    expect(codeOf(refused)).toBe('PERMISSION_FORBIDDEN');
    expect(refused.text).toContain('project.write');
  });

  it('lets a member ask on an issue of the project', async () => {
    const issue = await createTestIssue(projectId, ownerId, 1, {
      status: 'open',
      createdAt: new Date(),
    });
    const asked = ok(
      await mcp('member', 'forge_questions', {
        action: 'ask',
        projectId,
        issue: issue.key,
        body: 'Which locale does the receipt use?',
      }),
    );
    expect(asked.act).toBe('asked');
  });
});

describe('forge_releases name', () => {
  it('refuses a member at the door, before the missing summary is named', async () => {
    const refused = await mcp('member', 'forge_releases', {
      action: 'name',
      projectId,
      version: '0.1.0',
      name: 'Faster checkout',
    });
    expect(codeOf(refused)).toBe('PERMISSION_FORBIDDEN');
    expect(refused.text).toContain('project.admin');
  });

  it('lets a project admin through the door, to the handler naming the missing summary', async () => {
    const reached = await mcp('owner', 'forge_releases', {
      action: 'name',
      projectId,
      version: '0.1.0',
      name: 'Faster checkout',
    });
    expect(codeOf(reached)).not.toBe('PERMISSION_FORBIDDEN');
    expect(reached.text).toContain('summary');
  });
});

describe('forge_releases list (readAccess, product-door/context.ts)', () => {
  it('refuses a caller holding no role on the project, naming project.read', async () => {
    const refused = await mcp('outsider', 'forge_releases', { action: 'list', projectId });
    expect(codeOf(refused)).toContain('not a member of this project');
    expect(refused.text).toContain('project.read');
  });

  it('lists the releases for a viewer, whose access readAccess loads and checks', async () => {
    const read = ok(await mcp('viewer', 'forge_releases', { action: 'list', projectId }));
    expect(read).toHaveProperty('releases');
    expect(read).toHaveProperty('draft');
  });
});

describe('project_feedback (declared on the project the handler resolves)', () => {
  const report = {
    action: 'submit',
    kind: 'bug',
    title: 'The receipt total is wrong',
    screen: '/checkout',
  };

  const bySlug = () => ({ 'x-forge-project-slug': projectSlug });

  it("refuses a viewer's submit on the slug header's project, naming project.write", async () => {
    const refused = await mcp('viewer', 'project_feedback', report, bySlug());
    expect(codeOf(refused)).toBe('PERMISSION_FORBIDDEN');
    expect(refused.text).toContain('project.write');
  });

  it("files a member's submit on the slug header's project, with no projectId sent", async () => {
    const filed = ok(await mcp('member', 'project_feedback', report, bySlug()));
    expect((filed.feedback as Json).key).toMatch(/^FB-\d+$/);
  });

  it('refuses a caller holding no role a list, naming project.read', async () => {
    const refused = await mcp('outsider', 'project_feedback', { action: 'list', projectId });
    expect(codeOf(refused)).toContain('not a member of this project');
    expect(refused.text).toContain('project.read');
  });
});
