/**
 * A project secret can be removed (ISS-847: agenfold's revoked `secret://production/agenfold-channel-reader`
 * stayed listed beside the live ones, since a secret could only be overwritten). DELETE takes the
 * PUT's rule, project.admin; a secret a testing profile still names is refused by name, naming each
 * profile; an unknown one is refused, never answered 200 with nothing done; the removal is written
 * to the project's credential audit naming who removed which ref, and no value. Against real Postgres.
 *
 * @direct-test-of packages/core/src/project-config/routes.ts
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

const VALUE = 'REVOKED-but-still-a-value-9f2c';
const w = { projectId: '', owner: '', member: '', ownerId: '' };
const path = (scope: string, name: string) => `/api/projects/${w.projectId}/secrets/${scope}/${name}`;
const listed = async () => {
  const got = await api(w.owner, 'GET', `/api/projects/${w.projectId}/secrets`);
  expect(got.status).toBe(200);
  return (got.body.secrets as { ref: string }[]).map((s) => s.ref);
};

beforeAll(async () => {
  const owner = await createTestUser({ verified: true });
  const member = await createTestUser({ verified: true });
  w.ownerId = owner.id;
  w.projectId = (await createTestProject(owner.id)).id;
  await addProjectMember(w.projectId, owner.id, 'owner');
  await addProjectMember(w.projectId, member.id, 'member');
  w.owner = await userToken(owner.id);
  w.member = await userToken(member.id);
  for (const name of ['channel-reader', 'stg-admin']) {
    const put = await api(w.owner, 'PUT', path(name === 'stg-admin' ? 'test' : 'production', name), { value: VALUE });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  }
  const profile = await api(w.owner, 'PUT', `/api/projects/${w.projectId}/testing-profiles/stg`, {
    baseRevision: null,
    document: {
      $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
      version: 1,
      id: 'stg',
      actors: { admin: { role: 'project-admin', credential: 'secret://test/stg-admin' } },
      services: {},
      limits: [],
    },
  });
  expect(profile.status, JSON.stringify(profile.body)).toBeLessThan(300);
});

describe('DELETE /api/projects/:id/secrets/:scope/:name (ISS-847)', () => {
  it('refuses a member who does not hold project.admin, and removes nothing', async () => {
    const got = await api(w.member, 'DELETE', path('production', 'channel-reader'));
    expect(got.status).toBe(403);
    expect(await listed()).toContain('secret://production/channel-reader');
  });

  it('removes a secret no profile names, lists it no more, and records who removed which ref', async () => {
    const got = await api(w.owner, 'DELETE', path('production', 'channel-reader'));
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body).toEqual({ deleted: 'secret://production/channel-reader' });
    expect(await listed()).not.toContain('secret://production/channel-reader');
    const audit = await api(w.owner, 'GET', `/api/projects/${w.projectId}/variables/events`);
    expect(audit.status).toBe(200);
    const events = audit.body.events as Record<string, unknown>[];
    expect(events).toContainEqual(
      expect.objectContaining({
        act: 'deleted',
        key: 'secret://production/channel-reader',
        actor: w.ownerId,
        agency: 'human',
      }),
    );
    expect(JSON.stringify(audit.body)).not.toContain(VALUE);
  });

  it('refuses a secret no longer held by name, never a 200 that did nothing', async () => {
    const got = await api(w.owner, 'DELETE', path('production', 'channel-reader'));
    expect(got.status).toBe(404);
    expect(JSON.stringify(got.body)).toContain('SECRET_NOT_FOUND');
    expect(JSON.stringify(got.body)).toContain('secret://production/channel-reader');
  });

  it('refuses a secret a testing profile names, naming the profile, and keeps it', async () => {
    const got = await api(w.owner, 'DELETE', path('test', 'stg-admin'));
    expect(got.status).toBe(422);
    const refusals = (got.body.error as { refusals: { code: string; path: string; detail: string }[] }).refusals;
    expect(refusals).toEqual([
      expect.objectContaining({ code: 'SECRET_IN_USE', path: '/testing-profiles/stg' }),
    ]);
    expect(refusals[0]?.detail).toContain('secret://test/stg-admin');
    expect(await listed()).toContain('secret://test/stg-admin');
  });

  it('refuses the variables’ own scope and a name that is no secret name', async () => {
    const reserved = await api(w.owner, 'DELETE', path('var', 'anything'));
    expect(reserved.status).toBe(422);
    expect(JSON.stringify(reserved.body)).toContain('SECRET_SCOPE_RESERVED');
    const bad = await api(w.owner, 'DELETE', path('production', 'Not_A_Name'));
    expect(bad.status).toBe(400);
  });
});
