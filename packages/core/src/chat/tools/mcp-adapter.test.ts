import { describe, expect, it } from 'vitest';
import type { McpTool } from '../../mcp/tools/forge-version.js';
import type { McpContext } from '../../mcp/tools/lib.js';
import { buildToolset } from './mcp-adapter.js';

// Minimal stub context — the read-only gate rejects before any handler runs,
// and tools[] building only reads the descriptor, so no DB/principal is hit.
const ctx = {} as McpContext;

function stubTool(name: string, onCall: (a: Record<string, unknown>) => unknown): McpTool {
  return {
    name,
    description: 'stub',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } } },
    handler: async (a) => onCall(a),
  };
}

describe('chat mcp-adapter', () => {
  it('sanitizes dotted MCP names into OpenAI-safe function names', () => {
    const { tools } = buildToolset(ctx, [
      { factory: () => stubTool('forge_projects.get', () => ({})) },
    ]);
    expect(tools[0]?.function.name).toBe('forge_projects_get');
  });

  it('dispatches to the handler under the sanitized name', async () => {
    let received: Record<string, unknown> | null = null;
    const { execute } = buildToolset(ctx, [
      {
        factory: () =>
          stubTool('forge_projects.get', (a) => {
            received = a;
            return { ok: true };
          }),
      },
    ]);
    const out = await execute('forge_projects_get', '{"projectId":"p1"}');
    expect(JSON.parse(out)).toEqual({ ok: true });
    expect(received).toEqual({ projectId: 'p1' });
  });

  it('rejects a write action on a read-only tool before calling the handler', async () => {
    let called = false;
    const { execute } = buildToolset(ctx, [
      {
        factory: () =>
          stubTool('forge_issues', () => {
            called = true;
            return { ok: true };
          }),
        readActions: ['list', 'get'],
      },
    ]);
    const out = await execute('forge_issues', '{"action":"create"}');
    expect(called).toBe(false);
    expect(JSON.parse(out).error).toMatch(/not permitted/);
  });

  it('allows a whitelisted read action', async () => {
    const { execute } = buildToolset(ctx, [
      { factory: () => stubTool('forge_issues', () => ({ items: [] })), readActions: ['list'] },
    ]);
    const out = await execute('forge_issues', '{"action":"list"}');
    expect(JSON.parse(out)).toEqual({ items: [] });
  });

  it('returns a JSON error (not a throw) when the handler fails', async () => {
    const { execute } = buildToolset(ctx, [
      {
        factory: () =>
          stubTool('forge_projects.get', () => {
            throw new Error('boom');
          }),
      },
    ]);
    const out = await execute('forge_projects_get', '{}');
    expect(JSON.parse(out).error).toBe('boom');
  });
});
