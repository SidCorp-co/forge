import { describe, expect, it } from 'vitest';
import { PAT_UNGRANTABLE, patPermissionWanted, patPrefixForPath } from '../auth/pat-permissions.js';
import { accessOf } from './access.js';

describe('accessOf', () => {
  it('names for a read the permission the PAT door itself would ask for', () => {
    const access = accessOf('GET', '/api/issues/:id');
    expect(access).toMatchObject({
      door: 'token',
      permission: patPermissionWanted('/api/issues/:id', 'read'),
    });
    expect(access).toMatchObject({ permission: 'issues:read' });
  });

  it('names a write permission for every method that is not a read', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(accessOf(method, '/api/issues/:id')).toMatchObject({ permission: 'issues:write' });
    }
  });

  it('carries the reach of the resource, which tells a project-fenced token from an account one', () => {
    const path = '/api/issues/x';
    expect(accessOf('GET', path)).toMatchObject({ reach: patPrefixForPath(path)?.reach });
  });

  it('answers a path kept out of the grant with its door and reason, never a permission', () => {
    const access = accessOf('GET', '/api/health');
    expect(access).toMatchObject({ door: 'public' });
    expect(access).toMatchObject({
      pattern: '/api/health',
      reason: PAT_UNGRANTABLE['/api/health']?.reason,
    });
    expect(access).not.toHaveProperty('permission');
  });

  it('answers a method-specific exclusion for that method only', () => {
    expect(accessOf('POST', '/api/jobs/:id/complete')).toMatchObject({ door: 'device' });
    expect(accessOf('GET', '/api/jobs/:id')).toMatchObject({ door: 'token' });
  });

  it('answers null for a path in neither list, which no composed route may be', () => {
    expect(accessOf('GET', '/unlisted/route')).toBeNull();
  });
});
