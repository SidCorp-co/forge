/**
 * ISS-832 (from FB-411): a `feedback_triage` proposal made while an item was new went stale when the
 * item was triaged by another act, and its accept triaged the item a second time and wrote a second
 * decision. A triage or decline retires the item's other pending triage proposals, and an accept of
 * one made before the item's latest triage is refused SUGGESTION_BASE_STALE and marked stale.
 *
 * @direct-test-of packages/core/src/feedback/triage.ts
 * @direct-test-of packages/core/src/feedback/triaged-since.ts
 * @direct-test-of packages/core/src/suggestions/write.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';

let projectId: string;
let token: string;

beforeEach(async () => {
  await truncateAll();
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
});

const on = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

async function ok(r: Promise<{ status: number; body: Doc }>, status?: number): Promise<Doc> {
  const res = await r;
  if (status === undefined) expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  else expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}

async function refused(r: Promise<{ status: number; body: Doc }>): Promise<Doc[]> {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
  return res.body.error.refusals as Doc[];
}

const fileBug = async (title: string) =>
  (await ok(on('POST', '/feedback', { kind: 'bug', title, screen: 'The board' }), 201)).feedback
    .key as string;

const ANSWERS = {
  criterion: 'none',
  severity: 'medium',
  reproduced: 'Saved twice, both cards gone.',
};
const route = { route: 'issue', note: 'the save bug', answers: ANSWERS };

const propose = async (fb: string) =>
  (
    await ok(
      on('POST', '/suggestions', {
        kind: 'feedback_triage',
        feedback: fb,
        baseRevision: null,
        payload: route,
      }),
      201,
    )
  ).suggestion.id as string;

const statusOf = async (id: string) =>
  (
    (await db.execute(sql`SELECT status FROM suggestions WHERE id = ${id}`)) as unknown as {
      status: string;
    }[]
  )[0]?.status;

const decisionsOf = async (fb: string) =>
  (await db.execute(sql`
    SELECT d.decision FROM feedback_decisions d JOIN feedback f ON f.id = d.feedback_id
     WHERE f.project_id = ${projectId} AND f.fb_seq = ${Number(fb.slice(3))}
       AND d.decision IN ('triaged', 'declined')
  `)) as unknown as { decision: string }[];

describe('a triage retires the item’s pending triage proposals (ISS-832)', () => {
  it('stales a proposal when the item is routed directly, and refuses its accept with one decision on the item', async () => {
    const fb = await fileBug('Cards vanish on save');
    const proposed = await propose(fb);
    await ok(on('POST', `/feedback/${fb}/triage`, route));
    expect(await statusOf(proposed)).toBe('stale');
    const refusals = await refused(on('POST', `/suggestions/${proposed}/accept`, { reason: 'ok' }));
    expect(refusals.map((r) => r.code)).toContain('SUGGESTION_BASE_STALE');
    expect(await decisionsOf(fb)).toHaveLength(1);
  });

  it('stales a proposal when the item is declined directly', async () => {
    const fb = await fileBug('Cards vanish on save');
    const proposed = await propose(fb);
    await ok(on('POST', `/feedback/${fb}/triage`, { route: 'decline', note: 'Not planned.' }));
    expect(await statusOf(proposed)).toBe('stale');
    expect(await decisionsOf(fb)).toEqual([{ decision: 'declined' }]);
  });

  it('refuses at accept a proposal made before the item’s triage, which the write did not retire', async () => {
    const fb = await fileBug('Cards vanish on save');
    await ok(on('POST', `/feedback/${fb}/triage`, route));
    // a proposal that stands from before the triage: proposed, and older than the item's decision
    const proposed = await propose(fb);
    await db.execute(
      sql`UPDATE suggestions SET created_at = now() - interval '1 hour' WHERE id = ${proposed}`,
    );
    expect(await statusOf(proposed)).toBe('proposed');
    const refusals = await refused(on('POST', `/suggestions/${proposed}/accept`, { reason: 'ok' }));
    expect(refusals.map((r) => [r.code, r.path])).toEqual([['SUGGESTION_BASE_STALE', '/target']]);
    expect(refusals[0]?.detail).toMatch(/^FB-\d+ was triaged as issue at /);
    expect(refusals[0]?.detail).toContain('propose again only if a different route is wanted');
    expect(await statusOf(proposed)).toBe('stale');
    expect(await decisionsOf(fb)).toHaveLength(1);
  });

  it('still triages the item on the accept of a proposal on a new item, which reads accepted', async () => {
    const fb = await fileBug('Cards vanish on save');
    const proposed = await propose(fb);
    await ok(on('POST', `/suggestions/${proposed}/accept`, { reason: 'ok' }));
    expect((await ok(on('GET', `/feedback/${fb}`))).feedback.status).toBe('triaged');
    expect(await statusOf(proposed)).toBe('accepted');
    expect(await decisionsOf(fb)).toHaveLength(1);
  });
});
