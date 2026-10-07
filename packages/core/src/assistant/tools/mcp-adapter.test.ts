import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ContextScopedMcpToolFactory, McpContext } from '../../lib/tool.js';
import { zodToMcpSchema } from '../../lib/tool.js';
import { CHAT_READ_MODEL_TOOLS } from '../../mcp/chat-read-tools.js';
import { buildToolset } from './mcp-adapter.js';

// A chat turn is bound to one project: the adapter hides `projectId` from the model and pins the
// session's onto every call, reading the schema's top-level properties. forge_requirements and
// forge_releases first shipped as zod unions (top-level oneOf, no properties), so the model was shown
// a uuid to guess, omitted or guessed it, and 6 of the 9 forge_requirements calls in the journey-understand replay were refused.

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ctx = {
  principal: {
    kind: 'pat',
    agency: 'human',
    userId: 'u1',
    tokenId: 't1',
    scopes: [],
    projectIds: [PROJECT],
    boundProjectId: PROJECT,
    permissions: ['*'],
    grantEpoch: 1,
    deviceId: null,
    agentUserId: null,
  },
  boundProjectId: PROJECT,
} as unknown as McpContext;

describe('the chat adapter over a project-bound turn', () => {
  it('shows the model no projectId on any read-model tool, so none is guessed', () => {
    const { tools } = buildToolset(ctx, [...CHAT_READ_MODEL_TOOLS]);
    for (const t of tools) {
      expect(JSON.stringify(t.function.parameters), t.function.name).not.toContain('"projectId"');
      expect(t.function.parameters, t.function.name).toHaveProperty('type', 'object');
    }
  });

  it('pins the project and refuses a field the action does not take by name', async () => {
    const { execute } = buildToolset(ctx, [...CHAT_READ_MODEL_TOOLS]);
    const get = await execute('forge_requirements', JSON.stringify({ action: 'get' }));
    expect(get.isError).toBe(true);
    expect(JSON.stringify(get.content)).toContain('reads one requirement: name it, e.g. REQ-12');
    expect(JSON.stringify(get.content)).not.toContain('projectId');
    const list = await execute(
      'forge_releases',
      JSON.stringify({ action: 'list', version: '0.3.0' }),
    );
    expect(JSON.stringify(list.content)).toContain('takes no `version`; use action');
  });

  it('refuses a tool whose input is a union, naming it, instead of offering a projectId to guess', () => {
    const union: ContextScopedMcpToolFactory = () => ({
      name: 'forge_union_probe',
      reach: 'project',
      route: '/api/projects',
      grant: 'projects:read',
      description: 'probe',
      inputSchema: zodToMcpSchema(
        z.discriminatedUnion('action', [
          z.strictObject({ action: z.literal('list'), projectId: z.uuid() }),
          z.strictObject({ action: z.literal('get'), projectId: z.uuid(), key: z.string() }),
        ]),
      ),
      handler: async () => ({}),
    });
    expect(() => buildToolset(ctx, [{ factory: union }])).toThrow(
      /chat tool "forge_union_probe" declares its input as a union \(oneOf/,
    );
  });
});
