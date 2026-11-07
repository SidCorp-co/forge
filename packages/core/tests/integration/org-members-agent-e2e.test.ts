/**
 * An org's members read names an agent by its name and says it is one (ISS-1072 round 2): the org
 * page drew `autoflow.27285ff18a5b@agents.forge.invalid` for the project agent, the address minted
 * only because the column is required. `GET /api/orgs/:orgId/members` now sends each member's `name`
 * and whether it is an `agent`: an agent's handle (its display name, or the handle its minted address
 * carries where an older row has none), a person's display name or else their email.
 *
 * @direct-test-of packages/core/src/orgs/service.ts
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { createTestUser, seedOrg } from '../helpers/factories.js';

interface MemberRow {
  userId: string;
  name: string;
  agent: boolean;
}

describe("an org's members read", () => {
  it('names an agent by its handle and marks it an agent, and a person by their name or email', async () => {
    const owner = await createTestUser({ verified: true, email: `owner-${Date.now()}@test.forge.local` });
    const orgId = await seedOrg(owner.id);
    const named = await createTestUser({ kind: 'agent', email: `autoflow.27285ff18a5b@agents.forge.invalid` });
    await db.execute(sql`UPDATE users SET display_name = 'autoflow' WHERE id = ${named.id}`);
    // an agent minted before its handle was kept as its display name: the handle its address carries
    const older = await createTestUser({ kind: 'agent', email: `hop.7bd530d2f0a4@agents.forge.invalid` });
    const person = await createTestUser({ verified: true });
    await db.execute(sql`UPDATE users SET display_name = 'Lan Pham' WHERE id = ${person.id}`);
    for (const id of [named.id, older.id, person.id]) {
      await db.execute(sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${id}, 'member')`);
    }

    const res = await api(await userToken(owner.id), 'GET', `/api/orgs/${orgId}/members`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body as unknown as MemberRow[];
    const of = (id: string) => rows.find((r) => r.userId === id);
    expect(of(named.id)).toMatchObject({ name: 'autoflow', agent: true });
    expect(of(older.id)).toMatchObject({ name: 'hop', agent: true });
    expect(of(person.id)).toMatchObject({ name: 'Lan Pham', agent: false });
    expect(of(owner.id)).toMatchObject({ name: owner.email, agent: false });
    for (const r of rows.filter((x) => x.agent)) expect(r.name).not.toContain('@');
  });
});
