/**
 * A credential given through a room agent's secret link reaches the master without passing through
 * chat (ISS-1328 c2, c4): the link opens the Testing settings at one service of the project's testing
 * profile, the page writes the value at that slot's own `secret://` through the project's secrets
 * door, and a run judging with the profile reads it at the testing-profile secrets door, naming the
 * service. Nobody pasted it anywhere: the value is written once, by the person, and read once, by the
 * run. Here the run is a review run a project admin declares over a box, the declared run a master's
 * `run declare` opens; the same door answers both.
 *
 * @direct-test-of packages/core/src/support/secret-link.ts
 * @direct-test-of packages/core/src/project-config/testing-secrets.ts
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { mintPat } from '../../src/credentials/pat.js';
import { workspaceTokenNameFor } from '../../src/credentials/pat-format.js';
import { secretLinkOf } from '../../src/support/secret-link.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// an obvious fake, the value a person types into the page
const GIVEN = 'pgprints-test-secret-not-real-0001';
const REF = 'secret://stg/pgprints';

const world = { admin: '', token: '', projectId: '', slug: '', boxName: '', boxToken: '' };

async function ok(r: Promise<{ status: number; body: unknown }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as Record<string, unknown>;
}

beforeAll(async () => {
  world.admin = (await createTestUser({ verified: true })).id;
  world.token = await userToken(world.admin);
  const project = await createTestProject(world.admin);
  world.projectId = project.id;
  world.slug = project.slug;
  await addProjectMember(project.id, world.admin, 'admin');
  world.boxName = `sid-box-${randomUUID().slice(0, 6)}`;
  const box = await createTestDevice(world.admin, { name: world.boxName });
  await bindTestRunner(project.id, box);
  world.boxToken = (
    await mintPat({
      userId: world.admin,
      name: workspaceTokenNameFor(box, project.id),
      scopes: ['read', 'write'],
      permissions: ['*'],
      projectIds: [project.id],
      deviceId: box,
    })
  ).plaintext;
  // the master declared the slot with a placeholder before any value was given
  await ok(
    api(world.token, 'PUT', `/api/projects/${project.id}/secrets/stg/pgprints`, {
      value: 'placeholder',
    }),
  );
  await ok(
    api(world.token, 'PUT', `/api/projects/${project.id}/testing-profiles/stg`, {
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
        version: 1,
        id: 'stg',
        actors: {},
        services: { pgprints: { access: 'readwrite', credential: REF } },
        limits: [],
      },
    }),
  );
  await seedProjectDocument(project.id, world.admin, {
    defaultBranch: 'main',
    promotions: [{ from: 'dev', to: 'main', via: 'merge' }],
    environments: {
      stg: {
        tier: 'staging',
        deploysFrom: 'dev',
        deployment: { mode: 'external' },
        testing: 'stg',
        url: 'https://stg.example.test',
      },
    },
  });
  await createTestIssue(project.id, world.admin, 7, {
    status: 'in_progress',
    createdAt: new Date(),
  });
}, 120_000);

describe('a credential given through the secret link (ISS-1328)', () => {
  it('is kept at the slot the link names and read by the run at the testing-profile door', async () => {
    const link = new URL(
      secretLinkOf('https://forge.example.test', world.slug, 'stg', { service: 'pgprints' }),
    );
    expect(link.pathname).toBe(`/projects/${world.slug}/settings`);
    const q = link.searchParams;
    expect([q.get('tab'), q.get('profile'), q.get('service')]).toEqual([
      'testing',
      'stg',
      'pgprints',
    ]);

    // the page reads the slot's credential off the profile and writes the value there, once
    const profile = await ok(
      api(world.token, 'GET', `/api/projects/${world.projectId}/testing-profiles/stg`),
    );
    const services = (profile.document as { services: Record<string, { credential: string }> })
      .services;
    const [, scope, name] = /^secret:\/\/([^/]+)\/(.+)$/.exec(
      services[q.get('service') ?? '']?.credential ?? '',
    ) as RegExpExecArray;
    await ok(
      api(world.token, 'PUT', `/api/projects/${world.projectId}/secrets/${scope}/${name}`, {
        value: GIVEN,
      }),
    );

    const run = await ok(
      api(world.token, 'POST', `/api/projects/${world.projectId}/review-runs`, {
        issue: 'ISS-7',
        box: world.boxName,
        profile: 'stg',
      }),
    );
    const read = await api(
      world.boxToken,
      'GET',
      `/api/jobs/${String(run.runId)}/testing-profiles/stg/secrets?service=pgprints`,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect((read.body as { secrets: unknown }).secrets).toEqual([{ ref: REF, value: GIVEN }]);
  });
});
