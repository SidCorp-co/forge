import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RefusalError, thrownEnvelope } from '../lib/refusal.js';
import type { McpTool } from '../lib/tool.js';
import {
  byRule,
  instanceAdmin,
  onArg,
  onResolved,
  permissionless,
  renderedPermission,
} from '../middleware/declared-permission.js';

// REQ-12 BC-20 (ISS-824): a REST route and an MCP tool action are refused by the same declaration,
// through the one enforcer both doors run before the handler, never by a check in the handler.

const PROJECT = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-0000000000aa';

const access = vi.hoisted(() => ({
  role: 'viewer' as 'viewer' | 'member' | 'admin' | null,
  orgRole: 'member' as 'member' | 'admin' | 'owner' | null,
  seen: [] as string[],
}));

vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: async (projectId: string, userId: string | null) => {
    access.seen.push(`project ${projectId} as ${userId}`);
    return { projectId, role: access.role, grants: [] };
  },
  loadOrgRole: async (orgId: string, userId: string | null) => {
    access.seen.push(`org ${orgId} as ${userId}`);
    return access.orgRole;
  },
  effectiveProjectRole: async () => null,
}));

const admins = vi.hoisted(() => ({ list: [] as string[] }));

vi.mock('../middleware/require-admin.js', () => ({
  assertInstanceAdmin: async (userId: string | null) => {
    access.seen.push(`admin list as ${userId}`);
    if (userId === null || !admins.list.includes(userId)) {
      throw Object.assign(new Error('admin access required'), { status: 403, code: 'ADMIN_ONLY' });
    }
  },
}));

const {
  enforceDeclared,
  requireDeclared,
  requireDeclaredHeld,
  requireDeclaredOn,
  requiresByRule,
  requiresInstanceAdmin,
  requiresOnParam,
  requiresOnResolved,
  runDeclaredTool,
} = await import('./declared.js');

const WRITE = onArg('project.write');

function restApp(ran: string[]) {
  return new Hono<{ Variables: { userId: string } }>()
    .use('*', async (c, next) => {
      c.set('userId', 'u1');
      await next();
    })
    .post('/p/:projectId/thing', requiresOnParam('project.write'), (c) => {
      ran.push('rest');
      return c.text('ok');
    })
    .post('/o/:orgId/thing', requiresOnParam('org.admin', 'orgId'), (c) => {
      ran.push('org');
      return c.text('ok');
    })
    .post('/i/:id/thing', requiresOnResolved('project.write', "the issue's project"), (c) => {
      requireDeclared({ projectId: PROJECT, role: access.role, grants: [] });
      ran.push('resolved');
      return c.text('ok');
    })
    .post(
      '/p/:projectId/ruled',
      requiresByRule('probe/rule.ts:probeRule', 'the row decides', {
        permission: 'project.read',
        param: 'projectId',
      }),
      (c) => {
        ran.push('ruled');
        return c.text('ok');
      },
    )
    .post('/r/:id/ruled', requiresByRule('probe/rule.ts:probeRule', 'the row decides'), (c) => {
      ran.push('rule-only');
      return c.text('ok');
    })
    .get('/admin/thing', requiresInstanceAdmin('the whole instance'), (c) => {
      ran.push('admin');
      return c.text('ok');
    })
    .onError((err, c) => {
      const status =
        err instanceof RefusalError
          ? thrownEnvelope(err).status
          : ((err as { status?: number }).status ?? 500);
      const text = err instanceof RefusalError ? JSON.stringify(thrownEnvelope(err)) : err.message;
      return c.text(text, status as 403);
    });
}

function tool(ran: string[], permission: McpTool['permission']): McpTool {
  return {
    name: 'forge_probe',
    description: 'probe',
    inputSchema: { type: 'object' },
    grant: { none: 'probe' },
    reach: 'project',
    ...(permission ? { permission } : {}),
    handler: async (args) => {
      if (args.action === 'resolve')
        requireDeclared({ projectId: PROJECT, role: access.role, grants: [] });
      ran.push('mcp');
      return { ok: true };
    },
  };
}

