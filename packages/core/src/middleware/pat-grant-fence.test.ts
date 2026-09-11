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
vi.mock('../mcp/tools/project-scope.js', () => ({ patEffectiveProjectIds: () => null }));

const authenticatePat = vi.fn();
// cm:guard the wrapper fires `onVerified` exactly where the real `authenticatePat` does — once a row resolved, never for a token that did not verify — so the cases below keep saying what they said while the header rides on that callback (ISS-974). Firing it unconditionally here would make the fence's own "unauthenticated callers learn nothing" property untestable from this file.
vi.mock('./require-pat.js', () => ({
  authenticatePat: async (c: unknown, t: unknown, l: unknown, onVerified?: () => void) => {
    const resolved = await authenticatePat(c, t, l);
    if (resolved) onVerified?.();
    return resolved;
  },
}));

const { beginPatRequest, PAT_ACCEPTED_PERMISSIONS_HEADER } = await import('./pat-rest-surface.js');
type Principal = Awaited<ReturnType<typeof beginPatRequest>>['principal'];

function principal(permissions: readonly string[] | null | undefined): Principal {
  return {
    kind: 'pat',
    agency: 'human',
    userId: 'u1',
    tokenId: 't1',
    scopes: ['read', 'write'],
    projectIds: null,
    ...(permissions === undefined ? {} : { permissions }),
    boundProjectId: null,
    deviceId: null,
  } as Principal;
}

// cm:guard the fake carries `path` and `method` as its only INPUTS, because every check `beginPatRequest` makes must read one of those two or the token — a case that needs a third input is a check that broke the memo in `PAT_REQUEST_VAR` and the guard there says so. `header` is an output sink and not a third input: it records what the accepted-permissions header was set to (ISS-974) and answers nothing back.
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
) {
  authenticatePat.mockResolvedValue(principal(perms));
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
});

describe('a token granted nothing reaches the whole menu', () => {
  // cm:guard NULL and `[]` are asserted APART, never as one parameterized case with `?? []` in the helper. They arrive by different routes — the column the migration never wrote, and a caller who sent an empty array — and one `??` in the wrong place makes exactly one of them permissionless while the other keeps working, which is the shape that reaches production looking tested.
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

  // cm:guard the opposite direction to the absent-grant rule above, and deliberately so: a token narrowed to groups the menu no longer declares must reach NOTHING. Only ABSENCE is the whole menu, so a non-empty array that resolves to no prefix is a token that was narrowed and whose groups went away.
  it('reaches nothing when every name it holds has left the menu', async () => {
    const refusal = await refusalFor('/api/issues', ['gone:read']);
    expect(refusal?.code).toBe('PAT_PERMISSION_REQUIRED');
  });
});

describe('the surface refusal is not the grant refusal', () => {
  it.each([
    ['/api/pat', null],
    ['/api/pat', ['issues:read']],
    ['/api/admin/mcp-audit', ['issues:read']],
    ['/api/agent-sessions', null],
    ['/api/uploads', null],
  ] as const)('%s is PAT_NOT_PERMITTED whatever the token holds', async (path, perms) => {
    const refusal = await refusalFor(path, perms);
    expect(refusal?.status).toBe(403);
    expect(refusal?.code).toBe('PAT_NOT_PERMITTED');
  });

  // cm:guard the surface refusal is the ONE outcome that names no permission, and it must name none by being ABSENT rather than empty (ISS-974) — an empty value on `/api/pat` claims the route requires nothing, which is the opposite of true. The wire-level twin of this is `pat-accepted-permissions-header.test.ts`; this one holds the predicate to it without a response to parse.
  it.each([
    ['/api/pat', null],
    ['/api/admin/mcp-audit', ['issues:read']],
    ['/api/agent-sessions', null],
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
