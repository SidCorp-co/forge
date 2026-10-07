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
// Made one object with an `action`, the model then filled the field the other act takes
// (`version: "x"` on a list, `requirement: "REQ-1"` on a list) and was refused 4 times in 18 asks,
// so each read is its own tool and takes only its own fields.

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

  it('offers each read as its own tool, taking only its own fields, never an action', () => {
    const { tools } = buildToolset(ctx, [...CHAT_READ_MODEL_TOOLS]);
    const fields = Object.fromEntries(
      tools.map((t) => [
        t.function.name,
        Object.keys((t.function.parameters as { properties?: object }).properties ?? {}).sort(),
      ]),
    );
    for (const [name, keys] of Object.entries(fields)) expect(keys, name).not.toContain('action');
    expect(fields.forge_requirements).toEqual([]);
    expect(fields.forge_requirement).toEqual(['requirement']);
    expect(fields.forge_releases).toEqual(['limit', 'state']);
    expect(fields.forge_release).toEqual(['version']);
  });

  it('offers each read its whole description, none cut at the cap', () => {
    for (const t of buildToolset(ctx, [...CHAT_READ_MODEL_TOOLS]).tools)
      expect(t.function.description, t.function.name).not.toContain('[truncated]');
  });

  it('pins the project and refuses a read missing what it reads, by name', async () => {
    const { execute } = buildToolset(ctx, [...CHAT_READ_MODEL_TOOLS]);
    const get = await execute('forge_requirement', JSON.stringify({ requirement: 'twelve' }));
    expect(get.isError).toBe(true);
    expect(JSON.stringify(get.content)).toContain('a requirement is named by its key, REQ-n');
    expect(JSON.stringify(get.content)).not.toContain('projectId');
    const release = await execute('forge_release', '{}');
    expect(release.isError).toBe(true);
    expect(JSON.stringify(release.content)).toContain('version');
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
