// ISS-1104 (FB-553): `GET /api/issues/ISS-1075` on a token fenced to exactly one project was refused
// for want of `?projectId=`, though the key can only mean an issue in that one project. Such a
// token's key resolves there; a session, an unfenced token and a token fenced to several projects
// still name the project, as a key names a row in one project only.
// @direct-test-of packages/core/src/issues/issue-route-ref.ts

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
  otherIssue = (
    await createTestIssue(other, userId, 7, { status: 'open', createdAt: new Date() })
  ).id;
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
    const res = await api(await patToken(userId, [home, other], 'both'), 'GET', '/api/issues/ISS-7');
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
