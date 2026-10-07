/**
 * A requirement whose live issues are all drafts asks a signer to "promote N draft issues"; the
 * promote act answers that ask where it is shown (FB-93: six pages and eighteen clicks). Each draft
 * moves `draft → open` through its own status move, a refused one is named while the rest still
 * move, and the waiting line and the act read the same drafts, so both go once they are promoted.
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';

let owner = '';
let member = '';
let projectId = '';

const at = (path: string) => `/api/projects/${projectId}${path}`;

async function ok(res: Promise<{ status: number; body: Body }>, status = 200): Promise<Body> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
}

const refusalsOf = (body: Body): { code: string; path: string; detail: string }[] =>
  (body.error as { refusals?: { code: string; path: string; detail: string }[] } | undefined)
    ?.refusals ?? [];

/** An agreed requirement with `drafts` linked issues filed at draft. */
async function agreedWithDrafts(drafts: number): Promise<{ req: string; issues: Body[] }> {
  const req = (
    await ok(
      api(owner, 'POST', at('/requirements'), {
        title: `Checkout takes a card ${Math.random()}`,
        reason: 'buyers pay at the end',
        criteria: [{ body: 'A buyer pays by card at checkout.' }],
      }),
      201,
    )
  ).key as string;
  await ok(api(owner, 'POST', at(`/requirements/${req}/revisions/1/propose`), {}));
  await ok(api(owner, 'POST', at(`/requirements/${req}/revisions/1/accept`), { reason: 'ok' }));
  await ok(api(owner, 'POST', at(`/requirements/${req}/agree`), { revision: 1, reason: 'ok' }));
  const issues: Body[] = [];
  for (let n = 0; n < drafts; n += 1) {
    const issue = await ok(
      api(owner, 'POST', at('/issues'), { title: `slice ${n + 1}`, status: 'draft' }),
      201,
    );
    expect(issue.status).toBe('draft');
    await ok(api(owner, 'POST', at(`/requirements/${req}/issues`), { issue: issue.id }));
    issues.push(issue);
  }
  return { req, issues };
}

const read = (req: string) => ok(api(owner, 'GET', at(`/requirements/${req}`)));
const statusOf = async (id: unknown) =>
  (await ok(api(owner, 'GET', `/api/issues/${id as string}`))).status;

beforeAll(async () => {
  const ownerId = (await createTestUser({ verified: true })).id;
  owner = await userToken(ownerId);
  projectId = (await createTestProject(ownerId)).id;
  const memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  member = await userToken(memberId);
}, 60_000);

describe('a requirement whose live issues are all drafts', () => {
  it('asks the signer to promote them, and one act promotes every one, each through its own move', async () => {
    const { req, issues } = await agreedWithDrafts(3);
    const before = await read(req);
    expect((before.standing as Body).waitingOn).toMatchObject({
      kind: 'you',
      act: 'promote 3 draft issues',
    });

    const answer = await ok(api(owner, 'POST', at(`/requirements/${req}/promote`), {}));
    expect((answer.promoted as Body[]).map((p) => p.issueId)).toEqual(issues.map((i) => i.id));
    expect(answer.refused).toEqual([]);
    for (const issue of issues) expect(await statusOf(issue.id)).toBe('open');

    const after = answer.requirement as Body;
    expect((after.standing as Body).waitingOn).not.toMatchObject({
      act: expect.stringMatching(/^promote/),
    });
    expect((after.issues as Body[]).every((i) => i.status === 'open')).toBe(true);

    // one kernel move per issue, each recorded under the requirement that promoted it
    const moves = await rows<{ entity_id: string; reason: string }>(
      sql`SELECT entity_id, reason FROM kernel_transitions
          WHERE entity = 'issue' AND from_status = 'draft' AND to_status = 'open'
            AND entity_id IN (${sql.join(
              issues.map((i) => sql`${i.id as string}`),
              sql`, `,
            )})`,
    );
    expect(moves.map((m) => m.entity_id).sort()).toEqual(issues.map((i) => i.id).sort());
    expect(new Set(moves.map((m) => m.reason))).toEqual(new Set([`promoted from ${req}`]));
  });

  it('promotes one named draft and leaves the others at draft', async () => {
    const { req, issues } = await agreedWithDrafts(2);
    const [first, second] = issues as [Body, Body];
    const answer = await ok(
      api(owner, 'POST', at(`/requirements/${req}/promote`), { issues: [first.displayId] }),
    );
    expect(answer.promoted).toEqual([{ issueId: first.id, displayId: first.displayId }]);
    expect(await statusOf(first.id)).toBe('open');
    expect(await statusOf(second.id)).toBe('draft');
  });
});

