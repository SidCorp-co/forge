import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/index.js';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// Every project route takes the project's slug in place of its id, so a slug that a route under
// /api/projects/ spells literally, or that has a uuid's shape, would name a project no route can
// reach by slug. Such a slug is refused by name where a project is created and where it is renamed.

/** The first segments under /api/projects/ the router spells literally, read from the router. */
const literalHeads = () => [
  ...new Set(
    app.routes
      .map((r) => r.path.split('/'))
      .filter((s) => s[1] === 'api' && s[2] === 'projects' && s[3] && !/[:*]/.test(s[3]))
      .map((s) => s[3] as string),
  ),
];

const codes = (r: ApiResponse) =>
  ((r.body as { error?: { refusals?: { code: string }[] } }).error?.refusals ?? []).map(
    (x) => x.code,
  );

const refusedReserved = (r: ApiResponse, slug: string) => {
  expect(r.status, JSON.stringify(r.body)).toBe(422);
  expect(codes(r)).toContain('PROJECT_SLUG_RESERVED');
  expect(JSON.stringify(r.body)).toContain(slug);
};

describe('a project slug no project route could address', () => {
  let token = '';
  let projectId = '';
  let orgId = '';

  beforeAll(async () => {
    const owner = await createTestUser({ verified: true });
    const project = await createTestProject(owner.id);
    await addProjectMember(project.id, owner.id, 'owner');
    await seedProjectDocument(project.id, owner.id, { environments: {} });
    projectId = project.id;
    orgId = project.orgId;
    token = await userToken(owner.id);
  }, 120_000);

  it('reads at least `health` from the router', () => {
    expect(literalHeads()).toContain('health');
  });

  it('is refused by name when a project is created with it', async () => {
    for (const slug of [...literalHeads(), randomUUID()]) {
      refusedReserved(
        await api(token, 'POST', '/api/projects', { slug, name: 'Reserved', orgId }),
        slug,
      );
    }
    const slug = `ok-${randomUUID().slice(0, 8)}`;
    const created = await api(token, 'POST', '/api/projects', { slug, name: 'Addressable', orgId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });

  it('is refused by name when a project is renamed to it', async () => {
    const rename = async (slug: string) => {
      const held = (await api(token, 'GET', `/api/projects/${projectId}/config`)).body as {
        revision: number;
        document: { project: Record<string, unknown> };
      };
      const document = { ...held.document, project: { ...held.document.project, slug } };
      return api(token, 'PUT', `/api/projects/${projectId}/config`, {
        baseRevision: held.revision,
        document,
      });
    };
    for (const slug of [...literalHeads(), `a${randomUUID().slice(1)}`]) {
      refusedReserved(await rename(slug), slug);
    }
    const renamed = await rename(`renamed-${randomUUID().slice(0, 8)}`);
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
  });
});
