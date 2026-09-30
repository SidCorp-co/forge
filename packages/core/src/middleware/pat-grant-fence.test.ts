/**
 * ISS-973 — a token's own grants decide what it reaches.
 *
 * The failure this file exists to represent is not the refusal, it is the
 * LOCKOUT: 26 active human tokens on production the day the column landed, 25
 * of them immortal, every one of them unmigrated the instant the migration
 * ran. Reading an ungranted token as permissionless takes every live
 * integration down at once, so the first two cases here are the ones that
 * matter and the refusal cases are the cheap half.
 */

import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));
const effectiveProjectIds = vi.fn((): readonly string[] | null => null);
vi.mock('../mcp/tools/project-scope.js', () => ({
  patEffectiveProjectIds: () => effectiveProjectIds(),
}));

const authenticatePat = vi.fn();
vi.mock('./require-pat.js', () => ({
  authenticatePat: async (c: unknown, t: unknown, l: unknown, onVerified?: () => void) => {
    const resolved = await authenticatePat(c, t, l);
    if (resolved) onVerified?.();
    return resolved;
  },
}));

const {
  beginPatRequest,
  PAT_ACCEPTED_PERMISSIONS_HEADER,
  assertMayMintFullCredential,
  mintEpochFor,
} = await import('./pat-rest-surface.js');
type Principal = Awaited<ReturnType<typeof beginPatRequest>>['principal'];

function principal(permissions: readonly string[] | null | undefined, grantEpoch = 1): Principal {
  return {
    grantEpoch,
    kind: 'pat',
    agency: 'human',
    agentUserId: null,
    userId: 'u1',
    tokenId: 't1',
    scopes: ['read', 'write'],
    projectIds: null,
    ...(permissions === undefined ? {} : { permissions }),
    boundProjectId: null,
    deviceId: null,
  } as Principal;
}

function ctx(path: string, method = 'GET') {
  const vars = new Map<string, unknown>();
  const headers = new Map<string, string>();
  return {
    ctx: {
      req: { path, method },
      get: (k: string) => vars.get(k),
      set: (k: string, v: unknown) => void vars.set(k, v),
      header: (k: string, v: string) => void headers.set(k, v),
    } as never,
    headers,
  };
}

async function refusalFor(
  path: string,
  perms: readonly string[] | null | undefined,
  method = 'GET',
  grantEpoch = 1,
) {
  authenticatePat.mockResolvedValue(principal(perms, grantEpoch));
  try {
    await beginPatRequest(ctx(path, method).ctx, 'forge_pat_test');
    return null;
  } catch (err) {
    if (!(err instanceof HTTPException)) throw err;
    return {
      status: err.status,
      code: (err.cause as { code?: string } | undefined)?.code,
      message: err.message,
    };
  }
}

/** What the accepted-permissions header was set to, refusal or not. */
async function acceptedHeader(
  path: string,
  perms: readonly string[] | null | undefined,
  method = 'GET',
) {
  authenticatePat.mockResolvedValue(principal(perms));
  const fake = ctx(path, method);
  await beginPatRequest(fake.ctx, 'forge_pat_test').catch(() => undefined);
  return fake.headers.get(PAT_ACCEPTED_PERMISSIONS_HEADER) ?? null;
}

beforeEach(() => {
  authenticatePat.mockReset();
  effectiveProjectIds.mockReset();
  effectiveProjectIds.mockReturnValue(null);
});

describe('a token granted nothing reaches the whole menu', () => {
  it.each([
    ['an unmigrated token (NULL column)', null],
    ['a token minted with an empty grant array', []],
    ['a principal built without the field at all', undefined],
  ] as const)('%s reaches /api/issues', async (_label, perms) => {
    expect(await refusalFor('/api/issues', perms)).toBeNull();
  });

  it.each([
    ['/api/issues'],
    ['/api/comments'],
    ['/api/attachments'],
    ['/api/labels'],
    ['/api/tasks'],
    ['/api/pipeline-runs'],
    ['/api/jobs'],
    ['/api/issue-step-contexts'],
    ['/api/knowledge'],
    ['/api/knowledge-edges'],
    ['/api/memory'],
    ['/api/skills'],
    ['/api/skill-facts'],
    ['/api/prompts'],
    ['/api/schedules'],
    ['/api/projects'],
  ])('an unmigrated token still reaches %s', async (path) => {
    expect(await refusalFor(path, null)).toBeNull();
  });

  it('reaches a write route too, so the lockout cannot hide behind the method', async () => {
    expect(await refusalFor('/api/issues', null, 'POST')).toBeNull();
  });
});

