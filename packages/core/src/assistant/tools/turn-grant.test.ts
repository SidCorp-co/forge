// ISS-17 — a chat turn's tools are bounded by the grant the person reached Forge with. The
// adapter refuses a tool whose REST equivalent the grant does not cover before its handler runs,
// and the `forge` CLI, whose verbs reach /mcp where no grant is read, is refused outright to a
// person bounded by a named grant.

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

describe('a chat tool whose REST equivalent the grant does not cover', () => {
  it('is refused by name, naming what it needs, and its handler never runs', async () => {
    handler.mockClear();
    const set = buildToolset(ctx(['issues:read']), [
      { factory: readTool, grant: 'knowledge:read' },
    ]);
    const out = await set.execute('forge_read_thing', '{}');
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("needs 'knowledge:read'");
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs where the grant covers it', async () => {
    handler.mockClear();
    const set = buildToolset(ctx(['knowledge:read']), [
      { factory: readTool, grant: 'knowledge:read' },
    ]);
    const out = await set.execute('forge_read_thing', '{}');
    expect(out.isError).toBeFalsy();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('runs for a browser-session sender, whose role is the whole bound', async () => {
    handler.mockClear();
    const set = buildToolset(ctx(null), [{ factory: readTool, grant: 'knowledge:read' }]);
    expect((await set.execute('forge_read_thing', '{}')).isError).toBeFalsy();
  });
});

describe('the forge CLI in a turn bounded by a named grant', () => {
  const call = (grant: readonly string[] | null) =>
    forgeCliTool(ctx(grant) as never).handler({ argv: ['issue', '--search', 'x'] });

  it('is refused by name, and no child process is started', async () => {
    runForgeCli.mockClear();
    const out = (await call(['issues:read', 'assistant:write'])) as { stderr: string };
    expect(out.stderr).toMatch(/FORBIDDEN: .*granted only issues:read, assistant:write/);
    expect(runForgeCli).not.toHaveBeenCalled();
  });

  it('runs, under the turn token, for a sender granted everything or signed in', async () => {
    runForgeCli.mockClear();
    await call(['*']);
    await call(null);
    expect(runForgeCli).toHaveBeenCalledTimes(2);
    expect(runForgeCli).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'forge_pat_dev_turn' }),
    );
  });
});
