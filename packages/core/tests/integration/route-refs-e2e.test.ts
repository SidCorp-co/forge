import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

// A page holds a project's slug and an issue's key before either uuid, so every project route takes
// the slug and every issue route the key with its project. Addressed either way, a route gives the
// same answer to the same caller: the reference is resolved before routing, and the route's own
// gate and access check decide exactly as they do for the uuid.

const MOMENTS = /"(generatedAt|asOf|now)":"[^"]*"/g;
const same = (a: ApiResponse, b: ApiResponse) => {
  const shape = (r: ApiResponse) => ({
    status: r.status,
    body: JSON.parse(JSON.stringify(r.body).replace(MOMENTS, '"$1":"<moment>"')),
  });
  expect(shape(a)).toEqual(shape(b));
};

describe('a project route addressed by its slug', () => {
  let owner = '';
  let outsider = '';
  let projectId = '';
  let slug = '';
  let issue = { id: '', key: '' };

  beforeAll(async () => {
    const o = await createTestUser({ verified: true });
    const stranger = await createTestUser({ verified: true });
    const project = await createTestProject(o.id);
    await addProjectMember(project.id, o.id, 'owner');
    issue = await createTestIssue(project.id, o.id, 7, { status: 'open', createdAt: new Date() });
    projectId = project.id;
    slug = project.slug;
    owner = await userToken(o.id);
    outsider = await userToken(stranger.id);
  }, 120_000);

  const READS = [
    (p: string) => `/api/projects/${p}`,
    (p: string) => `/api/projects/${p}/labels`,
    (p: string) => `/api/projects/${p}/needs-you`,
    (p: string) => `/api/projects/${p}/requirements`,
    (p: string) => `/api/projects/${p}/content-language`,
    (p: string) => `/api/projects/${p}/issues/standing?scope=open`,
    (p: string) => `/api/questions?projectId=${p}`,
  ];

  it('answers a member as the uuid does', async () => {
    for (const path of READS) {
      const byId = await api(owner, 'GET', path(projectId));
      expect(byId.status, `${path(projectId)} ${JSON.stringify(byId.body)}`).toBe(200);
      same(await api(owner, 'GET', path(slug)), byId);
    }
  });

  it('refuses a stranger as the uuid does, and an unsigned caller before anything else', async () => {
    for (const path of READS) {
      const byId = await api(outsider, 'GET', path(projectId));
      expect([403, 404], path(projectId)).toContain(byId.status);
      same(await api(outsider, 'GET', path(slug)), byId);
      const unsigned = await api(null, 'GET', path(slug));
      expect(unsigned.status, path(slug)).toBe(401);
      same(unsigned, await api(null, 'GET', path(projectId)));
    }
  });

  it('writes through the slug under the same gate', async () => {
    const byId = await api(outsider, 'POST', `/api/projects/${projectId}/labels`, {
      name: 'x',
      color: '#ff0000',
    });
    same(
      await api(outsider, 'POST', `/api/projects/${slug}/labels`, { name: 'x', color: '#ff0000' }),
      byId,
    );
    const made = await api(owner, 'POST', `/api/projects/${slug}/labels`, {
      name: 'by-slug',
      color: '#00ff00',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const labels = await api(owner, 'GET', `/api/projects/${projectId}/labels`);
    expect(JSON.stringify(labels.body)).toContain('by-slug');
  });

  it('refuses a slug no project carries by name, once the caller is signed in', async () => {
    const res = await api(owner, 'GET', '/api/projects/no-such-project-here/needs-you');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'PROJECT_SLUG_UNKNOWN' } });
    expect(JSON.stringify(res.body)).toContain('no-such-project-here');
    const query = await api(owner, 'GET', '/api/questions?projectId=no-such-project-here');
    expect(query.body).toMatchObject({ error: { code: 'PROJECT_SLUG_UNKNOWN' } });
    expect((await api(null, 'GET', '/api/projects/no-such-project-here/needs-you')).status).toBe(
      401,
    );
  });

  it('keeps a literal path literal, even where a project carries that word as its slug', async () => {
    const o = await createTestUser({ verified: true });
    const project = await createTestProject(o.id);
    await db.execute(sql`UPDATE projects SET slug = 'health' WHERE id = ${project.id}`);
    const health = await api(owner, 'GET', '/api/projects/health');
    same(health, await api(owner, 'GET', '/api/projects/health'));
    expect(health.status, JSON.stringify(health.body)).toBe(200);
    expect(health.body).not.toHaveProperty('slug', 'health');
  });

  it('says what resolving cost in Server-Timing, and nothing when there was nothing to resolve', async () => {
    const bySlug = await api(owner, 'GET', `/api/projects/${slug}/labels`);
    expect(bySlug.headers.get('server-timing')).toMatch(
      /^ref;dur=[0-9.]+;desc="slug and key lookups", db;dur=/,
    );
    const byId = await api(owner, 'GET', `/api/projects/${projectId}/labels`);
    expect(byId.headers.get('server-timing')).not.toContain('ref;');
  });

  it('ignores a caller who sends the unresolved marker itself', async () => {
    const res = await api(owner, 'GET', `/api/projects/${projectId}/labels`, undefined, {
      'x-forge-unresolved-ref': JSON.stringify({ kind: 'project', slug: 'nope' }),
    });
    expect(res.status).toBe(200);
  });

  describe('an issue route addressed by its key and its project', () => {
    const ISSUE_READS = [
      (i: string, p: string) => `/api/issues/${i}?projectId=${p}`,
      (i: string, p: string) => `/api/issues/${i}/comments?projectId=${p}`,
      (i: string, p: string) => `/api/issues/${i}/activity?limit=50&projectId=${p}`,
      (i: string, p: string) => `/api/issues/${i}/attachments?projectId=${p}`,
      (i: string, p: string) => `/api/issues/${i}/dependencies?projectId=${p}`,
      (i: string, p: string) => `/api/issues/${i}/cost-summary?projectId=${p}`,
      (i: string, p: string) => `/api/issues/${i}/park?projectId=${p}`,
      (i: string, p: string) => `/api/issues/${i}/criteria?projectId=${p}`,
      (i: string, p: string) =>
        i === issue.id
          ? `/api/questions?issueId=${i}`
          : `/api/questions?issueId=${i}&projectId=${p}`,
    ];

    it('answers a member as the uuid does, with the project named either way', async () => {
      for (const path of ISSUE_READS) {
        const byId = await api(owner, 'GET', path(issue.id, projectId));
        expect(byId.status, `${path(issue.id, projectId)} ${JSON.stringify(byId.body)}`).toBe(200);
        same(await api(owner, 'GET', path(issue.key, projectId)), byId);
        same(await api(owner, 'GET', path(issue.key, slug)), byId);
      }
    });

    it('refuses a stranger as the uuid does', async () => {
      for (const path of ISSUE_READS) {
        const byId = await api(outsider, 'GET', path(issue.id, projectId));
        expect([403, 404], path(issue.id, projectId)).toContain(byId.status);
        const byKey = await api(outsider, 'GET', path(issue.key, slug));
        expect([403, 404], `${path(issue.key, slug)} ${JSON.stringify(byKey.body)}`).toContain(
          byKey.status,
        );
        expect(JSON.stringify(byKey.body)).not.toContain(issue.id);
        if (!path(issue.id, projectId).startsWith('/api/questions')) same(byKey, byId);
      }
    });

    it('refuses a key that names no issue by name, and only to a reader of the project', async () => {
      const res = await api(owner, 'GET', `/api/issues/ISS-99999/park?projectId=${slug}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).toContain('`ISS-99999` names no issue in this project');
      const stranger = await api(outsider, 'GET', `/api/issues/ISS-99999/park?projectId=${slug}`);
      same(stranger, await api(outsider, 'GET', `/api/issues/${issue.key}/park?projectId=${slug}`));
    });

    it('still refuses a question list that names an issue uuid and a project both', async () => {
      const res = await api(owner, 'GET', `/api/questions?issueId=${issue.id}&projectId=${slug}`);
      expect(res.status).toBe(400);
    });
  });
});
