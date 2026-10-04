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
  reach: 'project' as const,
  route: '/api/knowledge' as const,
  grant: 'knowledge:read' as const,
  handler,
});

function ctx(
  grant: readonly string[] | null,
  bound: { fence?: readonly string[] | null; grantEpoch?: number } = {},
) {
  return {
    principal: {
      kind: 'pat',
      tokenId: 'turn-token',
      permissions: ['knowledge:read'],
      boundProjectId: 'proj-1',
      projectIds: ['proj-1'],
      grantEpoch: bound.grantEpoch ?? 2,
    } as never,
    projectSlug: 'demo',
    boundProjectId: 'proj-1',
    turnToken: 'forge_pat_dev_turn',
    grant,
    fence: bound.fence === undefined ? null : bound.fence,
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

describe('a chat tool against the epoch and the fence of the credential the person reached Forge with', () => {
  const sessionsTool = () => ({
    ...readTool(),
    name: 'forge_sessions_thing',
    route: '/api/agent-sessions' as const,
    grant: 'pipeline:read' as const,
  });
  const accountTool = () => ({
    ...readTool(),
    name: 'forge_account_thing',
    reach: { account: "setting the person's own preferences" },
    route: '/api/auth/preferences' as const,
    grant: 'account:write' as const,
  });

  it('refuses a tool whose route joined after the token was minted, as /mcp and REST do', async () => {
    handler.mockClear();
    const set = buildToolset(ctx(['*'], { grantEpoch: 1 }), [{ factory: sessionsTool }]);
    const out = await set.execute('forge_sessions_thing', '{}');
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(
      /PAT_GRANT_PREDATES_ROUTE: forge_sessions_thing is served at \/api\/agent-sessions, and \/api\/agent-sessions joined 'pipeline' at grant epoch 2/,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the same tool for a token minted at the epoch its route joined', async () => {
    handler.mockClear();
    const set = buildToolset(ctx(['*'], { grantEpoch: 2 }), [{ factory: sessionsTool }]);
    expect((await set.execute('forge_sessions_thing', '{}')).isError).toBeFalsy();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('refuses account work to a person whose own credential is fenced to projects', async () => {
    handler.mockClear();
    const set = buildToolset(ctx(['*'], { fence: ['proj-1'] }), [{ factory: accountTool }]);
    const out = await set.execute('forge_account_thing', '{}');
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('PAT_ACCOUNT_ROUTE');
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs account work for a person whose credential has no project list, though the turn token has one', async () => {
    handler.mockClear();
    const set = buildToolset(ctx(null, { fence: null }), [{ factory: accountTool }]);
    expect((await set.execute('forge_account_thing', '{}')).isError).toBeFalsy();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("reads the turn token's own fence where no person's fence was handed", async () => {
    handler.mockClear();
    const { fence: _drop, ...unbounded } = ctx(['*']);
    const set = buildToolset(unbounded, [{ factory: accountTool }]);
    expect(text(await set.execute('forge_account_thing', '{}'))).toContain('PAT_ACCOUNT_ROUTE');
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses to build a tool that declares no reach or no route', () => {
    const noReach = () => ({ ...readTool(), reach: undefined as never });
    expect(() => buildToolset(ctx(null), [{ factory: noReach }])).toThrow(
      /forge_read_thing is not registered: it declares no `reach`/,
    );
    const noRoute = () => {
      const { route: _route, ...tool } = readTool();
      return tool;
    };
    expect(() => buildToolset(ctx(null), [{ factory: noRoute }])).toThrow(
      /forge_read_thing is not registered: it declares no `route`/,
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
