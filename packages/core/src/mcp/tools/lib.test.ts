import { beforeEach, describe, expect, it, vi } from 'vitest';


vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

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

import { actorAgency } from '../../issues/actor-agency.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import {
  assertPrincipalIsMember,
  type McpContext,
  principalActor,
  principalAgency,
  principalEstablishedAgency,
  resolveEffectiveProjectId,
} from './lib.js';
import { patEffectiveProjectIds } from './project-scope.js';

const BOUND = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SLUG_ID = '33333333-3333-4333-8333-333333333333';

function patPrincipal(over: Partial<McpPrincipal> = {}): McpPrincipal {
  return {
    kind: 'pat',
    agency: null,
    agentUserId: null,
    userId: 'user-1',
    tokenId: 'tok-1',
    scopes: ['read', 'write'],
    projectIds: null,
    boundProjectId: null,
    deviceId: null,
    ...over,
  };
}

function ctx(over: Partial<McpContext> = {}): McpContext {
  return {
    principal: patPrincipal(),
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
    expect(selectLimit).not.toHaveBeenCalled();
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

describe('principalActor — who a write is recorded as', () => {
  const pat = patPrincipal({ userId: 'user-9', tokenId: 'tok-1', scopes: [] });

  it('records the person whose token it is, claiming nothing about who is speaking', () => {
    expect(
      principalActor(patPrincipal({ userId: 'user-9', tokenId: 'tok-1', scopes: [] })),
    ).toEqual({ type: 'user', id: 'user-9', agency: null });
  });

  it('leaves a person-owned token subject to the agent gates rather than exempt from them', () => {
    expect(actorAgency(principalActor(pat))).toBe('agent');
    expect(principalAgency(pat)).toBe('agent');
    expect(principalEstablishedAgency(pat)).toBeNull();
  });

  it('records an agent-held token under the device actor shape, though it carries a pat principal', () => {
    expect(principalActor({ ...pat, agency: 'agent' })).toEqual({
      type: 'device',
      id: 'tok-1',
      ownerId: 'user-9',
    });
  });

  it('carries the token id, not a devices row', () => {
    const actor = principalActor({ ...pat, agency: 'agent' });
    expect(actor).toMatchObject({ id: pat.tokenId, ownerId: pat.userId });
  });
});
