/**
 * REQ-29: a project's business areas and a requirement's place in them, through the REST doors. An
 * area a requirement holds is never deleted from under it in silence, and a placement write that
 * names nothing is refused rather than answered.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

let projectId: string;
let token: string;

beforeEach(async () => {
  await truncateAll();
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
});

let seq = 0;
async function requirement(): Promise<string> {
  seq += 1;
  const id = randomUUID();
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO requirements (id, project_id, req_seq, title, status)
      VALUES (${id}, ${projectId}, ${seq}, ${`requirement ${seq}`}, 'draft')
    `),
  );
  return `REQ-${seq}`;
}

const setAreas = (names: string[]) =>
  api(token, 'PUT', `/api/projects/${projectId}/requirement-areas`, { names });

const place = (key: string, body: Record<string, unknown>) =>
  api(token, 'PUT', `/api/projects/${projectId}/requirements/${key}/placement`, body);

type Area = { id: string; name: string };
const areasOf = (res: ApiResponse) => res.body.areas as Area[];

function refusalCodes(res: ApiResponse): string[] {
  const listed = (res.body.error as { refusals?: Array<{ code: string }> } | undefined)?.refusals;
  return listed?.map((r) => r.code) ?? [String(res.body.code)];
}

async function areaOfRequirement(key: string): Promise<string | null> {
  const [row] = await rows<{ area_id: string | null }>(sql`
    SELECT area_id FROM requirements WHERE project_id = ${projectId} AND req_seq = ${Number(key.slice(4))}
  `);
  return row?.area_id ?? null;
}

describe('the area list (REQ-29)', () => {
  it('refuses to drop an area a requirement holds, naming the requirement, and changes nothing', async () => {
    const billing = areasOf(await setAreas(['Billing', 'Search'])).find((a) => a.name === 'Billing');
    const key = await requirement();
    expect((await place(key, { areaId: billing?.id })).status).toBe(200);

    const res = await setAreas(['Search']);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(refusalCodes(res)).toEqual(['REQUIREMENT_AREA_IN_USE']);
    expect(JSON.stringify(res.body)).toContain(`${key} (Billing)`);
    expect(await areaOfRequirement(key)).toBe(billing?.id);
    const listed = await api(token, 'GET', `/api/projects/${projectId}/requirement-areas`);
    expect(areasOf(listed).map((a) => a.name)).toEqual(['Billing', 'Search']);
  });

  it('renames an area in place on a change of case, so its requirements keep it', async () => {
    const billing = areasOf(await setAreas(['billing'])).find((a) => a.name === 'billing');
    const key = await requirement();
    await place(key, { areaId: billing?.id });

    const res = await setAreas(['Billing', 'Search']);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(areasOf(res)).toEqual([
      { id: billing?.id, name: 'Billing' },
      { id: expect.any(String), name: 'Search' },
    ]);
    expect(await areaOfRequirement(key)).toBe(billing?.id);
  });

  it('drops an area no requirement holds', async () => {
    await setAreas(['Billing', 'Search']);

    const res = await setAreas(['Search']);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(areasOf(res).map((a) => a.name)).toEqual(['Search']);
  });

  it('refuses a list naming one area twice', async () => {
    const res = await setAreas(['Billing', 'billing']);

    expect(res.status).toBe(422);
    expect(refusalCodes(res)).toEqual(['REQUIREMENT_AREA_DUPLICATE']);
  });
});

describe('a requirement placement (REQ-29)', () => {
  it('refuses a body naming neither field', async () => {
    const key = await requirement();

    const res = await place(key, {});

    expect(res.status).toBe(400);
  });

  it('refuses an area of no list and a short name over six words', async () => {
    const key = await requirement();

    const unknown = await place(key, { areaId: randomUUID() });
    const long = await place(key, { shortName: 'one two three four five six seven' });

    expect(refusalCodes(unknown)).toEqual(['REQUIREMENT_AREA_UNKNOWN']);
    expect(refusalCodes(long)).toEqual(['REQUIREMENT_SHORT_NAME_TOO_LONG']);
    expect(await areaOfRequirement(key)).toBeNull();
  });
});
