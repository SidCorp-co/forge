import { beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
} from '../helpers/factories.js';

// The rail's Needs-you count reads every project the person can see, and every page load asks for
// it. Each project's read asked its access, configuration and prefix again for every list it
// assembled: 105 statements a project, so eight projects held the pool for ~1300 round trips while
// the page's own reads queued behind them. A read request now asks each of those once.

const PER_PROJECT_BOUND = 60;

const queriesOf = (headers: Headers): number => {
  const raw = headers.get('server-timing') ?? '';
  const n = /db;dur=[0-9.]+;desc="(\d+) quer/.exec(raw)?.[1];
  if (n === undefined) throw new Error(`Server-Timing "${raw}" names no query count`);
  return Number(n);
};

async function personWith(projects: number) {
  const owner = await createTestUser({ verified: true });
  const ids: string[] = [];
  for (let p = 0; p < projects; p++) {
    const project = await createTestProject(owner.id);
    await addProjectMember(project.id, owner.id, 'owner');
    ids.push(project.id);
    for (let i = 1; i <= 4; i++) {
      await createTestRequirement(project.id, i, `requirement ${i}`);
      await createTestIssue(project.id, owner.id, i, {
        status: i % 2 ? 'open' : 'in_progress',
        createdAt: new Date(Date.now() - i * 3_600_000),
      });
      await createTestFeedback(project.id, owner.id, i);
    }
  }
  return { token: await userToken(owner.id), ids };
}

describe('a read request asks its repeated lookups once', () => {
  let one: Awaited<ReturnType<typeof personWith>>;
  let three: Awaited<ReturnType<typeof personWith>>;

  beforeAll(async () => {
    one = await personWith(1);
    three = await personWith(3);
  }, 180_000);

  it(`spends at most ${PER_PROJECT_BOUND} statements per project on the cross-project needs-you read`, async () => {
    const a = await api(one.token, 'GET', '/api/me/attention');
    const b = await api(three.token, 'GET', '/api/me/attention');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const perProject = (queriesOf(b.headers) - queriesOf(a.headers)) / 2;
    expect(
      perProject,
      `${queriesOf(a.headers)} at one project, ${queriesOf(b.headers)} at three`,
    ).toBeLessThanOrEqual(PER_PROJECT_BOUND);
  });

  it('reads every project the same rows across as the project read does on its own', async () => {
    const across = await api(three.token, 'GET', '/api/me/attention');
    const rows = across.body.needsYou as { projectSlug: string; area: string; key: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const projects = (await api(three.token, 'GET', '/api/projects')).body as unknown as {
      id: string;
      slug: string;
    }[];
    for (const id of three.ids) {
      const slug = projects.find((p) => p.id === id)?.slug;
      expect(slug, `GET /api/projects lists ${id}`).toBeTruthy();
      const own = await api(three.token, 'GET', `/api/projects/${id}/needs-you`);
      expect(own.status).toBe(200);
      const ownKeys = (own.body.items as { area: string; key: string }[])
        .map((i) => `${i.area}:${i.key}`)
        .sort();
      const acrossKeys = rows
        .filter((r) => r.projectSlug === slug)
        .map((r) => `${r.area}:${r.key}`)
        .sort();
      expect(ownKeys.length).toBeGreaterThan(0);
      expect(acrossKeys).toEqual(ownKeys);
    }
  });
});
