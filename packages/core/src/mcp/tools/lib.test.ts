import { beforeEach, describe, expect, it, vi } from 'vitest';

// ISS-497 — project-scoped MCP tokens: effective-allowlist fold +
// effective-project resolver. These cover the resolution precedence
// (arg > slug > boundProjectId > BAD_REQUEST), the NOT_FOUND cross-project
// conflict rule, and backward-compat for user-level (NULL binding) tokens.

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

// db mock — only `resolveProjectIdFromSlug` touches it (select→from→where→limit).
const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

// authz mock — loadUserProjectRoleFlags relies on effectiveProjectRole.
const effectiveProjectRole = vi.fn();
vi.mock('../../lib/authz.js', () => ({
  effectiveProjectRole: (...args: unknown[]) => effectiveProjectRole(...args),
  loadVisibleProjectIds: vi.fn(async () => []),
  projectRoleAtLeast: (role: string | null, min: string) => {
    if (role === null) return false;
    const order = ['viewer', 'member', 'admin'];
    return order.indexOf(role) >= order.indexOf(min);
  },
}));

import type { McpPrincipal } from '../../middleware/require-pat-or-device.js';
import {
  type McpContext,
  assertPrincipalIsMember,
  patEffectiveProjectIds,
  resolveEffectiveProjectId,
} from './lib.js';

const BOUND = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SLUG_ID = '33333333-3333-4333-8333-333333333333';

function patPrincipal(over: Partial<Extract<McpPrincipal, { kind: 'pat' }>> = {}): McpPrincipal {
  return {
    kind: 'pat',
    userId: 'user-1',
    tokenId: 'tok-1',
    scopes: ['read', 'write'],
    projectIds: null,
    boundProjectId: null,
    ...over,
  };
}

function ctx(over: Partial<McpContext> = {}): McpContext {
  return {
    principal: patPrincipal(),
    // device stub — unused by the resolver paths under test
    device: { ownerId: 'user-1' } as McpContext['device'],
    projectSlug: null,
    boundProjectId: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockResolvedValue([{ id: SLUG_ID }]);
});

describe('patEffectiveProjectIds', () => {
  it('returns null for a device principal', () => {
    expect(patEffectiveProjectIds({ kind: 'device', device: {} as never })).toBeNull();
  });

  it('returns null for a user-level PAT with no allowlist', () => {
    expect(patEffectiveProjectIds(patPrincipal())).toBeNull();
  });

  it('returns the projectIds allowlist for a user-level PAT', () => {
    expect(patEffectiveProjectIds(patPrincipal({ projectIds: [BOUND, OTHER] }))).toEqual([
      BOUND,
      OTHER,
    ]);
  });

  it('fences a bound PAT to exactly its bound project', () => {
    expect(
      patEffectiveProjectIds(patPrincipal({ boundProjectId: BOUND, projectIds: null })),
    ).toEqual([BOUND]);
  });
});

describe('resolveEffectiveProjectId precedence', () => {
  it('1. explicit projectId arg wins over slug and binding', async () => {
    const c = ctx({ projectSlug: 'some-slug', boundProjectId: BOUND });
    await expect(resolveEffectiveProjectId(c, OTHER)).resolves.toBe(OTHER);
    expect(selectLimit).not.toHaveBeenCalled(); // no slug round-trip
  });

  it('2. slug header resolves when no explicit arg', async () => {
    const c = ctx({ projectSlug: 'some-slug', boundProjectId: BOUND });
    await expect(resolveEffectiveProjectId(c)).resolves.toBe(SLUG_ID);
  });

  it('3. boundProjectId resolves directly when no arg or slug (no slug round-trip)', async () => {
    const c = ctx({ projectSlug: null, boundProjectId: BOUND });
    await expect(resolveEffectiveProjectId(c)).resolves.toBe(BOUND);
    expect(selectLimit).not.toHaveBeenCalled();
  });

  it('4. user-level token with nothing supplied → BAD_REQUEST (unchanged)', async () => {
    const c = ctx({ projectSlug: null, boundProjectId: null });
    await expect(resolveEffectiveProjectId(c)).rejects.toThrow(/BAD_REQUEST/);
  });
});

describe('cross-project conflict → NOT_FOUND', () => {
  it('bound PAT + explicit arg for a different project is fenced as NOT_FOUND', async () => {
    // allow = [BOUND]; target OTHER not in allow → NOT_FOUND before any role lookup.
    await expect(
      assertPrincipalIsMember(patPrincipal({ boundProjectId: BOUND }), OTHER),
    ).rejects.toThrow(/NOT_FOUND/);
    expect(effectiveProjectRole).not.toHaveBeenCalled();
  });

  it('bound PAT for its own project passes the fence (then role-checked)', async () => {
    effectiveProjectRole.mockResolvedValue({ role: 'member' });
    await expect(
      assertPrincipalIsMember(patPrincipal({ boundProjectId: BOUND }), BOUND),
    ).resolves.toBeUndefined();
    expect(effectiveProjectRole).toHaveBeenCalledWith('user-1', BOUND);
  });
});
