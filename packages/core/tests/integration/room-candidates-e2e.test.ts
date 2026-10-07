/**
 * "Add person" offers everybody who holds a role on the room's project, however they hold it (dev QA
 * 2026-10-07: on project forge the panel said "There is nobody left to add" while a person held a
 * role on the project as its member and not through its organisation, so a group room could not be
 * made from the web at all). Adding them is what makes the room a group.
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

const { db } = await import('../../src/db/client.js');
const { api, userToken } = await import('../helpers/api.js');
const { addProjectMember, createTestProject, createTestUser } = await import(
  '../helpers/factories.js'
);

let projectId = '';
let owner = '';
let ownerToken = '';
let member = '';
let stranger = '';

beforeAll(async () => {
  owner = (await createTestUser({ verified: true })).id;
  ownerToken = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  member = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, member, 'member');
  stranger = (await createTestUser({ verified: true })).id;
});

type Candidates = { people: { userId: string }[] };

describe('who a room may still take in', () => {
  it('offers a project member who is in no organisation of the project', async () => {
    const [orgRow] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM organization_members om JOIN projects p ON p.org_id = om.org_id WHERE p.id = ${projectId} AND om.user_id = ${member}`,
    )) as unknown as { n: number }[];
    expect(orgRow?.n, 'the member holds the project through the project alone').toBe(0);

    const opened = await api(ownerToken, 'POST', '/api/conversations', {
      projectId,
      title: 'group room',
      people: [],
    });
    expect(opened.status).toBe(201);
    const roomId = (opened.body as { id: string }).id;
    const res = await api(ownerToken, 'GET', `/api/conversations/${roomId}/candidates`);
    expect(res.status).toBe(200);
    const people = (res.body as unknown as Candidates).people.map((p) => p.userId);
    expect(people).toContain(member);
    expect(people, 'somebody with no role on the project is never offered').not.toContain(stranger);
    expect(people, 'nobody already in the room is offered').not.toContain(owner);

    const added = await api(ownerToken, 'POST', `/api/conversations/${roomId}/people`, {
      userId: member,
    });
    expect(added.status).toBe(201);
    expect((added.body as { shape: string }).shape).toBe('group');
  });
});
