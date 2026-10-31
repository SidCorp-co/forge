/**
 * A cleanup report (REQ-79 BC-9, BC-10) against real Postgres over HTTP: it names every open debt once,
 * and its result follows from the debts it leaves, green exactly when each is carried as a priced
 * amnesty. Planted from forge-dev, 2026-10-31: debt 3d01ab3d (Deploy dev, a token only a person can
 * set) was left with the same reason by four green reports and one red (fire cb6546d2), which held
 * the next change rated high (ISS-842).
 *
 * @direct-test-of packages/core/src/cleanup/rules.ts
 * @direct-test-of packages/core/src/cleanup/service.ts
 * @direct-test-of packages/core/src/cleanup/store.ts
 * @direct-test-of packages/core/src/cleanup/fire.ts
 * @direct-test-of packages/core/src/cleanup/routes.ts
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupFirePlan } from '../../src/cleanup/index.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { releaseWorld } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
let token: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
});

const call = async (
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  as = token,
) => {
  const res = await api(as, method, path, body);
  return { status: res.status, body: res.body as Doc };
};
const codes = (res: { body: Doc }): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.code);
const rate = (issue: string, rating: 'low' | 'medium' | 'high') =>
  call('POST', `/api/issues/${issue}/impact`, { type: 'data', rating, reason: `rated ${rating}` });
const red = (rating: 'low' | 'medium' | 'high') => ({
  kind: 'red',
  check: 'verify',
  where: 'scripts/check-copy-budget.mjs',
  detail: 'copy budget over by 12 lines',
  impact: { type: 'config', rating, reason: 'a budget gate, the app is untouched' },
});
const debts = (body: unknown) => call('POST', `/api/projects/${projectId}/debts`, body);
const ledger = () => call('GET', `/api/projects/${projectId}/debts`);
const reportCleanup = (body: Doc) =>
  call('POST', `/api/projects/${projectId}/cleanup-reports`, {
    base: { branch: 'dev', sha: 'c'.repeat(40) },
    result: 'green',
    cleared: [],
    remains: [],
    ...body,
  });
const PRICE = {
  trades: 'Deploy dev stays red',
  costs: 'forge-dev moves only by hand deploys',
  endsWhen: 'a person sets COOLIFY_DEV_DEPLOY_TOKEN',
};
const carry = (debt: string, as = token) =>
  call('POST', `/api/projects/${projectId}/debts/${debt}/carry`, PRICE, as);
const deployDebt = async () =>
  (
    await debts({
      items: [
        {
          kind: 'red',
          check: 'Deploy dev',
          where: '.github/workflows (Deploy dev)',
          detail: 'COOLIFY_DEV_DEPLOY_TOKEN is empty; no diff can set a secret',
          impact: { type: 'config', rating: 'medium', reason: 'forge-dev moves by hand deploys' },
        },
      ],
    })
  ).body.debts[0] as string;

describe('a cleanup report (BC-9)', () => {
  it('names every open debt, cleared with how or remaining with why, and clears those it cleared', async () => {
    const first = (await debts({ items: [red('low')] })).body.debts[0] as string;
    const second = (await debts({ items: [{ ...red('medium'), kind: 'simplify' }] })).body
      .debts[0] as string;

    const short = await reportCleanup({ cleared: [{ debt: first, how: 'trimmed the copy' }] });
    expect(codes(short)).toEqual(['CLEANUP_REPORT_INCOMPLETE']);
    expect(JSON.stringify(short.body)).toContain(second);

    expect((await carry(second)).status).toBe(200);
    const whole = await reportCleanup({
      cleared: [{ debt: first, how: 'trimmed the copy' }],
      remains: [{ debt: second, why: 'the module is mid-rewrite under ISS-9' }],
    });
    expect(whole.status, JSON.stringify(whole.body)).toBe(201);
    expect(whole.body.open).toBe(1);
    const read = await ledger();
    expect(read.body.open.map((d: Doc) => d.id)).toEqual([second]);
    expect(read.body.cleared[0]).toMatchObject({ id: first, cleared: { how: 'trimmed the copy' } });
    const listed = await call('GET', `/api/projects/${projectId}/cleanup-reports`);
    expect(listed.body.reports[0]).toMatchObject({
      result: 'green',
      remains: [{ debt: second, why: 'the module is mid-rewrite under ISS-9' }],
    });
  });

  it('covers only a change rated high, naming the one that is not', async () => {
    const medium = await fx.insertIssue('awaiting_release');
    await rate(medium, 'medium');
    const res = await reportCleanup({ covers: [medium] });
    expect(codes(res)).toEqual(['CLEANUP_COVERS_NOT_HIGH']);
  });
});

describe('a debt no change can clear, carried as a priced amnesty (BC-10, ISS-842)', () => {
  it('reads the same on every report: green leaving it once carried, and green refused until then', async () => {
    const debt = await deployDebt();
    const remains = [{ debt, why: 'a person must set the token' }];
    const early = await reportCleanup({ remains });
    expect([early.status, codes(early)]).toEqual([422, ['CLEANUP_RESULT_DISAGREES']]);
    expect(JSON.stringify(early.body)).toContain(debt);
    expect((await reportCleanup({ result: 'red', remains })).status).toBe(201);

    expect((await carry(debt)).body).toEqual({ debt, carried: true });
    for (let fire = 0; fire < 3; fire += 1) {
      const green = await reportCleanup({ remains });
      expect([green.status, codes(green)], JSON.stringify(green.body)).toEqual([201, []]);
      const reddened = await reportCleanup({ result: 'red', remains });
      expect(codes(reddened)).toEqual(['CLEANUP_RESULT_DISAGREES']);
    }
    const [open] = (await ledger()).body.open as Doc[];
    expect(open?.carried).toMatchObject({ ...PRICE, by: ownerId });
  });

  it('stops being carried when its amnesty is withdrawn, and a cleared debt cannot be carried', async () => {
    const debt = await deployDebt();
    await carry(debt);
    const dropped = await call('DELETE', `/api/projects/${projectId}/debts/${debt}/carry`);
    expect(dropped.body).toEqual({ debt, carried: false });
    expect(codes(await reportCleanup({ remains: [{ debt, why: 'x' }] }))).toEqual([
      'CLEANUP_RESULT_DISAGREES',
    ]);
    expect((await reportCleanup({ cleared: [{ debt, how: 'the token was set' }] })).status).toBe(
      201,
    );
    expect(codes(await carry(debt))).toEqual(['CLEANUP_DEBT_UNKNOWN']);
    expect(codes(await carry(randomUUID()))).toEqual(['CLEANUP_DEBT_UNKNOWN']);
  });

  it('is priced by a project admin only, and needs all three of what it trades, costs and ends on', async () => {
    const debt = await deployDebt();
    const memberId = (await createTestUser({ verified: true })).id;
    await addProjectMember(projectId, memberId, 'member');
    const member = await carry(debt, await userToken(memberId));
    expect(member.status).toBe(403);
    const short = await call('POST', `/api/projects/${projectId}/debts/${debt}/carry`, {
      trades: 'x',
      costs: 'y',
    });
    expect(short.status).toBe(400);
    expect((await ledger()).body.open[0].carried).toBeNull();
  });

  it("is named in the run's brief with its price, and starts no run alone", async () => {
    const debt = await deployDebt();
    await carry(debt);
    const idle = await cleanupFirePlan({ projectId, fireId: randomUUID() });
    expect(idle.kind).toBe('nothing');
    const high = await fx.insertIssue('in_progress');
    await rate(high, 'high');
    const plan = await cleanupFirePlan({ projectId, fireId: randomUUID() });
    if (plan.kind !== 'run') throw new Error(`no run: ${JSON.stringify(plan)}`);
    expect(plan.prompt).toContain(debt);
    expect(plan.prompt).toContain(
      `CARRIED, a priced amnesty: trades ${PRICE.trades}; costs ${PRICE.costs}; ends when ${PRICE.endsWhen}`,
    );
    expect(plan.prompt).toContain('The result is not yours to judge (REQ-79 BC-10)');
  });
});
