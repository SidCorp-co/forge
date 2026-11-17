// ISS-1104 (FB-553): `GET /api/issues/ISS-1075` on a token fenced to exactly one project was refused
// for want of `?projectId=`, though the key can only mean an issue in that one project. Such a
// token's key resolves there; a session, an unfenced token and a token fenced to several projects
// still name the project, as a key names a row in one project only.
// ISS-1272 (FB-700): the routes under the issue read (`/transition`, `/events`, `/criteria`, …)
// validated `:id` as a uuid, so the key the issue was just read by was refused `Invalid UUID at /id`.
// The key is resolved for every issue route in one place, before routing; a reference naming no
// issue is refused saying what was read and that a route takes a key or a uuid.
// @direct-test-of packages/core/src/issues/issue-route-ref.ts
// @direct-test-of packages/core/src/middleware/route-refs.ts

import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

let userId = '';
let home = '';
let other = '';
let homeIssue = '';
let otherIssue = '';

beforeAll(async () => {
  userId = (await createTestUser({ kind: 'agent' })).id;
  home = (await createTestProject(userId)).id;
  other = (await createTestProject(userId)).id;
  await addProjectMember(home, userId, 'owner');
  await addProjectMember(other, userId, 'owner');
  // the same key in both projects: only the fence says which one is meant
  homeIssue = (await createTestIssue(home, userId, 7, { status: 'open', createdAt: new Date() }))
    .id;
  otherIssue = (await createTestIssue(other, userId, 7, { status: 'open', createdAt: new Date() }))
    .id;
});

describe('a display key read without ?projectId=', () => {
  it('resolves in the one project its token is fenced to', async () => {
    const res = await api(await patToken(userId, [home], 'home run'), 'GET', '/api/issues/ISS-7');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.id).toBe(homeIssue);

    const there = await api(await patToken(userId, [other], 'other run'), 'GET', '/api/issues/7');
    expect(there.status, JSON.stringify(there.body)).toBe(200);
    expect(there.body.id).toBe(otherIssue);
  });

  it('says the key names no issue in that project where it names none', async () => {
    const res = await api(await patToken(userId, [home], 'home miss'), 'GET', '/api/issues/ISS-8');
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(JSON.stringify(res.body)).toContain('names no issue in this project');
  });

  it('still asks a token fenced to several projects which one', async () => {
    const res = await api(
      await patToken(userId, [home, other], 'both'),
      'GET',
      '/api/issues/ISS-7',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toContain('?projectId=<project uuid>');
  });

  it("still asks a person's unfenced token and a session which one", async () => {
    const { plaintext } = await mintPat({ permissions: ['*'], userId, name: 'unfenced' });
    for (const token of [plaintext, await userToken(userId)]) {
      const res = await api(token, 'GET', '/api/issues/ISS-7');
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(JSON.stringify(res.body)).toContain('?projectId=<project uuid>');
    }
  });

  it('keeps ?projectId= deciding where it is named', async () => {
    const res = await api(
      await patToken(userId, [home], 'named'),
      'GET',
      `/api/issues/ISS-7?projectId=${home}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.id).toBe(homeIssue);
  });
});

describe('a display key on the routes under the issue read (ISS-1272)', () => {
  it('is answered on transition, events and criteria as the uuid is, on a token fenced to one project', async () => {
    const token = await patToken(userId, [home], 'sub-routes');
    const planted = await createTestIssue(home, userId, 21, {
      status: 'open',
      createdAt: new Date(),
    });
    for (const sub of ['events', 'criteria']) {
      const byKey = await api(token, 'GET', `/api/issues/ISS-21/${sub}`);
      expect(byKey.status, `${sub} ${JSON.stringify(byKey.body)}`).toBe(200);
      const byId = await api(token, 'GET', `/api/issues/${planted.id}/${sub}`);
      expect(byKey.body).toEqual(byId.body);
    }
    const moved = await api(token, 'POST', '/api/issues/ISS-21/transition', {
      toStatus: 'dropped',
      reason: 'planted to move by its key',
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const read = await api(token, 'GET', `/api/issues/${planted.id}`);
    expect(read.body.status).toBe('dropped');
  });

  it('is answered with ?projectId= on a session too', async () => {
    const res = await api(
      await userToken(userId),
      'GET',
      `/api/issues/ISS-7/criteria?projectId=${other}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('refuses a key with no project to look it up in by name, never a bare Invalid UUID', async () => {
    const res = await api(await userToken(userId), 'GET', '/api/issues/ISS-7/criteria');
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    const said = JSON.stringify(res.body);
    expect(said).toContain('`ISS-7`');
    expect(said).toContain('?projectId=<project uuid>');
    expect(said).not.toContain('Invalid UUID');
  });

  it('refuses a key, a uuid and a reference of neither shape that name no issue, saying what was read', async () => {
    const token = await patToken(userId, [home], 'misses');
    const key = await api(token, 'POST', '/api/issues/ISS-9999/transition', {
      toStatus: 'dropped',
    });
    expect(key.status, JSON.stringify(key.body)).toBe(404);
    expect(JSON.stringify(key.body)).toContain('`ISS-9999` names no issue in this project');

    const nobody = '3f0c2a9e-6a51-4f7e-9d3c-0b6f1e2a7c11';
    const uuid = await api(token, 'GET', `/api/issues/${nobody}/events`);
    expect(uuid.status, JSON.stringify(uuid.body)).toBe(404);
    expect(JSON.stringify(uuid.body)).toContain(`\`${nobody}\` names no issue`);
    expect(JSON.stringify(uuid.body)).toContain('display key');

    const neither = await api(token, 'GET', '/api/issues/not_a_ref/criteria');
    expect(neither.status, JSON.stringify(neither.body)).toBe(400);
    const said = JSON.stringify(neither.body);
    expect(said).toContain('`not_a_ref` is not an issue reference');
    expect(said).toContain('Or a uuid');
    expect(said).not.toContain('Invalid UUID');
  });

  it('says nothing about a reference to a caller who is not signed in', async () => {
    const res = await api(null, 'GET', '/api/issues/ISS-9999/criteria');
    expect(res.status).toBe(401);
  });
});
