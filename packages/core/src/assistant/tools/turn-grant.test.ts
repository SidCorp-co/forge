import { describe, expect, it, vi } from 'vitest';

const runForgeCli = vi.fn(async () => ({ stdout: 'ran', stderr: '', code: 0 }));
vi.mock('./forge-cli.js', () => ({ runForgeCli: (...a: unknown[]) => runForgeCli(...(a as [])) }));

const { buildToolset } = await import('./mcp-adapter.js');
const { forgeCliTool } = await import('./forge-cli-tool.js');

const handler = vi.fn(async () => ({ ok: true }));
const readTool = () => ({
  name: 'forge_read_thing',
  description: 'reads a thing',
  inputSchema: { type: 'object', properties: {} },
  grant: 'knowledge:read' as const,
  handler,
});

function ctx(grant: readonly string[] | null) {
  return {
    principal: { permissions: ['knowledge:read'] } as never,
    projectSlug: 'demo',
    boundProjectId: 'proj-1',
    turnToken: 'forge_pat_dev_turn',
    grant,
  };
}

const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((b) => b.text ?? '').join('');

describe('a chat tool whose declared grant the person does not hold', () => {
  it('is refused by name, naming what it needs, and its handler never runs', async () => {
    handler.mockClear();
    const set = buildToolset(ctx(['issues:read']), [{ factory: readTool }]);
    const out = await set.execute('forge_read_thing', '{}');
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("needs 'knowledge:read'");
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs where the grant covers it', async () => {
    handler.mockClear();
    const set = buildToolset(ctx(['knowledge:read']), [{ factory: readTool }]);
    const out = await set.execute('forge_read_thing', '{}');
    expect(out.isError).toBeFalsy();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('runs for a browser-session sender, whose role is the whole bound', async () => {
    handler.mockClear();
    const set = buildToolset(ctx(null), [{ factory: readTool }]);
    expect((await set.execute('forge_read_thing', '{}')).isError).toBeFalsy();
  });

  it('is refused when the tool is built without a declaration', () => {
    const undeclared = () => ({ ...readTool(), grant: undefined as never });
    expect(() => buildToolset(ctx(null), [{ factory: undeclared }])).toThrow(
      /forge_read_thing is not registered: it declares no `grant`/,
    );
  });
});

describe('the forge CLI in a turn bounded by a named grant', () => {
  const call = (grant: readonly string[] | null) =>
    forgeCliTool(ctx(grant) as never).handler({ argv: ['issue', '--search', 'x'] });

  it('runs under the turn token, whose own grant the door it reaches reads', async () => {
    runForgeCli.mockClear();
    await call(['issues:read', 'assistant:write']);
    await call(['*']);
    await call(null);
    expect(runForgeCli).toHaveBeenCalledTimes(3);
    expect(runForgeCli).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'forge_pat_dev_turn' }),
    );
  });
});