beforeEach(() => {
  access.role = 'viewer';
  access.orgRole = 'member';
  access.seen = [];
  admins.list = [];
});

describe('one declaration, enforced the same at both doors before the handler', () => {
  it('refuses a viewer project.write over REST and over MCP, and runs neither handler', async () => {
    const ran: string[] = [];
    const rest = await restApp(ran).request(`/p/${PROJECT}/thing`, { method: 'POST' });
    expect(rest.status).toBe(403);
    expect(await rest.text()).toContain('project.write');
    const mcp = runDeclaredTool(
      tool(ran, { byAction: { write: WRITE } }),
      { action: 'write', projectId: PROJECT },
      'u1',
    );
    await expect(mcp).rejects.toThrow(/project\.write/);
    expect(ran).toEqual([]);
    expect(access.seen).toEqual([`project ${PROJECT} as u1`, `project ${PROJECT} as u1`]);
  });

  it('runs both handlers for a member holding the permission', async () => {
    access.role = 'member';
    const ran: string[] = [];
    expect((await restApp(ran).request(`/p/${PROJECT}/thing`, { method: 'POST' })).status).toBe(
      200,
    );
    await runDeclaredTool(tool(ran, WRITE), { action: 'write', projectId: PROJECT }, 'u1');
    expect(ran).toEqual(['rest', 'mcp']);
  });

  it('checks an org.* permission on the organization the path or argument names', async () => {
    const ran: string[] = [];
    const rest = await restApp(ran).request(`/o/${ORG}/thing`, { method: 'POST' });
    expect(rest.status).toBe(403);
    await expect(
      runDeclaredTool(tool(ran, onArg('org.admin', 'orgId')), { action: 'x', orgId: ORG }, 'u1'),
    ).rejects.toThrow(/org\.admin/);
    access.orgRole = 'admin';
    expect((await restApp(ran).request(`/o/${ORG}/thing`, { method: 'POST' })).status).toBe(200);
    expect(ran).toEqual(['org']);
  });

  it('refuses by name a call that does not send the argument its declaration reads', async () => {
    await expect(runDeclaredTool(tool([], WRITE), { action: 'write' }, 'u1')).rejects.toMatchObject(
      { status: 400 },
    );
    await expect(
      runDeclaredTool(tool([], WRITE), { action: 'write', projectId: "x' or 1=1" }, 'u1'),
    ).rejects.toMatchObject({ status: 400 });
    expect(access.seen).toEqual([]);
  });

  it("holds a resolved declaration for the handler's requireDeclared, at either door", async () => {
    const ran: string[] = [];
    expect((await restApp(ran).request('/i/ISS-1/thing', { method: 'POST' })).status).toBe(403);
    await expect(
      runDeclaredTool(
        tool(ran, { byAction: { resolve: onResolved('project.write', 'the issue') } }),
        { action: 'resolve' },
        'u1',
      ),
    ).rejects.toThrow(/project\.write/);
    access.role = 'member';
    expect((await restApp(ran).request('/i/ISS-1/thing', { method: 'POST' })).status).toBe(200);
    expect(ran).toEqual(['resolved']);
    expect(access.seen).toEqual([]);
  });

  it('throws a wiring defect where a handler checks a declaration its action never made', async () => {
    await expect(
      enforceDeclared(
        permissionless('self', 'own rows'),
        { userId: 'u1', named: () => undefined, act: 'x' },
        async () => requireDeclared({ projectId: PROJECT, role: 'admin', grants: [] }),
      ),
    ).rejects.toThrow(/declares no permission/);
  });

  it('refuses an action that declares none before its handler, with no exception left (c3)', async () => {
    const ran: string[] = [];
    const detailOf = (call: Promise<unknown>) =>
      call.then(
        () => 'ran',
        (err: { status?: number; cause?: { details?: unknown } }) =>
          `${err.status} ${String(err.cause?.details)}`,
      );
    expect(
      await detailOf(
        runDeclaredTool(tool(ran, undefined), { action: 'write', projectId: PROJECT }, 'u1'),
      ),
    ).toMatch(/^400 forge_probe\.write declares no permission/);
    expect(
      await detailOf(
        runDeclaredTool(tool(ran, { byAction: { other: WRITE } }), { action: 'resolve' }, 'u1'),
      ),
    ).toMatch(/^400 forge_probe\.resolve declares no permission/);
    expect(ran).toEqual([]);
    expect(access.seen).toEqual([]);
  });
});

