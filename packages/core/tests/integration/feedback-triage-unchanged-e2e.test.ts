/**
 * ISS-833 (from FB-411): a triage naming the route and carriers an item already stands on wrote a
 * third identical decision and moved the item's standing `since` past the master's answer. It is
 * refused FEEDBACK_TRIAGE_UNCHANGED at a direct triage, at a proposal and at an accept, and writes
 * nothing; a re-route, a new item and a reopened item are still triaged.
 *
 * @direct-test-of packages/core/src/feedback/triage-unchanged.ts
 * @direct-test-of packages/core/src/feedback/triage.ts
 * @direct-test-of packages/core/src/suggestions/propose.ts
 * @direct-test-of packages/core/src/suggestions/write.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
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

const fileIssue = async (title: string) =>
  (await ok(on('POST', '/issues', { title }), 201)).displayId as string;

const ANSWERS = {
  criterion: 'none',
  severity: 'medium',
  reproduced: 'Saved twice, both cards gone.',
};
const routeTo = (issue: string) => ({
  route: 'issue',
  issue,
  note: 'the save bug',
  answers: ANSWERS,
});
const triage = (fb: string, body: unknown) => on('POST', `/feedback/${fb}/triage`, body);

const propose = (fb: string, payload: unknown) =>
  on('POST', '/suggestions', {
    kind: 'feedback_triage',
    feedback: fb,
    baseRevision: null,
    payload,
  });

const statusOf = async (id: string) =>
  (
    (await db.execute(sql`SELECT status FROM suggestions WHERE id = ${id}`)) as unknown as {
      status: string;
    }[]
  )[0]?.status;

const decisionCount = async (fb: string) =>
  (
    (await db.execute(sql`
      SELECT count(*)::int AS n FROM feedback_decisions d JOIN feedback f ON f.id = d.feedback_id
       WHERE f.project_id = ${projectId} AND f.fb_seq = ${Number(fb.slice(3))}
         AND d.decision = 'triaged'
    `)) as unknown as { n: number }[]
  )[0]?.n;

const sinceOf = async (fb: string): Promise<string> => {
  const list = await ok(on('GET', '/feedback'));
  return list.feedback.find((f: Doc) => f.key === fb).times.since as string;
};

async function triagedOn(title: string) {
  const fb = await fileBug(title);
  const iss = await fileIssue(`carrier of ${title}`);
  await ok(triage(fb, routeTo(iss)));
  return { fb, iss };
}

describe('an unchanged re-triage is refused and writes nothing (ISS-833)', () => {
  it('refuses a direct re-triage onto the same route and carrier, leaving one decision and the same since', async () => {
    const { fb, iss } = await triagedOn('Cards vanish on save');
    const since = await sinceOf(fb);
    const refusals = await refused(triage(fb, routeTo(iss)));
    expect(refusals.map((r) => r.code)).toEqual(['FEEDBACK_TRIAGE_UNCHANGED']);
    expect(refusals[0]?.detail).toContain(fb);
    expect(refusals[0]?.detail).toContain(iss);
    expect(refusals[0]?.detail).toContain('nothing was written');
    expect(await decisionCount(fb)).toBe(1);
    expect(await sinceOf(fb)).toBe(since);
  });

  it('refuses an identical proposal at write', async () => {
    const { fb, iss } = await triagedOn('Cards vanish on save');
    const since = await sinceOf(fb);
    const refusals = await refused(propose(fb, routeTo(iss)));
    expect(refusals.map((r) => r.code)).toEqual(['FEEDBACK_TRIAGE_UNCHANGED']);
    expect(await sinceOf(fb)).toBe(since);
  });

  it('refuses at accept an identical proposal already standing, and reads it stale', async () => {
    const fb = await fileBug('Cards vanish on save');
    const iss = await fileIssue('carrier');
    // proposed while the item was new, so the write let it through
    const id = (await ok(propose(fb, routeTo(iss)), 201)).suggestion.id as string;
    await ok(triage(fb, routeTo(iss)));
    // the triage retired it; stand it up again as the one proposed after, older than no decision
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE suggestions SET status = 'proposed', decided_at = NULL, reason = NULL WHERE id = ${id}`,
      ),
    );
    await db.execute(
      sql`UPDATE suggestions SET created_at = now() + interval '1 hour' WHERE id = ${id}`,
    );
    const since = await sinceOf(fb);
    const refusals = await refused(on('POST', `/suggestions/${id}/accept`, { reason: 'ok' }));
    expect(refusals.map((r) => r.code)).toEqual(['SUGGESTION_BASE_STALE']);
    expect(refusals[0]?.detail).toContain('nothing was written');
    expect(await statusOf(id)).toBe('stale');
    expect(await decisionCount(fb)).toBe(1);
    expect(await sinceOf(fb)).toBe(since);
  });
});

describe('a triage that changes something is still taken (ISS-833)', () => {
  it('re-routes a triaged item to a different carrier', async () => {
    const { fb } = await triagedOn('Cards vanish on save');
    const other = await fileIssue('another carrier');
    await ok(triage(fb, routeTo(other)));
    expect(await decisionCount(fb)).toBe(2);
  });

  it('re-routes a triaged item to a different route', async () => {
    const { fb } = await triagedOn('Cards vanish on save');
    await ok(triage(fb, { route: 'answer', answer: 'Works as designed.', answers: ANSWERS }));
    expect(await decisionCount(fb)).toBe(2);
  });

  it('triages a new item onto a carrier', async () => {
    const fb = await fileBug('Cards vanish on save');
    await ok(triage(fb, routeTo(await fileIssue('carrier'))));
    expect(await decisionCount(fb)).toBe(1);
  });

  it('triages a reopened item onto the carrier it stood on', async () => {
    const { fb, iss } = await triagedOn('Cards vanish on save');
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE feedback SET status = 'reopened' WHERE fb_seq = ${Number(fb.slice(3))} AND project_id = ${projectId}`,
      ),
    );
    // the reporter's reopen: the decision a reopened item's answer is held against
    await db.execute(sql`
      INSERT INTO feedback_decisions (project_id, feedback_id, decision, reason, decided_agency, decided_by)
      SELECT project_id, id, 'reopened', 'Still broken.', 'human', reported_by FROM feedback
       WHERE fb_seq = ${Number(fb.slice(3))} AND project_id = ${projectId}
    `);
    await ok(triage(fb, routeTo(iss)));
    expect(await decisionCount(fb)).toBe(2);
  });
});