describe('a granted token reaches its own groups and nothing else', () => {
  it('answers inside the group it holds', async () => {
    expect(await refusalFor('/api/issues', ['issues:read'])).toBeNull();
  });

  it('answers on another prefix of the same resource', async () => {
    expect(await refusalFor('/api/comments/abc', ['issues:read'])).toBeNull();
  });

  it('refuses a path outside the group, naming the permission it wanted', async () => {
    const refusal = await refusalFor('/api/schedules', ['issues:read']);
    expect(refusal?.status).toBe(403);
    expect(refusal?.code).toBe('PAT_PERMISSION_REQUIRED');
    expect(refusal?.message).toContain('schedules:read');
    expect(refusal?.message).toContain('issues:read');
  });

  it('refuses a write to a resource it only holds the read of', async () => {
    const refusal = await refusalFor('/api/issues', ['issues:read'], 'POST');
    expect(refusal?.code).toBe('PAT_PERMISSION_REQUIRED');
    expect(refusal?.message).toContain('issues:write');
  });

  it('admits the write once the write group is held', async () => {
    expect(await refusalFor('/api/issues', ['issues:write'], 'POST')).toBeNull();
  });

  it('reaches nothing when every name it holds has left the menu', async () => {
    const refusal = await refusalFor('/api/issues', ['gone:read']);
    expect(refusal?.code).toBe('PAT_PERMISSION_REQUIRED');
  });
});

describe('the surface refusal is not the grant refusal', () => {
  it.each([
    ['/api/pat', null],
    ['/api/pat', ['issues:read']],
    ['/api/auth/logout', ['*']],
    ['/api/nothing-mounted-here', null],
    ['/api/uploads', null],
  ] as const)('%s is PAT_NOT_PERMITTED whatever the token holds', async (path, perms) => {
    const refusal = await refusalFor(path, perms);
    expect(refusal?.status).toBe(403);
    expect(refusal?.code).toBe('PAT_NOT_PERMITTED');
  });

  it.each([
    ['/api/pat', null],
    ['/api/devices/me/pool', ['devices:read']],
    ['/api/nothing-mounted-here', null],
    ['/api/uploads', null],
  ] as const)('%s sets no accepted-permissions header', async (path, perms) => {
    expect(await acceptedHeader(path, perms)).toBeNull();
  });

  it('a covered path sets it, so the absence above is the path and not the fake', async () => {
    expect(await acceptedHeader('/api/issues', ['issues:read'])).toBe('issues:read');
  });
});

describe('the scope word keeps its job', () => {
  it('refuses a write from a read-only token before the grant is consulted', async () => {
    authenticatePat.mockResolvedValue({ ...principal(['issues:write']), scopes: ['read'] });
    try {
      await beginPatRequest(ctx('/api/issues', 'POST').ctx, 'forge_pat_test');
      expect.unreachable('a read-only token wrote');
    } catch (err) {
      expect((err as HTTPException).status).toBe(403);
      expect(((err as HTTPException).cause as { code: string }).code).toBe('INSUFFICIENT_SCOPE');
    }
  });
});

/**
 * ISS-1373 — the menu grew, and every token already issued keeps exactly the
 * reach it had. The refusals come in a fixed order, so each case below is
 * built to pass every check before the one it is about.
 */
describe('a path kept out of the grammar is refused with its reason', () => {
  it('names the entry and says why', async () => {
    const refusal = await refusalFor('/api/pat/p1/rotate', ['*'], 'POST', 2);
    expect(refusal?.code).toBe('PAT_NOT_PERMITTED');
    expect(refusal?.message).toContain('(/api/pat)');
    expect(refusal?.message).toContain('could widen its own grant');
  });
});

