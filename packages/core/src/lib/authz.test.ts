import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';

// Stub the db client so importing the module doesn't require a configured
// environment. Pure helpers never touch it; the falsy-userId guard tests
// install a select chain per test via `dbMock.select`.
const dbMock = vi.hoisted(() => ({}) as { select?: unknown });
vi.mock('../db/client.js', () => ({ db: dbMock }));

import {
  type ProjectAccess,
  assertOrgRoleOnProject,
  assertProjectRole,
  effectiveProjectRole,
  loadOrgRole,
  loadPersonalOrgId,
  loadVisibleProjectIds,
  maxProjectRole,
  orgDerivedProjectRole,
  orgRoleAtLeast,
  projectRoleAtLeast,
} from './authz.js';

/** One-shot `db.select().from().where().limit()` chain returning `rows`. */
const selectChain = (rows: unknown[]) =>
  vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }));

const access = (over: Partial<ProjectAccess> = {}): ProjectAccess => ({
  projectId: 'p-1',
  orgId: 'o-1',
  role: null,
  orgRole: null,
  ...over,
});

describe('projectRoleAtLeast', () => {
  it('ranks admin > member > viewer', () => {
    expect(projectRoleAtLeast('admin', 'viewer')).toBe(true);
    expect(projectRoleAtLeast('admin', 'admin')).toBe(true);
    expect(projectRoleAtLeast('member', 'admin')).toBe(false);
    expect(projectRoleAtLeast('viewer', 'member')).toBe(false);
    expect(projectRoleAtLeast('viewer', 'viewer')).toBe(true);
  });

  it('null role never passes', () => {
    expect(projectRoleAtLeast(null, 'viewer')).toBe(false);
  });
});

describe('orgRoleAtLeast', () => {
  it('ranks owner > admin > member', () => {
    expect(orgRoleAtLeast('owner', 'admin')).toBe(true);
    expect(orgRoleAtLeast('admin', 'owner')).toBe(false);
    expect(orgRoleAtLeast('member', 'admin')).toBe(false);
    expect(orgRoleAtLeast(null, 'member')).toBe(false);
  });
});

describe('orgDerivedProjectRole', () => {
  it('org owner/admin derive project admin; member derives nothing', () => {
    expect(orgDerivedProjectRole('owner')).toBe('admin');
    expect(orgDerivedProjectRole('admin')).toBe('admin');
    expect(orgDerivedProjectRole('member')).toBeNull();
    expect(orgDerivedProjectRole(null)).toBeNull();
  });
});

describe('maxProjectRole', () => {
  it('picks the higher of the two and tolerates nulls', () => {
    expect(maxProjectRole('viewer', 'admin')).toBe('admin');
    expect(maxProjectRole('member', 'viewer')).toBe('member');
    expect(maxProjectRole(null, 'viewer')).toBe('viewer');
    expect(maxProjectRole('member', null)).toBe('member');
    expect(maxProjectRole(null, null)).toBeNull();
  });
});

describe('assertProjectRole', () => {
  it('passes at or above the min role', () => {
    expect(() => assertProjectRole(access({ role: 'admin' }), 'member')).not.toThrow();
    expect(() => assertProjectRole(access({ role: 'member' }), 'member')).not.toThrow();
  });

  it('403s below the min role and with no role', () => {
    for (const [role, min] of [
      ['viewer', 'member'],
      ['member', 'admin'],
      [null, 'viewer'],
    ] as const) {
      try {
        assertProjectRole(access({ role }), min);
        expect.unreachable('expected 403');
      } catch (err) {
        expect(err).toBeInstanceOf(HTTPException);
        expect((err as HTTPException).status).toBe(403);
      }
    }
  });
});

// requireUserOrDevice() leaves `userId` unset for device principals — the
// authz seam must fail CLOSED (no role / nothing visible), never bind the
// undefined value into SQL (postgres-js throws UNDEFINED_VALUE → 500).
describe('falsy-userId guards (device principal)', () => {
  it('effectiveProjectRole resolves project existence but no role', async () => {
    dbMock.select = selectChain([{ orgId: 'o-1' }]);
    expect(await effectiveProjectRole(undefined, 'p-1')).toEqual({
      projectId: 'p-1',
      orgId: 'o-1',
      role: null,
      orgRole: null,
    });
  });

  it('effectiveProjectRole still reports a missing project as null', async () => {
    dbMock.select = selectChain([]);
    expect(await effectiveProjectRole(undefined, 'p-missing')).toBeNull();
  });

  it('loadOrgRole / loadVisibleProjectIds / loadPersonalOrgId short-circuit without touching the db', async () => {
    dbMock.select = vi.fn(() => {
      throw new Error('db must not be queried for a falsy userId');
    });
    expect(await loadOrgRole('o-1', undefined)).toBeNull();
    expect(await loadVisibleProjectIds(undefined)).toEqual([]);
    expect(await loadPersonalOrgId(undefined)).toBeNull();
  });
});

describe('assertOrgRoleOnProject', () => {
  it('org owner/admin pass; project admin without org role does not', () => {
    expect(() =>
      assertOrgRoleOnProject(access({ role: 'admin', orgRole: 'owner' }), 'admin'),
    ).not.toThrow();
    expect(() =>
      assertOrgRoleOnProject(access({ role: 'admin', orgRole: 'admin' }), 'admin'),
    ).not.toThrow();
    // The legacy "owner-only" semantics: an invited project admin (no org
    // role) cannot pass the org-tier gate.
    try {
      assertOrgRoleOnProject(access({ role: 'admin', orgRole: null }), 'admin');
      expect.unreachable('expected 403');
    } catch (err) {
      expect((err as HTTPException).status).toBe(403);
    }
    // Plain org member is also below the bar.
    try {
      assertOrgRoleOnProject(access({ role: 'member', orgRole: 'member' }), 'admin');
      expect.unreachable('expected 403');
    } catch (err) {
      expect((err as HTTPException).status).toBe(403);
    }
  });
});
