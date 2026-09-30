import { beforeEach, describe, expect, it, vi } from 'vitest';

const applyGrantedMcpServers = vi.fn(
  async (_projectId: string, _current: Record<string, unknown> | null) => ({
    map: null as Record<string, unknown> | null,
    produced: [] as { name: string; bindingId: string }[],
  }),
);
vi.mock('../integrations/mcp-resolver.js', () => ({ applyGrantedMcpServers }));

const { resolveJobMcpServers, resolveSessionMcpServers } = await import(
  './resolve-job-mcp-servers.js'
);

beforeEach(() => {
  applyGrantedMcpServers.mockClear();
});

describe('resolveJobMcpServers — the granted integrations are the only source', () => {
  it('carries exactly the servers the granted bindings produce', async () => {
    applyGrantedMcpServers.mockResolvedValueOnce({
      map: { sentry: { type: 'http', url: 'https://sentry.example/mcp' } },
      produced: [{ name: 'sentry', bindingId: 'b-1' }],
    });

    const out = await resolveJobMcpServers({ projectId: 'p-1' });

    expect(applyGrantedMcpServers).toHaveBeenCalledWith('p-1', null);
    expect(out).toEqual({
      mcpServers: { sentry: { type: 'http', url: 'https://sentry.example/mcp' } },
      resolvedNames: ['sentry'],
      droppedNames: [],
      integrationServers: [{ name: 'sentry', bindingId: 'b-1' }],
    });
  });

  it('answers a project with no grant with no servers and nothing dropped', async () => {
    const out = await resolveJobMcpServers({ projectId: 'p-1' });
    expect(out).toEqual({
      mcpServers: null,
      resolvedNames: [],
      droppedNames: [],
      integrationServers: [],
    });
  });
});

describe('resolveSessionMcpServers', () => {
  it('resolves a session exactly as a job of the same project', async () => {
    applyGrantedMcpServers.mockResolvedValue({
      map: { linear: { type: 'http', url: 'https://linear.example/mcp' } },
      produced: [{ name: 'linear', bindingId: 'b-2' }],
    });
    expect(await resolveSessionMcpServers('p-1')).toEqual(
      await resolveJobMcpServers({ projectId: 'p-1' }),
    );
  });
});