describe('a token minted before the menu grew keeps its reach', () => {
  it.each([
    ['NULL', null],
    ['[]', []],
    ['*', ['*']],
    ['named', ['runners:read', 'issues:read']],
  ] as const)('an epoch-1 %s grant is refused on a prefix added at epoch 2', async (_l, perms) => {
    const refusal = await refusalFor('/api/runners', perms, 'GET', 1);
    expect(refusal?.status).toBe(403);
    expect(refusal?.code).toBe('PAT_GRANT_PREDATES_ROUTE');
    expect(refusal?.message).toContain('/api/runners');
  });

  it('refuses an epoch-1 issues:read on the prefix issues gained, and not on the ones it had', async () => {
    expect((await refusalFor('/api/body/b1', ['issues:read'], 'GET', 1))?.code).toBe(
      'PAT_GRANT_PREDATES_ROUTE',
    );
    expect(await refusalFor('/api/issues/i1', ['issues:read'], 'GET', 1)).toBeNull();
  });

  it.each([
    ['NULL', null],
    ['[]', []],
    ['*', ['*']],
  ] as const)('an epoch-1 %s grant still reaches every epoch-1 prefix', async (_l, perms) => {
    for (const path of ['/api/issues', '/api/projects/p1', '/api/jobs', '/api/questions']) {
      expect(await refusalFor(path, perms, 'GET', 1), path).toBeNull();
    }
  });

  it('reads a principal carrying no epoch as the narrowest', async () => {
    authenticatePat.mockResolvedValue({ ...principal(['*']), grantEpoch: undefined });
    await expect(beginPatRequest(ctx('/api/runners').ctx, 'forge_pat_test')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('a token minted now reaches what the menu added', () => {
  it('an account-wide * token reaches a new account route', async () => {
    expect(await refusalFor('/api/notifications', ['*'], 'GET', 2)).toBeNull();
  });

  it('a project-scoped * token reaches a new project route', async () => {
    effectiveProjectIds.mockReturnValue(['p1']);
    expect(await refusalFor('/api/runners', ['*'], 'GET', 2)).toBeNull();
  });

  it('a named grant still reaches only what it names', async () => {
    expect(await refusalFor('/api/runners', ['runners:read'], 'GET', 2)).toBeNull();
    expect((await refusalFor('/api/runners', ['issues:read'], 'GET', 2))?.code).toBe(
      'PAT_PERMISSION_REQUIRED',
    );
  });
});

describe('an account route refuses a token fenced to projects', () => {
  it.each([
    ['projectIds', ['p1']],
    ['an empty project list', []],
  ] as const)('refuses one fenced by %s, whatever it holds', async (_l, fence) => {
    effectiveProjectIds.mockReturnValue(fence);
    for (const perms of [['*'], ['orgs:read'], null]) {
      const refusal = await refusalFor('/api/orgs', perms, 'GET', 2);
      expect(refusal?.code, JSON.stringify(perms)).toBe('PAT_ACCOUNT_ROUTE');
    }
  });

  it('answers PAT_ACCOUNT_ROUTE ahead of the epoch for a scoped epoch-1 token', async () => {
    effectiveProjectIds.mockReturnValue(['p1']);
    expect((await refusalFor('/api/notifications', ['*'], 'GET', 1))?.code).toBe(
      'PAT_ACCOUNT_ROUTE',
    );
  });

  it('answers INSUFFICIENT_SCOPE ahead of the epoch for a read-only epoch-1 token', async () => {
    authenticatePat.mockResolvedValue({ ...principal(['*'], 1), scopes: ['read'] });
    await expect(
      beginPatRequest(ctx('/api/runners', 'POST').ctx, 'forge_pat_test'),
    ).rejects.toMatchObject({ cause: { code: 'INSUFFICIENT_SCOPE' } });
  });
});

describe('a credential minted during a request is no wider than what admitted it', () => {
  async function admitted(perms: readonly string[] | null, grantEpoch: number) {
    authenticatePat.mockResolvedValue(principal(perms, grantEpoch));
    const fake = ctx('/api/orgs/o1/agents', 'POST');
    await beginPatRequest(fake.ctx, 'forge_pat_test');
    return fake.ctx as never;
  }

  it('stamps the admitting token epoch, and the current one for a session', async () => {
    expect(mintEpochFor(await admitted(['*'], 2))).toBe(2);
    expect(mintEpochFor(ctx('/api/orgs/o1/agents', 'POST').ctx)).toBe(2);
  });

  it('never stamps above the menu, whatever the admitting token claims', async () => {
    expect(mintEpochFor(await admitted(['*'], 9))).toBe(2);
  });

  it('refuses a named grant on a route minting a * credential, and lets * and a session through', async () => {
    expect(() => assertMayMintFullCredential(ctx('/x', 'POST').ctx)).not.toThrow();
    const full = await admitted(['*'], 2);
    expect(() => assertMayMintFullCredential(full)).not.toThrow();
    const named = await admitted(['orgs:write'], 2);
    try {
      assertMayMintFullCredential(named);
      expect.unreachable('a named grant minted a * credential');
    } catch (err) {
      expect(((err as HTTPException).cause as { code: string }).code).toBe(
        'PAT_MINT_NEEDS_FULL_GRANT',
      );
    }
  });
});
