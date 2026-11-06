/**
 * ISS-1049 (REQ-79 BC-19, revision 10): a cleanup window exists only where a project turned one on.
 * Reading and recording debt, rating a change high, a merge check passing debt and a release going
 * past the gate never create or enable one. The debt is still recorded where no window is on, and
 * the ledger says plainly that none is on and who turns one on. A window a person disabled stays off.
 *
 * @direct-test-of packages/core/src/schedules/cleanup-window.ts
 * @direct-test-of packages/core/src/cleanup/service.ts
 * @direct-test-of packages/core/src/cleanup/gate-debt.ts
 * @direct-test-of packages/core/src/cleanup/rules.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordGateDebt } from '../../src/cleanup/gate-debt.js';
import { recordMergeCheckCleanup } from '../../src/cleanup/service.js';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { turnCleanupWindowOn } from '../helpers/cleanup-window.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { passingReport } from '../helpers/merge-check-report.js';
import { releaseWorld, seedProductionDeployTrigger, stubProbe } from '../helpers/release-world.js';

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
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
  stubProbe({});
});

const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
};
const ledger = () => call('GET', `/api/projects/${projectId}/debts`);
const debt = (rating: 'low' | 'medium') => ({
  kind: 'red',
  check: 'verify',
  where: 'scripts/check-copy-budget.mjs',
  detail: 'copy budget over by 12 lines',
  impact: { type: 'config', rating, reason: 'a budget gate, the app is untouched' },
});
const windows = () =>
  rows<{ enabled: boolean }>(
    sql`SELECT enabled FROM schedules WHERE project_id = ${projectId} AND kind = 'cleanup'`,
  );

describe('ISS-1049: no door that reads or records debt creates a cleanup window', () => {
  it('reads the ledger of a project with no window, saying none is on and who turns one on, and creates none', async () => {
    const read = await ledger();
    expect(read.status).toBe(200);
    expect(read.body.window).toBeNull();
    expect(read.body.windowOff).toContain('No cleanup window is on for this project');
    expect(read.body.windowOff).toContain('a project admin turns one on');
    expect(read.body.windowOff).toContain('POST /api/schedules');
    expect(await windows()).toEqual([]);
  });

  it('records debt where no window is on, and the debt waits in the ledger with no window made', async () => {
    const issue = await fx.insertIssue('in_progress');
    const res = await call('POST', `/api/projects/${projectId}/debts`, {
      issue,
      items: [debt('medium')],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.window).toBeNull();
    expect(res.body.windowOff).toContain('debt is still recorded');
    const read = await ledger();
    expect(read.body.open).toHaveLength(1);
    expect(read.body.window).toBeNull();
    expect(await windows()).toEqual([]);
  });

  it('rates a change high, passes a merge check with debt and records gate debt, and still creates none', async () => {
    const issue = await fx.insertIssue('in_progress');
    const rated = await call('POST', `/api/issues/${issue}/impact`, {
      type: 'data',
      rating: 'high',
      reason: 'rated high',
    });
    expect(rated.status).toBe(201);
    expect(rated.body).toMatchObject({ window: null });
    expect(rated.body).not.toHaveProperty('waits');
    await db.transaction((tx) =>
      recordMergeCheckCleanup(tx, {
        issueId: issue,
        projectId,
        actor: { type: 'user', id: ownerId, agency: 'human' },
        report: passingReport({
          base: { branch: 'dev', sha: 'b'.repeat(40) },
          head: 'c'.repeat(40),
          touched: [],
          debts: [debt('low')],
        } as Parameters<typeof passingReport>[0]),
      }),
    );
    expect(
      await recordGateDebt({
        projectId,
        kind: 'red',
        check: 'verify',
        where: 'd'.repeat(40),
        detail: 'verify ended red',
      }),
    ).toBe(true);
    expect((await ledger()).body.open).toHaveLength(2);
    expect(await windows()).toEqual([]);
  });
});

describe('ISS-1049: a window a person disabled stays off', () => {
  it('keeps it disabled through every read and record, and the ledger says it is off', async () => {
    const off = await turnCleanupWindowOn(projectId, ownerId, { enabled: false });
    await call('POST', `/api/projects/${projectId}/debts`, { items: [debt('low')] });
    const read = await ledger();
    expect(read.body.window).toMatchObject({ scheduleId: off, enabled: false });
    expect(read.body.windowOff).toContain(`The cleanup window (schedule ${off}`);
    expect(read.body.windowOff).toContain('is off');
    expect(await windows()).toEqual([{ enabled: false }]);
  });

  it('says nothing is off where a project turned its window on', async () => {
    const on = await turnCleanupWindowOn(projectId, ownerId);
    const read = await ledger();
    expect(read.body.window).toMatchObject({ scheduleId: on, enabled: true });
    expect(read.body.windowOff).toBeNull();
  });
});
