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
  assertToolDeclaresAccess,
  assertToolDeclaresGrant,
  assertToolDeclaresReach,
  assertToolDeclaresRoute,
  toolAccountWork,
  toolEpochRefusal,
  toolGrantRefusal,
} = await import('./tool-grant.js');
const { patEpochRefusal } = await import('../auth/pat-permissions.js');
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
    for (const tool of tools) expect(() => assertToolDeclaresAccess(tool)).not.toThrow();
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
      'forge_ecosystem',
      'forge_guide',
      'forge_orgs.list',
      'forge_orgs.members',
      'forge_projects.create',
    ]);
  });
});

const unrouted = ({
  route: _route,
  ...tool
}: {
  route?: unknown;
  name: string;
  inputSchema: Record<string, unknown>;
  grant: 'pipeline:read';
}) => tool;

describe('declaring the route a tool is served at', () => {
  const sessions = {
    name: 'forge_sessions_like',
    inputSchema: {},
    grant: 'pipeline:read' as const,
    route: '/api/agent-sessions' as const,
  };

  it('refuses one that names a permission and declares no route, naming it', () => {
    expect(() => assertToolDeclaresRoute(unrouted(sessions))).toThrow(
      /forge_sessions_like is not registered: it declares no `route`/,
    );
  });

  it('refuses a route off the menu, and a path below a prefix', () => {
    expect(() => assertToolDeclaresRoute({ ...sessions, route: '/api/nowhere' as never })).toThrow(
      /route '\/api\/nowhere' is neither a prefix on the menu nor a nested surface it dates/,
    );
    expect(() =>
      assertToolDeclaresRoute({ ...sessions, route: '/api/agent-sessions/x' as never }),
    ).toThrow(/route '\/api\/agent-sessions\/x' is neither a prefix on the menu/);
  });

  it('takes a nested surface as a route, dated by the prefix whose rows it serves', () => {
    const timeseries = {
      name: 'forge_timeseries_like',
      inputSchema: {},
      grant: 'projects:read' as const,
      reach: 'project' as const,
      route: '/api/projects/:id/metrics/timeseries' as const,
    };
    expect(() => assertToolDeclaresRoute(timeseries)).not.toThrow();
    expect(toolEpochRefusal(timeseries, {}, 1)).toMatch(
      /PAT_GRANT_PREDATES_ROUTE: forge_timeseries_like is served at \/api\/projects\/:id\/metrics\/timeseries, and \/api\/projects\/:id\/metrics\/timeseries serves the rows of \/api\/usage-records/,
    );
    expect(toolEpochRefusal(timeseries, {}, 2)).toBeNull();
  });

  it("refuses a route under another resource than the tool's grant", () => {
    expect(() => assertToolDeclaresRoute({ ...sessions, route: '/api/projects' })).toThrow(
      /granted 'pipeline:read', and no route it declares is under 'pipeline'/,
    );
  });

  it('refuses two routes under one resource, and a route no grant names', () => {
    expect(() =>
      assertToolDeclaresRoute({ ...sessions, route: ['/api/agent-sessions', '/api/jobs'] }),
    ).toThrow(/routes '\/api\/agent-sessions' and '\/api\/jobs' are both under 'pipeline'/);
    expect(() =>
      assertToolDeclaresRoute({ ...sessions, route: ['/api/agent-sessions', '/api/issues'] }),
    ).toThrow(/route '\/api\/issues' is under 'issues', which none of its grants names/);
  });

  it('refuses a route on a tool that needs no grant', () => {
    expect(() =>
      assertToolDeclaresRoute({
        name: 'h',
        inputSchema: {},
        grant: { none: 'public' },
        route: '/api/issues',
      }),
    ).toThrow(/it needs no grant, so no `route` dates it/);
  });

  it('takes one route per resource across per-action grants', () => {
    const issues = {
      ...issuesTool,
      inputSchema: withActions(['list', 'create', 'listTasks']),
      grant: {
        byAction: { list: 'issues:read', create: 'issues:write', listTasks: 'tasks:read' },
      } as const,
      route: ['/api/issues', '/api/tasks'] as const,
    };
    expect(() => assertToolDeclaresRoute(issues)).not.toThrow();
    expect(() => assertToolDeclaresRoute({ ...issues, route: '/api/issues' })).toThrow(
      /granted 'tasks:read', and no route it declares is under 'tasks'/,
    );
  });
});