describe('a shared service checks what its door has not already checked (requireDeclaredOn)', () => {
  const OTHER = '00000000-0000-4000-8000-000000000002';
  const at = (declared: Parameters<typeof enforceDeclared>[0], service: () => Promise<void>) =>
    enforceDeclared(declared, { userId: 'u1', named: () => PROJECT, act: 'probe' }, service);

  beforeEach(() => {
    access.role = 'member';
  });

  it('skips where the door checked the same permission on the same project', async () => {
    await at(onArg('project.write'), () => requireDeclaredOn(PROJECT, 'u1', 'project.write'));
    // the door's one read, and none by the service
    expect(access.seen).toEqual([`project ${PROJECT} as u1`]);
  });

  it('checks a project other than the one the door checked', async () => {
    await at(onArg('project.write'), () => requireDeclaredOn(OTHER, 'u1', 'project.write'));
    expect(access.seen).toEqual([`project ${PROJECT} as u1`, `project ${OTHER} as u1`]);
    access.role = 'viewer';
    access.seen = [];
    await expect(
      at(onArg('project.read'), () => requireDeclaredOn(OTHER, 'u1', 'project.write')),
    ).rejects.toThrow(/project\.write/);
  });

  it('checks what it needs where the door checked a weaker permission on the same project', async () => {
    access.role = 'viewer';
    await expect(
      at(onArg('project.read'), () => requireDeclaredOn(PROJECT, 'u1', 'project.write')),
    ).rejects.toThrow(/project\.write/);
    expect(access.seen).toEqual([`project ${PROJECT} as u1`, `project ${PROJECT} as u1`]);
  });

  it('checks what it needs for a caller no door declared for, the steward among them', async () => {
    access.role = 'viewer';
    await expect(requireDeclaredOn(PROJECT, 'u1', 'project.write')).rejects.toThrow(
      /project\.write/,
    );
  });
});

describe('a service that loads the access itself checks it the same way (requireDeclaredHeld)', () => {
  const held = (role: 'viewer' | 'member') => ({ projectId: PROJECT, role, grants: [] });
  const at = (declared: Parameters<typeof enforceDeclared>[0], service: () => void) =>
    enforceDeclared(declared, { userId: 'u1', named: () => PROJECT, act: 'probe' }, async () =>
      service(),
    );

  it('checks what it needs for a caller no door declared for', () => {
    expect(() => requireDeclaredHeld(held('viewer'), 'project.write')).toThrow(/project\.write/);
    expect(() => requireDeclaredHeld(held('viewer'), 'project.read')).not.toThrow();
  });

  it('checks what it needs under a resolved declaration of the same permission', async () => {
    await expect(
      at(onResolved('project.write', 'the row'), () =>
        requireDeclaredHeld(held('viewer'), 'project.write'),
      ),
    ).rejects.toThrow(/project\.write/);
    await at(onResolved('project.write', 'the row'), () =>
      requireDeclaredHeld(held('member'), 'project.write'),
    );
  });

  it('checks the resolved declaration too where it names another permission', async () => {
    await expect(
      at(onResolved('project.write', 'the row'), () =>
        requireDeclaredHeld(held('viewer'), 'project.read'),
      ),
    ).rejects.toThrow(/project\.write/);
  });
});

