import { describe, expect, it } from 'vitest';
import {
  PAT_UNGRANTABLE,
  patPermissionWanted,
  patPrefixForPath,
} from '../../auth/pat-permissions.js';
import { accessOf, accessProse, asksForBearer } from './access.js';

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

describe('asksForBearer', () => {
  it('asks for none at a door that takes none, whatever the gates read', () => {
    for (const path of ['/api/health', '/api/uploads/:id', '/api/webhooks/in/:slug']) {
      expect(asksForBearer(accessOf('POST', path), true)).toBe(false);
    }
  });

  it('asks where a gate reads one, and not where none does, behind a session or a box door', () => {
    expect(asksForBearer(accessOf('POST', '/api/devices/heartbeat'), true)).toBe(true);
    expect(asksForBearer(accessOf('POST', '/api/devices/login/init'), false)).toBe(false);
    expect(asksForBearer(accessOf('POST', '/api/auth/local'), false)).toBe(false);
    expect(asksForBearer(accessOf('GET', '/api/issues/:id'), true)).toBe(true);
  });

  it('asks on the MCP door by name, and never for a route with no access', () => {
    expect(asksForBearer(accessOf('POST', '/mcp'), false)).toBe(true);
    expect(asksForBearer(null, true)).toBe(false);
  });
});

describe('accessProse', () => {
  it('says the permission a token must be granted, and how far its reach goes', () => {
    expect(accessProse(accessOf('GET', '/api/issues/:id'), true)).toBe(
      '**Permission:** `issues:read`. A personal or agent token must be granted it. A token fenced to projects can use this route.',
    );
    expect(accessProse(accessOf('GET', '/api/invitations/:token'), true)).toContain(
      "Only a token that carries its owner's whole reach",
    );
  });

  it('says the door of an exclusion with its reason and the way in, as sentences', () => {
    const prose = accessProse(accessOf('POST', '/api/pat'), true);
    expect(prose).toContain('**Door:** `session`.');
    expect(prose).toContain('No permission grants a token this route.');
    expect(prose).toContain('Use a session (browser/desktop login).');
    expect(prose).not.toContain('Bearer:');
  });

  it('says that a route reads no bearer where none is read, and nothing of the kind for a public one', () => {
    expect(accessProse(accessOf('POST', '/api/devices/login/init'), false)).toContain(
      '**Bearer:** not read. This route takes no bearer token; any other credential it reads is named in its inputs.',
    );
    expect(accessProse(accessOf('GET', '/api/health'), false)).not.toContain('Bearer:');
  });

  it('says no bearer is read, never that no credential is, where the route reads a cookie or a body', () => {
    const prose = accessProse(accessOf('POST', '/api/auth/refresh'), false);
    expect(prose).toContain('**Bearer:** not read.');
    expect(prose).not.toMatch(/no credential|Credential/);
  });

  it('says nothing for a route with no access, which the check names instead', () => {
    expect(accessProse(null, false)).toBe('');
  });
});
