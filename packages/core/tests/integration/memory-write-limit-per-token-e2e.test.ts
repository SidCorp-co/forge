// ISS-1104 (FB-553): every run of one agent user writes memory on a token of its own, and the write
// limit counted them all in ONE bucket keyed by that user, so a run spending its minute's writes
// refused every other run of the same user. The bucket is the token the caller arrived on; a
// caller with no token (a session) still spends its user's. The number is not raised.
// @direct-test-of packages/core/src/lib/rate-limits.ts
// @direct-test-of packages/core/src/middleware/rate-limit.ts

import { beforeAll, describe, expect, it } from 'vitest';
import { RULES } from '../../src/lib/rate-limits.js';
import { api, patToken, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

describe('the memory write limit', () => {
  let projectId = '';
  let userId = '';

  beforeAll(async () => {
    userId = (await createTestUser({ kind: 'agent' })).id;
    projectId = (await createTestProject(userId)).id;
    await addProjectMember(projectId, userId, 'owner');
  });

  // a body the route refuses 400 still spends a point: the limit runs before the body is read
  const write = (token: string) =>
    api(token, 'POST', `/api/memory/verify?projectId=${projectId}`, { ids: [] });

  it('gives each token of one user a bucket of its own', async () => {
    const max = RULES.memoryWrite.max;
    expect(max).toBe(30);
    const first = await patToken(userId, [projectId], 'run one');
    const second = await patToken(userId, [projectId], 'run two');

    for (let i = 0; i < max; i++) expect((await write(first)).status).not.toBe(429);
    const spent = await write(first);
    expect(spent.status, 'the first token spent its own minute').toBe(429);

    const other = await write(second);
    expect(other.status, JSON.stringify(other.body)).not.toBe(429);
    expect(other.headers.get('X-RateLimit-Remaining')).toBe(String(max - 1));
  });

  it('keys a caller with no token on its user, so two sessions share one bucket', async () => {
    const person = (await createTestUser({ verified: true })).id;
    await addProjectMember(projectId, person, 'member');
    const one = await userToken(person);
    const two = await userToken(person);
    const max = RULES.memoryWrite.max;
    for (let i = 0; i < max; i++) await write(i % 2 === 0 ? one : two);
    expect((await write(two)).status).toBe(429);
  });
});
