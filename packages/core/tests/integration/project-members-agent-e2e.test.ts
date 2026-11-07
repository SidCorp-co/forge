/**
 * A project's members read names an agent as the org's does (ISS-1072 round 3): Project settings ›
 * People drew `forge.5882f10d89d3@agents.forge.invalid` and `steward.65f7ff153027@…` with no Agent
 * badge after round 2 fixed only the org's read. `GET /api/projects/:id/members` sends each member's
 * `name` and whether it is an `agent`, from the one reading both lists share.
 *
 * @direct-test-of packages/core/src/projects/read.ts
 * @direct-test-of packages/core/src/credentials/agent-account.ts
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

interface MemberRow {
  userId: string;
  name: string;
  agent: boolean;
  email: string;
}

describe("a project's members read", () => {
  it('names an agent by its name with the agent mark, never its minted address, and a person by name or email', async () => {
    const owner = await createTestUser({
      verified: true,
      email: `owner-${Date.now()}@test.forge.local`,
    });
    const project = await createTestProject(owner.id);
    await addProjectMember(project.id, owner.id, 'admin');
    // minted before its handle was kept as its display name: the handle its address carries
    const older = await createTestUser({
      kind: 'agent',
      email: `steward.65f7ff153027@agents.forge.invalid`,
    });
    const named = await createTestUser({
      kind: 'agent',
      email: `forge.5882f10d89d3@agents.forge.invalid`,
    });
    await db.execute(sql`UPDATE users SET display_name = 'forge' WHERE id = ${named.id}`);
    const person = await createTestUser({ verified: true });
    await db.execute(sql`UPDATE users SET display_name = 'Lan Pham' WHERE id = ${person.id}`);
    await addProjectMember(project.id, older.id, 'viewer');
    await addProjectMember(project.id, named.id, 'admin');
    await addProjectMember(project.id, person.id, 'member');

    const res = await api(await userToken(owner.id), 'GET', `/api/projects/${project.id}/members`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body as unknown as MemberRow[];
    const of = (id: string) => rows.find((r) => r.userId === id);
    expect(of(older.id)).toMatchObject({ name: 'steward', agent: true });
    expect(of(named.id)).toMatchObject({ name: 'forge', agent: true });
    expect(of(person.id)).toMatchObject({ name: 'Lan Pham', agent: false });
    expect(of(owner.id)).toMatchObject({ name: owner.email, agent: false });
    for (const r of rows.filter((x) => x.agent)) expect(r.name).not.toContain('@');
  });
});
