/**
 * A revision that leaves its spec out carries the head's, as it carries the kind and the picture;
 * an edit of the open draft that leaves it out keeps the draft's; `{}` still clears it. A revision
 * written without its spec once stored `{}` and silently lost the goal, the personas and the scope.
 * Against real Postgres, through the app's own routes.
 *
 * @direct-test-of packages/core/src/requirements/revision-write.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';

type Res = { status: number; body: Record<string, unknown> };

let projectId: string;
let owner: string;

beforeEach(async () => {
  await truncateAll();
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  owner = await userToken(ownerId);
});

const on = (method: 'POST' | 'PUT', path: string, body: unknown) =>
  api(owner, method, `/api/projects/${projectId}${path}`, body) as Promise<Res>;

const SPEC = {
  goal: 'Problem: nurses miss visits. Value: fewer missed visits. Measure: misses per week.',
  personas: ['Home-care nurse'],
  scopeIn: ['visit reminders'],
};

const specAt = async (key: string, revision: number) =>
  (
    await rows<{ spec: unknown }>(sql`
      SELECT v.spec FROM requirement_revisions v JOIN requirements r ON r.id = v.requirement_id
       WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(key.slice(4))} AND v.revision = ${revision}`)
  )[0]?.spec;

async function proposedAt1(): Promise<string> {
  const made = await on('POST', '/requirements', {
    title: 'Reminders reach the nurse',
    reason: 'nurses miss visits',
    spec: SPEC,
    criteria: [{ body: 'A nurse sees the reminder' }],
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const key = String(made.body.key);
  const proposed = await on('POST', `/requirements/${key}/revisions/1/propose`, {});
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
  const accepted = await on('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'ok' });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  return key;
}

describe('a revision that leaves its spec out', () => {
  it("carries the head's spec onto the new revision", async () => {
    const key = await proposedAt1();
    const r = await on('POST', `/requirements/${key}/revisions`, {
      baseRevision: 1,
      reason: 'a second criterion',
      criteria: [
        { code: 'BC-1', body: 'A nurse sees the reminder' },
        { body: 'A patient opts out' },
      ],
    });
    expect(r.status, JSON.stringify(r.body.error ?? null)).toBe(200);
    expect(await specAt(key, 2), "an omitted spec carries the head's, never {}").toEqual(SPEC);
  });

  it("keeps the draft's own spec on an edit that leaves it out", async () => {
    const key = await proposedAt1();
    const written = await on('POST', `/requirements/${key}/revisions`, {
      baseRevision: 1,
      reason: 'narrow the scope',
      spec: { ...SPEC, scopeIn: ['morning visits'] },
      criteria: [{ code: 'BC-1', body: 'A nurse sees the reminder' }],
    });
    expect(written.status, JSON.stringify(written.body.error ?? null)).toBe(200);
    const edited = await on('PUT', `/requirements/${key}/revisions/2`, {
      reason: 'reworded',
      criteria: [{ code: 'BC-1', body: 'A nurse sees the reminder before the visit' }],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(await specAt(key, 2), "an omitted spec keeps the draft's").toEqual({
      ...SPEC,
      scopeIn: ['morning visits'],
    });
  });

  it('clears it where the write gives {}', async () => {
    const key = await proposedAt1();
    const r = await on('POST', `/requirements/${key}/revisions`, {
      baseRevision: 1,
      reason: 'start the spec over',
      spec: {},
      criteria: [{ code: 'BC-1', body: 'A nurse sees the reminder' }],
    });
    expect(r.status, JSON.stringify(r.body.error ?? null)).toBe(200);
    expect(await specAt(key, 2)).toEqual({});
  });
});
