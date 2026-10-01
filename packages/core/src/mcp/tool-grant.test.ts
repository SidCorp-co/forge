import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    APP_BASE_URL: 'https://forge.test',
    UPLOADS_MAX_BYTES: 1,
    UPLOADS_INLINE_MAX_BYTES: 1,
    FEEDBACK_MAX_PER_JOB: 1,
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { assertToolDeclaresGrant, toolGrantRefusal } = await import('./tool-grant.js');
const { mcpTools } = await import('./server.js');
const { REGISTERED_TOOLS } = await import('./registered-tools.js');

const withActions = (actions: string[]) => ({
  type: 'object',
  properties: { action: { type: 'string', enum: actions } },
});

const issuesTool = {
  name: 'forge_issues_like',
  inputSchema: withActions(['list', 'create']),
  grant: { byAction: { list: 'issues:read', create: 'issues:write' } } as const,
};

describe('registering a tool', () => {
  it('refuses one that declares no grant, naming it', () => {
    expect(() => assertToolDeclaresGrant({ name: 'forge_bare', inputSchema: {} })).toThrow(
      /forge_bare is not registered: it declares no `grant`/,
    );
  });

  it('refuses a per-action table missing an action the schema takes', () => {
    expect(() =>
      assertToolDeclaresGrant({
        ...issuesTool,
        inputSchema: withActions(['list', 'create', 'purge']),
      }),
    ).toThrow(/actions purge declare no grant/);
  });

  it('refuses a per-action table naming an action the schema does not take', () => {
    expect(() =>
      assertToolDeclaresGrant({ ...issuesTool, inputSchema: withActions(['list']) }),
    ).toThrow(/declares a grant for create, which it does not take/);
  });

  it('refuses a name off the menu, and a `none` with no reason', () => {
    expect(() =>
      assertToolDeclaresGrant({ name: 't', inputSchema: {}, grant: 'issues:admin' as never }),
    ).toThrow(/'issues:admin' is not a permission on the menu/);
    expect(() =>
      assertToolDeclaresGrant({ name: 't', inputSchema: {}, grant: { none: ' ' } }),
    ).toThrow(/carries no reason/);
  });

  it('holds for every tool the server registers, and the list matches what it serves', () => {
    const tools = mcpTools({ principal: { userId: 'u1' }, deprecations: new Set() } as never);
    for (const tool of tools) expect(() => assertToolDeclaresGrant(tool)).not.toThrow();
    expect(tools.map((t) => t.name).sort()).toEqual([...REGISTERED_TOOLS].sort());
  });
});

describe('a call against the grant it carries', () => {
  it('refuses an issue write on an issues:read grant, by name', () => {
    expect(toolGrantRefusal(issuesTool, { action: 'create' }, ['issues:read'])).toMatch(
      /^FORBIDDEN: forge_issues_like action 'create' needs 'issues:write', and this token was not granted it \(it holds: issues:read\)/,
    );
  });

  it('passes a read action on a read grant', () => {
    expect(toolGrantRefusal(issuesTool, { action: 'list' }, ['issues:read'])).toBeNull();
  });

  it('refuses a grant for another resource', () => {
    expect(toolGrantRefusal(issuesTool, { action: 'list' }, ['knowledge:read'])).toMatch(
      /needs 'issues:read'/,
    );
  });

  it('passes every action for a whole-reach grant: stated `*`, null, and the legacy empty list', () => {
    for (const granted of [['*'], null, []]) {
      expect(toolGrantRefusal(issuesTool, { action: 'create' }, granted)).toBeNull();
    }
  });

  it('refuses an action the table does not declare, even on a whole-reach grant', () => {
    expect(toolGrantRefusal(issuesTool, { action: 'purge' }, ['*'])).toMatch(
      /action 'purge' declares no grant, so it is refused/,
    );
    expect(toolGrantRefusal(issuesTool, {}, ['*'])).toMatch(
      /a call naming no action declares no grant/,
    );
    expect(toolGrantRefusal(issuesTool, { action: 'constructor' }, ['*'])).toMatch(
      /action 'constructor' declares no grant/,
    );
  });

  it('reads a call naming no action as the declared default', () => {
    const config = {
      name: 'forge_config_like',
      inputSchema: withActions(['get', 'update']),
      grant: {
        byAction: { get: 'projects:read', update: 'projects:write' },
        defaultAction: 'get',
      } as const,
    };
    expect(toolGrantRefusal(config, {}, ['projects:read'])).toBeNull();
    expect(toolGrantRefusal(config, { action: 'update' }, ['projects:read'])).toMatch(
      /needs 'projects:write'/,
    );
  });

  it('passes a `none` declaration on any grant', () => {
    const health = { name: 'h', inputSchema: {}, grant: { none: 'public' } };
    expect(toolGrantRefusal(health, {}, ['issues:read'])).toBeNull();
  });
});
