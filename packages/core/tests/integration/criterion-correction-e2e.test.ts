/**
 * One criterion's wording corrected on its own (coordinator ruling 2026-10-26). adminhub-fe ISS-63's
 * criterion 3 named `/orders/list` where the Orders list is `/orders`; GET and PATCH on the single
 * criterion answered 404, and the whole-list PUT never said what it did to the verdicts already
 * recorded, so the master left the wrong text. A correction keeps the criterion's id and so its
 * verdicts, at any status, and records the old and new text on its history; the whole-list PUT
 * names the verdicts it kept and the ones it voided. Through the app's own routes, against real
 * Postgres.
 *
 * @direct-test-of packages/core/src/issues/criteria/criterion-reword.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { api, userToken } from '../helpers/api.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const LIVE = '0d91ae7c74f70295ede115463b17559e650b5207';
const WRONG = 'The Orders list at /orders/list shows every order';
const RIGHT = 'The Orders list at /orders shows every order';

let projectId: string;
let ownerId: string;
let token: string;
let unplant: (() => void) | null = null;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  unplant = plantLiveBuild(LIVE);
});

afterEach(() => {
  unplant?.();
  unplant = null;
});

async function ok(r: Promise<{ status: number; body: unknown }>, status?: number): Promise<Doc> {
  const res = await r;
  if (status === undefined) expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  else expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as Doc;
}

const codes = (res: { body: unknown }): string[] =>
  (((res.body as Doc).error?.refusals ?? []) as Doc[]).map((r) => String(r.code));

/** ISS-1 with three criteria, the third naming the wrong path, and a verdict on each. */
async function issueWithVerdicts(): Promise<{ id: string; verdicts: string[] }> {
  const { id } = await createTestIssue(projectId, ownerId, 1, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  await ok(
    api(token, 'PUT', `/api/issues/${id}/criteria`, {
      criteria: [
        { statement: 'The dashboard loads' },
        { statement: 'A clerk can sign in' },
        { statement: WRONG },
      ],
    }),
  );
  const verdicts: string[] = [];
  for (const n of [1, 2, 3]) {
    const v = await ok(
      api(token, 'POST', `/api/issues/${id}/verdicts`, {
        criterion: n,
        verdict: 'pass',
        reason: `criterion ${n} held on the running build`,
        identity: { kind: 'commit', sha: LIVE },
        evidence: [`c${n}.png`],
      }),
      201,
    );
    verdicts.push(String(v.verdictId));
  }
  return { id, verdicts };
}

const textOf = async (id: string) =>
  (
    await rows<{ t: string | null }>(
      sql`SELECT acceptance_criteria AS t FROM issues WHERE id = ${id}`,
    )
  )[0]?.t;

describe('a single criterion is read and corrected by its number or its id', () => {
  it('reads criterion 3 by number and by id, with an empty history', async () => {
    const issue = await issueWithVerdicts();
    const byN = await ok(api(token, 'GET', `/api/issues/${issue.id}/criteria/3`), 200);
    expect(byN.criterion).toMatchObject({ n: 3, statement: WRONG });
    expect(byN.criterion.latest).toMatchObject({ id: issue.verdicts[2], verdict: 'pass' });
    expect(byN.history).toEqual([]);
    const byId = await ok(
      api(token, 'GET', `/api/issues/${issue.id}/criteria/${byN.criterion.id}`),
      200,
    );
    expect(byId.criterion.n).toBe(3);
  });

  it("corrects criterion 3's wording, keeping its id and its verdict, and records old and new text with the reason", async () => {
    const issue = await issueWithVerdicts();
    const before = await ok(api(token, 'GET', `/api/issues/${issue.id}/criteria/3`), 200);
    const res = await ok(
      api(token, 'PATCH', `/api/issues/${issue.id}/criteria/3`, {
        statement: RIGHT,
        reason: 'the Orders list is /orders',
      }),
      200,
    );
    expect(res).toMatchObject({
      criterionId: before.criterion.id,
      n: 3,
      changed: true,
      before: WRONG,
      after: RIGHT,
      verdicts: { kept: [issue.verdicts[2]], voided: [] },
    });
    const all = await ok(api(token, 'GET', `/api/issues/${issue.id}/criteria`), 200);
    const c3 = (all.criteria as Doc[]).find((c) => c.n === 3) as Doc;
    expect(c3).toMatchObject({ id: before.criterion.id, statement: RIGHT });
    expect(c3.latest).toMatchObject({ id: issue.verdicts[2], verdict: 'pass' });
    expect(all.retired).toEqual([]);
    expect(await textOf(issue.id)).toContain(`3. ${RIGHT}`);
    expect(await textOf(issue.id)).not.toContain('/orders/list');
    const after = await ok(api(token, 'GET', `/api/issues/${issue.id}/criteria/3`), 200);
    expect(after.history).toMatchObject([
      { before: WRONG, after: RIGHT, reason: 'the Orders list is /orders' },
    ]);
  });

  it('corrects a closed issue, where the whole-list write is locked (ISS-63 stood closed)', async () => {
    const issue = await issueWithVerdicts();
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE issues SET status = 'closed', merged_at = now() WHERE id = ${issue.id}`,
      ),
    );
    const put = await api(token, 'PUT', `/api/issues/${issue.id}/criteria`, {
      criteria: [
        { statement: 'The dashboard loads' },
        { statement: 'A clerk can sign in' },
        { statement: RIGHT },
      ],
    });
    expect(codes(put)).toContain('CRITERIA_LOCKED');
    const res = await ok(
      api(token, 'PATCH', `/api/issues/${issue.id}/criteria/3`, {
        statement: RIGHT,
        reason: 'the Orders list is /orders',
      }),
      200,
    );
    expect(res.verdicts.kept).toEqual([issue.verdicts[2]]);
  });

  it('answers an unchanged wording changed:false and records no history', async () => {
    const issue = await issueWithVerdicts();
    const res = await ok(
      api(token, 'PATCH', `/api/issues/${issue.id}/criteria/3`, {
        statement: `  ${WRONG} `,
        reason: 'no change',
      }),
      200,
    );
    expect(res.changed).toBe(false);
    const after = await ok(api(token, 'GET', `/api/issues/${issue.id}/criteria/3`), 200);
    expect(after.history).toEqual([]);
  });
});

describe('a correction refuses by name what it cannot do', () => {
  it('refuses a criterion the issue does not have, naming the ones it has', async () => {
    const issue = await issueWithVerdicts();
    for (const method of ['GET', 'PATCH'] as const) {
      const body = method === 'GET' ? undefined : { statement: RIGHT, reason: 'r' };
      const res = await api(token, method, `/api/issues/${issue.id}/criteria/9`, body);
      expect(codes(res), JSON.stringify(res.body)).toEqual(['CRITERION_UNKNOWN']);
      expect(JSON.stringify(res.body)).toContain('1, 2, 3');
    }
  });

  it("refuses another criterion's wording, a changed trace and a blank statement", async () => {
    const issue = await issueWithVerdicts();
    const twin = await api(token, 'PATCH', `/api/issues/${issue.id}/criteria/3`, {
      statement: 'A clerk can sign in',
      reason: 'r',
    });
    expect(codes(twin)).toEqual(['CRITERIA_INPUT_INVALID']);
    const traced = await api(token, 'PATCH', `/api/issues/${issue.id}/criteria/3`, {
      statement: `(REQ-1 BC-1) ${RIGHT}`,
      reason: 'r',
    });
    expect(codes(traced)).toEqual(['CRITERION_REWORD_TRACE']);
    const blank = await api(token, 'PATCH', `/api/issues/${issue.id}/criteria/3`, {
      statement: '   ',
      reason: 'r',
    });
    expect(blank.status).toBe(400);
    const all = await ok(api(token, 'GET', `/api/issues/${issue.id}/criteria/3`), 200);
    expect(all.criterion.statement).toBe(WRONG);
  });
});

describe('the whole-list write names the verdicts it kept and voided', () => {
  it('keeps the verdicts of unchanged wordings and voids those of a reworded and a removed one', async () => {
    const issue = await issueWithVerdicts();
    const res = await ok(
      api(token, 'PUT', `/api/issues/${issue.id}/criteria`, {
        criteria: [{ statement: 'The dashboard loads' }, { statement: RIGHT }],
      }),
      200,
    );
    expect(res.verdicts.kept).toEqual([issue.verdicts[0]]);
    expect(res.verdicts.voided).toEqual([
      expect.objectContaining({
        verdictId: issue.verdicts[1],
        n: 2,
        statement: 'A clerk can sign in',
      }),
      expect.objectContaining({ verdictId: issue.verdicts[2], n: 3, statement: WRONG }),
    ]);
    expect(res.verdicts.rule).toContain('PATCH /api/issues/:id/criteria/:n');
  });
});