describe('a call against the epoch its token was minted at', () => {
  const sessions = {
    name: 'forge_sessions_like',
    inputSchema: {},
    grant: 'pipeline:read' as const,
    route: '/api/agent-sessions' as const,
  };
  const runs = { ...sessions, name: 'forge_runs_like', route: '/api/pipeline-runs' as const };
  const runners = {
    name: 'forge_runners_like',
    inputSchema: withActions(['list']),
    grant: { byAction: { list: 'runners:read' } } as const,
    route: '/api/runners' as const,
  };

  it("dates a tool by its route, not by its grant's oldest prefix", () => {
    expect(toolEpochRefusal(sessions, {}, 1)).toMatch(
      /^FORBIDDEN: PAT_GRANT_PREDATES_ROUTE: forge_sessions_like is served at \/api\/agent-sessions, and \/api\/agent-sessions joined 'pipeline' at grant epoch 2, after this token was minted \(epoch 1\)/,
    );
    expect(toolEpochRefusal(runs, {}, 1)).toBeNull();
  });

  it('answers with the message REST answers for the same route', () => {
    const rest = patEpochRefusal('/api/agent-sessions', 1);
    expect(rest?.message).toBeTruthy();
    expect(toolEpochRefusal(sessions, {}, 1)).toContain(rest?.message ?? '-');
    expect(patEpochRefusal('/api/agent-sessions/abc/cost', 1)?.prefix).toBe('/api/agent-sessions');
  });

  it('refuses a per-action grant by name, and reads a missing epoch as the first', () => {
    expect(toolEpochRefusal(runners, { action: 'list' }, 1)).toMatch(
      /^FORBIDDEN: PAT_GRANT_PREDATES_ROUTE: forge_runners_like action 'list' is served at \/api\/runners/,
    );
    expect(toolEpochRefusal(sessions, {}, undefined)).toMatch(/PAT_GRANT_PREDATES_ROUTE/);
  });

  it('passes the same tool at the epoch its route joined', () => {
    expect(toolEpochRefusal(sessions, {}, 2)).toBeNull();
    expect(toolEpochRefusal(runners, { action: 'list' }, 2)).toBeNull();
  });

  it('refuses a permission whose resource has no declared route, never letting it through', () => {
    expect(toolEpochRefusal(unrouted(sessions), {}, 99)).toMatch(
      /^FORBIDDEN: forge_sessions_like needs 'pipeline:read' and declares no route under its resource/,
    );
  });

  it('passes a `none` declaration and leaves an undeclared action to the grant check', () => {
    expect(
      toolEpochRefusal({ name: 'h', inputSchema: {}, grant: { none: 'public' } }, {}, 1),
    ).toBeNull();
    expect(toolEpochRefusal(runners, { action: 'purge' }, 1)).toBeNull();
  });

  it('refuses an epoch-1 token exactly the registered tools whose route joined later', () => {
    const tools = mcpTools({ principal: { userId: 'u1' }, deprecations: new Set() } as never);
    const refused: string[] = [];
    for (const tool of tools) {
      const actions = (tool.inputSchema.properties as { action?: { enum?: string[] } } | undefined)
        ?.action?.enum ?? [undefined];
      for (const action of actions) {
        const args = action === undefined ? {} : { action };
        if (toolEpochRefusal(tool, args, 1))
          refused.push(action ? `${tool.name} ${action}` : tool.name);
      }
    }
    expect(refused.sort()).toEqual(
      [
        'forge_agent_report get',
        'forge_agent_report list',
        'forge_agent_report submit',
        'forge_agent_report triage',
        'forge_agent_sessions.get',
        'forge_agent_sessions.list',
        'forge_automation fire',
        'forge_automation schedule',
        'forge_automation standing',
        'forge_ecosystem bus',
        'forge_feedback get',
        'forge_feedback list',
        'forge_feedback submit',
        'forge_feedback triage',
        'forge_guide delete',
        'forge_guide upsert',
        'forge_masters passes',
        'forge_masters standing',
        'forge_metrics.project_retry_rescues',
        'forge_metrics.project_step_durations',
        'forge_metrics.project_timeseries',
        'forge_metrics.session_failures',
        'forge_orgs.list',
        'forge_orgs.members',
        'forge_project_pm runner_load',
        'forge_runners list',
        'forge_runners register',
        'forge_runners restore',
        'forge_runners retire',
        'forge_runners update_capabilities',
      ].sort(),
    );
  });
});
