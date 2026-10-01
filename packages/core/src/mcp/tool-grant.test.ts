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

const {
  assertToolDeclaresGrant,
  assertToolDeclaresReach,
  permissionEpoch,
  toolAccountWork,
  toolEpochRefusal,
  toolGrantRefusal,
} = await import('./tool-grant.js');
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
    for (const tool of tools) {
      expect(() => assertToolDeclaresGrant(tool)).not.toThrow();
      expect(() => assertToolDeclaresReach(tool)).not.toThrow();
    }
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

describe('declaring where a tool reaches', () => {
  const issues = { ...issuesTool, reach: 'project' as const };

  it('refuses one that declares no reach, naming it', () => {
    expect(() => assertToolDeclaresReach(issuesTool)).toThrow(
      /forge_issues_like is not registered: it declares no `reach`/,
    );
  });

  it('refuses a project reach on a grant that resolves no project', () => {
    expect(() =>
      assertToolDeclaresReach({ name: 'o', inputSchema: {}, grant: 'orgs:read', reach: 'project' }),
    ).toThrow(/granted 'orgs:read', which resolves no project/);
  });

  it('refuses a public reach beside a grant that names a permission', () => {
    expect(() => assertToolDeclaresReach({ ...issues, reach: 'public' as const })).toThrow(
      /'public' is the reach of a call that needs no grant/,
    );
  });

  it('refuses an account reach naming no work, and a per-action table off the schema', () => {
    expect(() => assertToolDeclaresReach({ ...issues, reach: { account: ' ' } })).toThrow(
      /names no work/,
    );
    expect(() =>
      assertToolDeclaresReach({ ...issues, reach: { byAction: { list: 'project' } } }),
    ).toThrow(/actions create declare no reach/);
  });

  it('names the account work a call does, and none for a project call', () => {
    const guide = {
      name: 'g',
      inputSchema: withActions(['get', 'upsert']),
      grant: { byAction: { get: { none: 'public' }, upsert: 'orgs:write' } } as const,
      reach: { byAction: { get: 'public', upsert: { account: 'writing an org guide' } } } as const,
    };
    expect(() => assertToolDeclaresReach(guide)).not.toThrow();
    expect(toolAccountWork(guide, { action: 'upsert' })).toBe(
      "g action 'upsert', writing an org guide,",
    );
    expect(toolAccountWork(guide, { action: 'get' })).toBeNull();
    expect(toolAccountWork(issues, { action: 'create' })).toBeNull();
  });

  it('declares every account-only grant on the server as account reach', () => {
    const tools = mcpTools({ principal: { userId: 'u1' }, deprecations: new Set() } as never);
    const account = tools
      .filter((t) => JSON.stringify(t.reach).includes('"account"'))
      .map((t) => t.name)
      .sort();
    expect(account).toEqual([
      'forge_guide',
      'forge_orgs.list',
      'forge_orgs.members',
      'forge_projects.create',
    ]);
  });
});

describe('a call against the epoch its token was minted at', () => {
  const runners = {
    name: 'forge_runners_like',
    inputSchema: withActions(['list']),
    grant: { byAction: { list: 'runners:read' } } as const,
  };

  it('dates each grant by when its resource joined the menu', () => {
    expect(permissionEpoch('issues:write')).toBe(1);
    expect(permissionEpoch('runners:read')).toBe(2);
    expect(permissionEpoch('ecosystems:read')).toBe(3);
  });

  it('refuses a tool whose grant joined after the token, by name', () => {
    expect(toolEpochRefusal(runners, { action: 'list' }, 1)).toMatch(
      /^FORBIDDEN: PAT_GRANT_PREDATES_ROUTE: forge_runners_like action 'list' needs 'runners:read', which joined the menu at grant epoch 2, after this token was minted \(epoch 1\)/,
    );
  });

  it('passes the same tool at the epoch it joined, and a grant older than the token', () => {
    expect(toolEpochRefusal(runners, { action: 'list' }, 2)).toBeNull();
    expect(toolEpochRefusal(issuesTool, { action: 'create' }, 1)).toBeNull();
  });

  it('passes a `none` declaration and leaves an undeclared action to the grant check', () => {
    expect(
      toolEpochRefusal({ name: 'h', inputSchema: {}, grant: { none: 'public' } }, {}, 1),
    ).toBeNull();
    expect(toolEpochRefusal(runners, { action: 'purge' }, 1)).toBeNull();
  });
});
