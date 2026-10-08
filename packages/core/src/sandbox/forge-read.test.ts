import { describe, expect, it } from 'vitest';
import { readRefusal } from './forge-read.js';

// Which reads the host refuses before any request (REQ-37 BC-2, BC-7): anything but a GET on the
// run's own project, refused by name, naming the method or the path.

const P = '0b6f1c1e-8d2a-4c3e-9f10-2a7b5c4d3e21';
const OTHER = '7d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5e';

describe('a read the host lets through', () => {
  it.each([
    `/api/projects/${P}`,
    `/api/projects/${P}/requirements`,
    `/api/projects/${P}/requirements/REQ-3?revision=2`,
    `/api/projects/${P}/issues?status=open`,
    '/api/issues/ISS-12',
    '/api/issues/5a1d9c2e-0f3b-4e6a-8c7d-1b2a3c4d5e6f/comments',
  ])('GET %s', (path) => {
    expect(readRefusal('GET', path, P)).toBeNull();
    expect(readRefusal('get', path, P)).toBeNull();
  });
});

describe('a read the host refuses by name', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s, naming the method', (method) => {
    const why = readRefusal(method, `/api/projects/${P}/requirements`, P);
    expect(why).toMatch(/^SCRIPT_READ_REFUSED: /);
    expect(why).toContain(`${method} /api/projects/${P}/requirements is refused`);
    expect(why).toContain('GET only');
  });

  it.each([
    `/api/projects/${OTHER}/requirements`,
    `/api/projects/${P}x/requirements`,
    '/api/issues',
    `/api/issues?projectId=${P}`,
    '/api/admin/users',
    '/api/me',
    `/api/projects/${P}/../${OTHER}`,
    `/api/projects/${P}/%2e%2e/${OTHER}`,
    `/api/projects/${P}/a?b=1?c=2`,
    `http://evil.example/api/projects/${P}`,
    `//evil.example/api/projects/${P}`,
    `/api/projects/${P}\\..\\${OTHER}`,
    '',
  ])('GET %s, naming the path', (path) => {
    const why = readRefusal('GET', path, P);
    expect(why).toMatch(/^SCRIPT_READ_REFUSED: /);
    expect(why).toContain(`GET ${path} is refused`);
    expect(why).toContain(`/api/projects/${P}/...`);
  });
});
