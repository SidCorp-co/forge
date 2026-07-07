import { describe, expect, it } from 'vitest';
import type { McpTool } from '../../mcp/tools/forge-version.js';
import type { McpContext } from '../../mcp/tools/lib.js';
import { guardIssueWrites } from './guards.js';
import { buildToolset, mergeToolsets } from './mcp-adapter.js';

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
        allowedActions: ['list', 'get'],
      },
    ]);
    const out = await execute('forge_issues', '{"action":"create"}');
    expect(called).toBe(false);
    expect(JSON.parse(out).error).toMatch(/not permitted/);
  });

  it('allows a whitelisted read action', async () => {
    const { execute } = buildToolset(ctx, [
      { factory: () => stubTool('forge_issues', () => ({ items: [] })), allowedActions: ['list'] },
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

  it('pins projectId to the session-bound project, overriding what the model passed', async () => {
    const boundCtx = { boundProjectId: 'bound-proj-uuid' } as unknown as McpContext;
    let received: Record<string, unknown> | null = null;
    const withProjectId: McpTool = {
      name: 'forge_issues',
      description: 'stub',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string' }, projectId: { type: 'string' } },
      },
      handler: async (a) => {
        received = a;
        return { ok: true };
      },
    };
    const { execute } = buildToolset(boundCtx, [
      { factory: () => withProjectId, allowedActions: ['list'] },
    ]);
    // Model passes a bogus projectId — the adapter must overwrite it.
    await execute('forge_issues', '{"action":"list","projectId":"Some Project Name"}');
    expect(received).toEqual({ action: 'list', projectId: 'bound-proj-uuid' });
  });

  it('hides projectId from the advertised schema when it pins it server-side', () => {
    const boundCtx = { boundProjectId: 'bound-proj-uuid' } as unknown as McpContext;
    const withProjectId: McpTool = {
      name: 'forge_issues',
      description: 'stub',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string' }, projectId: { type: 'string' } },
        required: ['action', 'projectId'],
      },
      handler: async () => ({}),
    };
    const { tools } = buildToolset(boundCtx, [
      { factory: () => withProjectId, allowedActions: ['list'] },
    ]);
    const params = tools[0]?.function.parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect('projectId' in params.properties).toBe(false);
    expect(params.required).toEqual(['action']);
  });

  it('does not inject projectId into tools whose schema lacks it', async () => {
    const boundCtx = { boundProjectId: 'bound-proj-uuid' } as unknown as McpContext;
    let received: Record<string, unknown> | null = null;
    const { execute } = buildToolset(boundCtx, [
      {
        factory: () =>
          stubTool('forge_comments', (a) => {
            received = a;
            return { ok: true };
          }),
        allowedActions: ['list'],
      },
    ]);
    await execute('forge_comments', '{"action":"list"}');
    expect(received).toEqual({ action: 'list' });
  });

  // === ISS-609 — guard hook + toolset composition ===

  it('guard can normalize args before dispatch (draft-first create)', async () => {
    let received: Record<string, unknown> | null = null;
    const { execute } = buildToolset(ctx, [
      {
        factory: () =>
          stubTool('forge_issues', (a) => {
            received = a;
            return { ok: true };
          }),
        allowedActions: ['create'],
        guard: guardIssueWrites,
      },
    ]);
    const data = {
      title: '[Bug] Category path renders too long on listings',
      status: 'open',
      description: `Source: https://hub.example.co/tasks?projectId=53&task=12608 and https://chat.example.co/group/x?msg=1. ${'The category breadcrumb concatenates every ancestor level so listing titles overflow. '.repeat(3)}Acceptance: only the leaf category is used.`,
    };
    await execute('forge_issues', JSON.stringify({ action: 'create', data }));
    expect((received as unknown as { data: { status: string } }).data.status).toBe('draft');
  });

  it('guard rejects a hollow issue create (kernel quality floor)', async () => {
    let called = false;
    const { execute } = buildToolset(ctx, [
      {
        factory: () =>
          stubTool('forge_issues', () => {
            called = true;
            return { ok: true };
          }),
        allowedActions: ['create'],
        guard: guardIssueWrites,
      },
    ]);
    const out = await execute(
      'forge_issues',
      '{"action":"create","data":{"title":"Fix category","description":"Category too long, use the last one."}}',
    );
    expect(called).toBe(false);
    expect(JSON.parse(out).error).toMatch(/too thin to be actionable/);
  });

  it('guard rejects any pipeline-dispatching status on update', async () => {
    let called = false;
    const { execute } = buildToolset(ctx, [
      {
        factory: () =>
          stubTool('forge_issues', () => {
            called = true;
            return { ok: true };
          }),
        allowedActions: ['update'],
        guard: guardIssueWrites,
      },
    ]);
    // Every registry status dispatches a job on transition — all must bounce.
    for (const status of ['open', 'approved', 'released', 'testing', 'in_progress', 'tested']) {
      const out = await execute(
        'forge_issues',
        `{"action":"update","data":{"status":"${status}"}}`,
      );
      expect(called).toBe(false);
      expect(JSON.parse(out).error).toMatch(/leave that transition to a human/);
    }
  });

  it('guard allows the non-dispatching statuses and status-less updates', async () => {
    const received: Array<Record<string, unknown>> = [];
    const { execute } = buildToolset(ctx, [
      {
        factory: () =>
          stubTool('forge_issues', (a) => {
            received.push(a);
            return { ok: true };
          }),
        allowedActions: ['update'],
        guard: guardIssueWrites,
      },
    ]);
    for (const status of ['draft', 'waiting', 'needs_info', 'on_hold', 'closed']) {
      const out = await execute(
        'forge_issues',
        `{"action":"update","data":{"status":"${status}"}}`,
      );
      expect(JSON.parse(out)).toEqual({ ok: true });
    }
    const out = await execute('forge_issues', '{"action":"update","data":{"title":"renamed"}}');
    expect(JSON.parse(out)).toEqual({ ok: true });
    expect(received).toHaveLength(6);
  });

  it("guard rejects the 'unblock' operator escape hatch", async () => {
    let called = false;
    const { execute } = buildToolset(ctx, [
      {
        factory: () =>
          stubTool('forge_issues', () => {
            called = true;
            return { ok: true };
          }),
        allowedActions: ['update'],
        guard: guardIssueWrites,
      },
    ]);
    const out = await execute(
      'forge_issues',
      '{"action":"update","data":{"status":"draft","unblock":true}}',
    );
    expect(called).toBe(false);
    expect(JSON.parse(out).error).toMatch(/unblock/);
  });

  it('mergeToolsets routes by name, first owner wins', async () => {
    const a = buildToolset(ctx, [{ factory: () => stubTool('alpha', () => ({ from: 'a' })) }]);
    const b = buildToolset(ctx, [
      { factory: () => stubTool('alpha', () => ({ from: 'b-shadowed' })) },
      { factory: () => stubTool('beta', () => ({ from: 'b' })) },
    ]);
    const merged = mergeToolsets(a, b);
    expect(merged.tools.map((t) => t.function.name)).toEqual(['alpha', 'beta']);
    expect(JSON.parse(await merged.execute('alpha', '{}'))).toEqual({ from: 'a' });
    expect(JSON.parse(await merged.execute('beta', '{}'))).toEqual({ from: 'b' });
    expect(JSON.parse(await merged.execute('gamma', '{}')).error).toMatch(/unknown tool/);
  });
});
