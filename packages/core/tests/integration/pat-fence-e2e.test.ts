/**
 * FB-48: a personal token's project list is edited by its holder after mint (`PATCH /api/pat/:id`).
 * A box's token and a token core minted keep the reach core set for them: the edit is refused by
 * name, and the list stands as it was.
 */

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { personalAccessTokens } from '../../src/db/schema.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';

let ownerId = '';
let first = '';
let second = '';
let session = '';

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  first = (await createTestProject(ownerId)).id;
  second = (await createTestProject(ownerId)).id;
  await addProjectMember(first, ownerId, 'owner');
  await addProjectMember(second, ownerId, 'owner');
  session = await userToken(ownerId);
  await db.execute(sql`UPDATE users SET last_fresh_auth_at = now() WHERE id = ${ownerId}`);
});

const mint = async (name: string) =>
  (await mintPat({ permissions: ['*'], userId: ownerId, name, projectIds: [first] })).row.id;

const fenceOf = async (id: string) =>
  (
    await db
      .select({ projectIds: personalAccessTokens.projectIds })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, id))
  )[0]?.projectIds;

const refit = (id: string) => api(session, 'PATCH', `/api/pat/${id}`, { projectIds: [first, second] });

describe('editing a token project list (FB-48)', () => {
  it('replaces the list of a personal token its holder minted', async () => {
    const id = await mint('laptop');

    const res = await refit(id);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await fenceOf(id)).toEqual([first, second]);
  });

  it('refuses a token core minted, naming it, and keeps its list', async () => {
    const id = await mint('script read project-sync');

    const res = await refit(id);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('PAT_REFUSED');
    expect(JSON.stringify(res.body)).toContain('one core minted');
    expect(await fenceOf(id)).toEqual([first]);
  });

  it("refuses a box's token by name instead of answering not found", async () => {
    const id = await mint('box token');
    const device = await createTestDevice(ownerId);
    await db
      .update(personalAccessTokens)
      .set({ deviceId: device })
      .where(eq(personalAccessTokens.id, id));

    const res = await refit(id);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('PAT_REFUSED');
    expect(JSON.stringify(res.body)).toContain("a box's");
    expect(await fenceOf(id)).toEqual([first]);
  });
});
