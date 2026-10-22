/**
 * An issue serves one requirement, so linking one another requirement holds is refused
 * REQUIREMENT_ISSUE_LINKED_ELSEWHERE. The refusal said "unlink it there first" and named no way to:
 * the catalog-api master stopped there on dev, 2026-10-22. It names the unlink route, and that route
 * does what it says.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, makeAgreeReady } from '../helpers/factories.js';

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);

async function agreed(title: string): Promise<string> {
  const key = ok(
    await as('POST', '/requirements', {
      title,
      reason: 'the rule it states',
      criteria: [{ body: 'A saved board shows every card it had.' }],
    }),
    201,
  ).key as string;
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
  ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'BA review' }));
  ok(await as('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'owner signed r1' }));
  return key;
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  say = requester(app, { owner: await signUserToken(ownerId) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('an issue another requirement holds', () => {
  it('is refused naming the route that unlinks it there, and that route frees it', async () => {
    const held = await agreed('The board keeps its cards');
    const wanted = await agreed('The board exports its cards');
    const issue = ok(await as('POST', '/issues', { title: 'Save the cards' }), 201)
      .displayId as string;
    ok(await as('POST', `/requirements/${held}/issues`, { issue }));

    const refused = await as('POST', `/requirements/${wanted}/issues`, { issue });
    expect(refused.status, JSON.stringify(refused.json)).toBe(422);
    const refusal = ((refused.json.error as Doc).refusals as Doc[])[0] as Doc;
    expect(refusal.code).toBe('REQUIREMENT_ISSUE_LINKED_ELSEWHERE');
    const route = `DELETE /api/projects/:id/requirements/${held}/issues/${issue}`;
    expect(refusal.detail).toContain(route);

    ok(await as('DELETE', `/requirements/${held}/issues/${issue}`));
    ok(await as('POST', `/requirements/${wanted}/issues`, { issue }));
  });
});
