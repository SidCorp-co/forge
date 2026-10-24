import { describe, expect, it } from 'vitest';
import { runWithPatScope } from '../credentials/pat-scope.js';
import { permissionRefusal } from './can.js';

// ISS-597: a token fenced to other projects reads as holding no role on this one, so its refusal
// names the fence, never "the caller holds no role", which is false for a holder who has one.

const here = '00000000-0000-4000-8000-000000000001';
const elsewhere = '00000000-0000-4000-8000-000000000002';
const unheld = { projectId: here, role: null, grants: [] };
const fencedTo = (projectIds: readonly string[] | null) => ({
  projectIds,
  tokenId: 't',
  grant: ['*'],
  scopes: ['read', 'write'],
});

describe('a refusal on a project outside the token’s fence', () => {
  it('names the project, the permission and the fence', () => {
    runWithPatScope(fencedTo([elsewhere]), () => {
      const refusal = permissionRefusal(unheld, 'project.write', 'superseding a builder run');
      expect(refusal).toMatchObject({ code: 'PERMISSION_FORBIDDEN', permission: 'project.write' });
      expect(refusal?.detail).toContain(`project.write on project ${here}`);
      expect(refusal?.detail).toContain('this token is fenced to other projects');
      expect(refusal?.detail).not.toContain('holds no role');
    });
  });

  it('says the role the caller holds where the fence reaches the project, or no fence stands', () => {
    for (const fence of [[here], null]) {
      runWithPatScope(fencedTo(fence), () => {
        const detail = permissionRefusal(unheld, 'project.write')?.detail ?? '';
        expect(detail).toContain('the caller holds no role there');
        expect(detail).not.toContain('fenced');
      });
    }
  });
});
