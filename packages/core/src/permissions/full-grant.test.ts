import {
  type ProjectPermission,
  ROLE_PERMISSIONS,
  TOKEN_EXPLICIT_PERMISSIONS,
} from '@forge/contracts/permissions';
import { describe, expect, it } from 'vitest';
import { runWithPatScope } from '../credentials/pat-scope.js';
import { holds, permissionRefusal } from './can.js';

// REQ-27 BC-4 (the owner's ruling of 2026-10-08): a token granted Full can do everything its owner's
// role can, approvals included; a named grant holds a token-explicit permission only where it names it.

const projectId = '00000000-0000-4000-8000-000000000001';
const admin = { projectId, role: 'admin' as const, grants: [] };
const member = { projectId, role: 'member' as const, grants: [] };
const token = (grant: readonly string[] | null, scopes = ['read', 'write']) => ({
  projectIds: null,
  tokenId: 't',
  grant,
  scopes,
});

describe('a Full token holds what its holder holds (REQ-27 BC-4)', () => {
  it('holds every permission of an admin, every approval and token-explicit one included', () => {
    runWithPatScope(token(['*']), () => {
      for (const p of ROLE_PERMISSIONS.admin) expect(holds(admin, p), p).toBe(true);
      expect(holds(admin, 'suggestions.approve')).toBe(true);
      expect(permissionRefusal(admin, 'suggestions.approve')).toBeNull();
    });
  });

  it('holds no more than its holder: a member’s Full token approves nothing', () => {
    runWithPatScope(token(['*']), () => {
      expect(holds(member, 'suggestions.approve')).toBe(false);
      expect(holds(member, 'questionnaires.answer')).toBe(true);
    });
  });

  it('holds what the membership grant adds, as a session would', () => {
    const approver = { ...member, grants: ['suggestions.approve'] };
    runWithPatScope(token(['*']), () => {
      expect(holds(approver, 'suggestions.approve')).toBe(true);
      expect(holds(approver, 'releases.approve')).toBe(false);
    });
  });

  it('a read-scoped Full token still writes and approves nothing', () => {
    runWithPatScope(token(['*'], ['read']), () => {
      expect(holds(admin, 'project.read')).toBe(true);
      expect(holds(admin, 'suggestions.approve')).toBe(false);
    });
  });
});

describe('a named grant holds a token-explicit permission only where it names it', () => {
  it('refuses every token-explicit permission it does not name, saying how to get it', () => {
    runWithPatScope(token(['projects:write']), () => {
      for (const p of TOKEN_EXPLICIT_PERMISSIONS) {
        expect(holds(admin, p as ProjectPermission), p).toBe(false);
      }
      expect(permissionRefusal(admin, 'suggestions.approve')?.detail).toContain(
        'A named token grant holds suggestions.approve only where it names it',
      );
      expect(holds(admin, 'project.write')).toBe(true);
    });
  });

  it('holds the approval it names, and no other', () => {
    runWithPatScope(token(['projects:write', 'suggestions.approve']), () => {
      expect(holds(admin, 'suggestions.approve')).toBe(true);
      expect(holds(admin, 'releases.approve')).toBe(false);
    });
  });

  it('a box token stating no grant holds no token-explicit permission', () => {
    runWithPatScope(token(null), () => {
      expect(holds(admin, 'suggestions.approve')).toBe(false);
      expect(holds(admin, 'project.write')).toBe(true);
    });
  });
});