describe('a declaration by a named rule: the floor at the door, the rule in the handler', () => {
  it('refuses below the floor at the door and runs no handler, at either door', async () => {
    access.role = null;
    const ran: string[] = [];
    const rest = await restApp(ran).request(`/p/${PROJECT}/ruled`, { method: 'POST' });
    expect(rest.status).toBe(403);
    expect(await rest.text()).toContain('project.read');
    const floored = byRule('probe/rule.ts:probeRule', 'the row decides', {
      permission: 'project.read',
      on: { arg: 'projectId' },
    });
    await expect(
      runDeclaredTool(tool(ran, floored), { action: 'x', projectId: PROJECT }, 'u1'),
    ).rejects.toThrow(/project\.read/);
    expect(ran).toEqual([]);
  });

  it('runs the handler at the floor, where its rule decides the rest', async () => {
    const ran: string[] = [];
    expect((await restApp(ran).request(`/p/${PROJECT}/ruled`, { method: 'POST' })).status).toBe(
      200,
    );
    expect(ran).toEqual(['ruled']);
  });

  it('checks nothing at the door with no floor: the rule is the whole check', async () => {
    access.role = null;
    const ran: string[] = [];
    expect((await restApp(ran).request('/r/x/ruled', { method: 'POST' })).status).toBe(200);
    await runDeclaredTool(
      tool(ran, byRule('probe/rule.ts:probeRule', 'the row decides')),
      { action: 'x' },
      'u1',
    );
    expect(ran).toEqual(['rule-only', 'mcp']);
    expect(access.seen).toEqual([]);
  });

  it('gives a handler that calls requireDeclared under a rule a wiring defect, not a pass', async () => {
    await expect(
      runDeclaredTool(
        tool([], byRule('probe/rule.ts:probeRule', 'the row decides')),
        { action: 'resolve' },
        'u1',
      ),
    ).rejects.toThrow(/declares no permission for its handler to check/);
  });

  it('publishes the rule, why it decides and the floor', () => {
    expect(renderedPermission(byRule('a.ts:f', 'why'))).toEqual({ rule: 'a.ts:f', why: 'why' });
    expect(
      renderedPermission(
        byRule('a.ts:f', 'why', { permission: 'project.read', on: { param: 'id' } }),
      ),
    ).toEqual({
      rule: 'a.ts:f',
      why: 'why',
      floor: { permission: 'project.read', on: { param: 'id' } },
    });
  });
});

describe('an instance-admin declaration, checked at the door from the admin list', () => {
  it('refuses a caller off the list, ADMIN_ONLY, and runs no handler, at either door', async () => {
    const ran: string[] = [];
    const rest = await restApp(ran).request('/admin/thing');
    expect(rest.status).toBe(403);
    expect(await rest.text()).toContain('admin access required');
    await expect(
      runDeclaredTool(tool(ran, instanceAdmin('the instance')), { action: 'x' }, 'u1'),
    ).rejects.toMatchObject({ code: 'ADMIN_ONLY' });
    await expect(
      runDeclaredTool(tool(ran, instanceAdmin('the instance')), { action: 'x' }, null),
    ).rejects.toMatchObject({ code: 'ADMIN_ONLY' });
    expect(ran).toEqual([]);
  });

  it('runs the handler for a caller on the list, reading no project', async () => {
    admins.list = ['u1'];
    const ran: string[] = [];
    expect((await restApp(ran).request('/admin/thing')).status).toBe(200);
    expect(ran).toEqual(['admin']);
    expect(access.seen).toEqual(['admin list as u1']);
  });

  it('publishes instanceAdmin with why', () => {
    expect(renderedPermission(instanceAdmin('the instance'))).toEqual({
      instanceAdmin: 'the instance',
    });
  });
});
