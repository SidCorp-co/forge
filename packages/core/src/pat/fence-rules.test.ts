import { PAT_FENCE_REFUSAL_CODES, setPatFenceRequestSchema } from '@forge/contracts/pat-fence';
import { describe, expect, it } from 'vitest';
import {
  type FencedToken,
  fenceEditorRefusal,
  fenceOf,
  fenceRefusals,
  tokenStateRefusals,
} from './fence-rules.js';

const A = '0b8f3a52-7a43-4f5e-9d0a-6a1d2c3b4e01';
const B = '0b8f3a52-7a43-4f5e-9d0a-6a1d2c3b4e02';
const C = '0b8f3a52-7a43-4f5e-9d0a-6a1d2c3b4e03';
const NOW = new Date('2026-10-04T12:00:00Z');

const token = (over: Partial<FencedToken> = {}): FencedToken => ({
  id: 't1',
  name: 'box-ci',
  deviceId: null,
  revokedAt: null,
  expiresAt: null,
  permissions: ['issues:read', 'projects:read'],
  projectIds: null,
  boundProjectId: A,
  ...over,
});

const reach = new Set([A, B]);
const codes = (list: { code: string }[]) => list.map((r) => r.code);

describe('who may change a token fence', () => {
  it('admits a person signed in with a session', () => {
    expect(fenceEditorRefusal('user')).toBeNull();
  });

  it('refuses a token, so no token can widen itself or another, PAT_FENCE_BY_TOKEN_FORBIDDEN', () => {
    expect(fenceEditorRefusal('pat')?.code).toBe('PAT_FENCE_BY_TOKEN_FORBIDDEN');
    expect(fenceEditorRefusal('device')?.code).toBe('PAT_FENCE_BY_TOKEN_FORBIDDEN');
    expect(fenceEditorRefusal(undefined)?.detail).toContain('no credential');
  });
});

describe('which tokens take a fence edit', () => {
  it('takes a live personal token', () => {
    expect(tokenStateRefusals(token(), NOW)).toEqual([]);
    expect(tokenStateRefusals(token({ expiresAt: new Date('2026-10-05T00:00:00Z') }), NOW)).toEqual(
      [],
    );
  });

  it('refuses a revoked token, PAT_FENCE_TOKEN_REVOKED, ahead of any other state', () => {
    const revoked = token({ revokedAt: new Date('2026-10-01T00:00:00Z'), deviceId: 'd1' });
    expect(codes(tokenStateRefusals(revoked, NOW))).toEqual(['PAT_FENCE_TOKEN_REVOKED']);
  });

  it('refuses an expired token, PAT_FENCE_TOKEN_EXPIRED, at the instant it expires', () => {
    expect(codes(tokenStateRefusals(token({ expiresAt: NOW }), NOW))).toEqual([
      'PAT_FENCE_TOKEN_EXPIRED',
    ]);
  });

  it('refuses a token core minted, by device or by reserved name, PAT_FENCE_CORE_MINTED', () => {
    expect(codes(tokenStateRefusals(token({ deviceId: 'd1' }), NOW))).toEqual([
      'PAT_FENCE_CORE_MINTED',
    ]);
    for (const name of ['device:d1', `workspace:d1:${A}`, 'turn:s1', 'turn 2026-10-04 n']) {
      expect(codes(tokenStateRefusals(token({ name }), NOW)), name).toEqual([
        'PAT_FENCE_CORE_MINTED',
      ]);
    }
  });
});

describe('what a fence may name', () => {
  it('admits projects the owner reaches, adding and removing', () => {
    expect(fenceRefusals(token(), fenceOf({ projectIds: [A, B] }), reach)).toEqual([]);
    expect(
      fenceRefusals(
        token({ boundProjectId: null, projectIds: [A, B] }),
        fenceOf({ boundProjectId: B }),
        reach,
      ),
    ).toEqual([]);
  });

  it('refuses each project the owner does not reach, by its path, PAT_FENCE_PROJECT_NOT_REACHABLE', () => {
    const refused = fenceRefusals(token(), fenceOf({ projectIds: [A, C] }), reach);
    expect(refused).toEqual([
      expect.objectContaining({ code: 'PAT_FENCE_PROJECT_NOT_REACHABLE', path: '/projectIds/1' }),
    ]);
    expect(refused[0]?.detail).toContain(C);
    expect(fenceRefusals(token(), fenceOf({ boundProjectId: C }), reach)[0]?.path).toBe(
      '/boundProjectId',
    );
  });

  it('refuses fencing a token that holds account permissions, PAT_FENCE_ACCOUNT_PERMISSION', () => {
    const unfenced = token({ boundProjectId: null, permissions: ['issues:read', 'account:read'] });
    const refused = fenceRefusals(unfenced, fenceOf({ boundProjectId: A }), reach);
    expect(codes(refused)).toEqual(['PAT_FENCE_ACCOUNT_PERMISSION']);
    expect(refused[0]?.detail).toContain('account:read');
  });

  it('refuses an edit that changes nothing, PAT_FENCE_UNCHANGED, whatever the order', () => {
    expect(codes(fenceRefusals(token(), fenceOf({ boundProjectId: A }), reach))).toEqual([
      'PAT_FENCE_UNCHANGED',
    ]);
    const listed = token({ boundProjectId: null, projectIds: [A, B] });
    expect(codes(fenceRefusals(listed, fenceOf({ projectIds: [B, A] }), reach))).toEqual([
      'PAT_FENCE_UNCHANGED',
    ]);
  });

  it('reads a bound project and a one-project list as different fences', () => {
    expect(fenceRefusals(token(), fenceOf({ projectIds: [A] }), reach)).toEqual([]);
  });
});

describe('the fence edit body', () => {
  const ok = { projectIds: [A], reason: 'box now serves A' };

  it('takes exactly one of projectIds or boundProjectId, with a reason', () => {
    expect(setPatFenceRequestSchema.safeParse(ok).success).toBe(true);
    expect(setPatFenceRequestSchema.safeParse({ boundProjectId: A, reason: 'r' }).success).toBe(
      true,
    );
  });

  it('refuses both, neither, a repeat, an empty list, a blank reason and an unknown field', () => {
    for (const bad of [
      { projectIds: [A], boundProjectId: B, reason: 'r' },
      { reason: 'r' },
      { projectIds: [A, A], reason: 'r' },
      { projectIds: [], reason: 'r' },
      { projectIds: [A], reason: '   ' },
      { ...ok, scopes: ['admin'] },
      { ...ok, permissions: ['*'] },
    ]) {
      expect(setPatFenceRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('declares every code these rules return', () => {
    expect([...PAT_FENCE_REFUSAL_CODES].sort()).toEqual(
      [
        'PAT_FENCE_ACCOUNT_PERMISSION',
        'PAT_FENCE_BY_TOKEN_FORBIDDEN',
        'PAT_FENCE_CORE_MINTED',
        'PAT_FENCE_PROJECT_NOT_REACHABLE',
        'PAT_FENCE_TOKEN_EXPIRED',
        'PAT_FENCE_TOKEN_REVOKED',
        'PAT_FENCE_UNCHANGED',
      ].sort(),
    );
  });
});
