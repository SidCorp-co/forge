import { beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

// Every response says what the origin spent on it and how much of that was the database, so a
// person's wait splits into the network's share and the server's without a log to read.

interface Timing {
  db: number;
  queries: number;
  app: number;
  total: number;
}

function timingOf(headers: Headers): Timing {
  const raw = headers.get('server-timing');
  if (!raw) throw new Error('the response carries no Server-Timing header');
  const dur = (name: string) => {
    const m = new RegExp(`(?:^|, )${name};dur=([0-9.]+)`).exec(raw);
    if (!m?.[1]) throw new Error(`Server-Timing "${raw}" names no ${name} duration`);
    return Number(m[1]);
  };
  const queries = /db;dur=[0-9.]+;desc="(\d+) quer/.exec(raw)?.[1];
  if (queries === undefined) throw new Error(`Server-Timing "${raw}" names no query count`);
  return { db: dur('db'), queries: Number(queries), app: dur('app'), total: dur('total') };
}

describe('Server-Timing', () => {
  let token = '';
  let projectId = '';

  beforeAll(async () => {
    const owner = await createTestUser({ verified: true });
    const project = await createTestProject(owner.id);
    await addProjectMember(project.id, owner.id, 'owner');
    projectId = project.id;
    token = await userToken(owner.id);
  }, 120_000);

  it('reports a route that reads nothing as no queries and no database time', async () => {
    const res = await api(null, 'GET', '/api/version');
    expect(res.status).toBe(200);
    const t = timingOf(res.headers);
    expect(t).toMatchObject({ queries: 0, db: 0 });
    expect(t.total).toBeGreaterThanOrEqual(0);
  });

  it('counts the statements an authenticated read sends, inside its total', async () => {
    const res = await api(token, 'GET', `/api/projects/${projectId}/labels`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const t = timingOf(res.headers);
    expect(t.queries).toBeGreaterThan(0);
    expect(t.db).toBeGreaterThan(0);
    expect(t.db).toBeLessThanOrEqual(t.total);
    expect(t.app + t.db).toBeCloseTo(t.total, 0);
  });

  it('counts the statements of a refused request too', async () => {
    const res = await api(
      token,
      'GET',
      '/api/projects/00000000-0000-4000-8000-000000000000/labels',
    );
    expect(res.status).toBe(404);
    expect(timingOf(res.headers).queries).toBeGreaterThan(0);
  });

  it('lets an allowed page read it cross-origin, and no other', async () => {
    const allowed = await api(null, 'GET', '/api/version', undefined, {
      origin: 'http://localhost:3000',
    });
    expect(allowed.headers.get('timing-allow-origin')).toBe('http://localhost:3000');
    expect(allowed.headers.get('access-control-expose-headers') ?? '').toMatch(/Server-Timing/i);
    const stranger = await api(null, 'GET', '/api/version', undefined, {
      origin: 'https://elsewhere.example',
    });
    expect(stranger.headers.get('timing-allow-origin')).toBeNull();
  });
});