describe('a mix where one draft cannot move', () => {
  it('moves the rest and names the refused one by its own code', async () => {
    const { req, issues } = await agreedWithDrafts(3);
    const [first, archived, third] = issues as [Body, Body, Body];
    const { db } = await import('../../src/db/client.js');
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE issues SET archived_at = now() WHERE id = ${archived.id as string}`),
    );

    const answer = await ok(api(owner, 'POST', at(`/requirements/${req}/promote`), {}));
    expect((answer.promoted as Body[]).map((p) => p.issueId)).toEqual([first.id, third.id]);
    expect(answer.refused).toEqual([
      expect.objectContaining({
        issueId: archived.id,
        displayId: archived.displayId,
        code: 'ISSUE_ARCHIVED',
      }),
    ]);
    expect(await statusOf(first.id)).toBe('open');
    expect(await statusOf(third.id)).toBe('open');
    expect(await statusOf(archived.id)).toBe('draft');

    // nothing left that can move: refused whole, nothing written, the issue's own code at its key
    const res = await api(owner, 'POST', at(`/requirements/${req}/promote`), {});
    expect(res.status).not.toBe(200);
    expect(refusalsOf(res.body)).toEqual([
      expect.objectContaining({ code: 'ISSUE_ARCHIVED', path: `/issues/${archived.displayId}` }),
    ]);
    expect(await statusOf(archived.id)).toBe('draft');
  });
});

describe('who may promote, and what there is to promote', () => {
  it('refuses a person who is not a signer, and no draft moves', async () => {
    const { req, issues } = await agreedWithDrafts(2);
    const asMember = await ok(api(member, 'GET', at(`/requirements/${req}`)));
    expect((asMember.standing as Body).waitingOn).toMatchObject({
      kind: 'person',
      who: 'BA or owner',
      act: 'promote 2 draft issues',
    });
    const res = await api(member, 'POST', at(`/requirements/${req}/promote`), {});
    expect(res.status).toBe(403);
    expect(refusalsOf(res.body).map((r) => r.code)).toEqual(['PERMISSION_FORBIDDEN']);
    for (const issue of issues) expect(await statusOf(issue.id)).toBe('draft');
  });

  it('refuses by name when nothing is at draft', async () => {
    const { req } = await agreedWithDrafts(1);
    await ok(api(owner, 'POST', at(`/requirements/${req}/promote`), {}));
    const res = await api(owner, 'POST', at(`/requirements/${req}/promote`), {});
    expect(refusalsOf(res.body).map((r) => r.code)).toEqual(['REQUIREMENT_NO_DRAFT_ISSUES']);
  });

  it('refuses a named issue that is not linked to it or not at draft, and moves none', async () => {
    const { req, issues } = await agreedWithDrafts(2);
    const [first, second] = issues as [Body, Body];
    await ok(api(owner, 'POST', at(`/requirements/${req}/promote`), { issues: [first.id] }));
    const res = await api(owner, 'POST', at(`/requirements/${req}/promote`), {
      issues: [second.displayId, first.displayId, 'ISS-99999'],
    });
    expect(refusalsOf(res.body).map((r) => `${r.code} ${r.path}`)).toEqual([
      'REQUIREMENT_ISSUE_NOT_DRAFT /issues/1',
      'REQUIREMENT_ISSUE_NOT_LINKED /issues/2',
    ]);
    expect(await statusOf(second.id)).toBe('draft');
  });

  it('refuses while the requirement is deferred', async () => {
    const { req, issues } = await agreedWithDrafts(1);
    await ok(api(owner, 'POST', at(`/requirements/${req}/defer`), { reason: 'next release' }));
    const res = await api(owner, 'POST', at(`/requirements/${req}/promote`), {});
    expect(refusalsOf(res.body).map((r) => r.code)).toEqual(['REQUIREMENT_DEFERRED']);
    expect(await statusOf(issues[0]?.id)).toBe('draft');
  });
});
