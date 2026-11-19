/**
 * ISS-1329 c2 and c4: a release page line says whether its outside call was proven live or only
 * against a simulation. A master asked for production approval of a PGPrints integration whose
 * send, cancel and tracking had run only against a mock, and nothing on the release said so. Through
 * the verdict door and the page read, against real Postgres:
 * - a verdict says `integrationProof: "simulated"` or `"live"`; any other word is refused by name,
 *   and nothing is written;
 * - a planted release whose only proof of its outside call is a mock reads `simulated` on its line,
 *   on the user and the developer view alike, and a line no judge said a proof of reads none;
 * - a pass restating the criterion with no saying keeps the mock; one other criterion proven live
 *   does not hide it; only a live saying on the mocked criterion reads the line `live`.
 *
 * @direct-test-of packages/core/src/release-page/proofs.ts
 * @direct-test-of packages/core/src/release-page/read.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-record.ts
 * @direct-test-of packages/core/src/issues/criteria/input-schemas.ts
 * @direct-test-of packages/contracts/src/release-page.ts
 */

import type { IntegrationProof } from '@forge/contracts/release-page';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { addVerdict } from '../../src/issues/criteria/service.js';
import { backgroundRefreshesSettled } from '../../src/release-page/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { BUILD } from '../helpers/release-page-world.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
let ownerToken = '';
let memberToken = '';
const fx = releaseWorld(() => ({ projectId, ownerId }));
let unplant: (() => void) | null = null;

afterEach(async () => {
  unplant?.();
  await backgroundRefreshesSettled();
});

beforeEach(async () => {
  unplant = plantLiveBuild(BUILD);
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  ownerToken = await userToken(ownerId);
  const member = await createTestUser({ verified: true });
  await addProjectMember(projectId, member.id, 'member');
  memberToken = await userToken(member.id);
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({
    projectId,
    ownerId,
    bindingId,
    probes: 'none',
    others: { beta: { tier: 'staging', deployment: { mode: 'external' } } },
  });
});

type Line = { issueKey: string; proof: IntegrationProof | null };
type Page = { improvements: Line[]; fixes: Line[] };

const page = async (view = 'user') => {
  const r = await api(
    memberToken,
    'GET',
    `/api/projects/${projectId}/releases/0.1.0/page?view=${view}`,
  );
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as unknown as Page;
};

/** A verdict on criterion `n` of `issueId` at the build, saying `proof` of its outside call. */
async function judge(issueId: string, n: number, proof: IntegrationProof | null) {
  await addVerdict({
    issue: { id: issueId, projectId },
    draft: {
      criterion: n,
      verdict: 'pass',
      reason: null,
      identity: { kind: 'commit', sha: BUILD },
      evidence: ['send, cancel and tracking against the PGPrints mock'],
      integrationProof: proof,
    },
    author: { userId: ownerId, deviceId: null, agency: 'agent' },
  });
}

/** A cut release: `orders` sends to an outside provider (two criteria), `copy` calls none. */
async function plantedRelease() {
  const orders = await fx.insertIssue(
    'awaiting_release',
    { section: 'Added', title: 'PGPrints orders', userFacing: 'Orders go to PGPrints.' },
    true,
    ['An order is sent to PGPrints', 'A cancelled order is cancelled at PGPrints'],
  );
  const copy = await fx.insertIssue(
    'awaiting_release',
    { section: 'Fixed', title: 'Order copy', userFacing: 'The order page reads clearly.' },
    true,
    ['The order page reads clearly'],
  );
  const cut = await api(ownerToken, 'POST', `/api/projects/${projectId}/release-batches`, {
    issueIds: [orders, copy],
  });
  expect(cut.status, JSON.stringify(cut.body)).toBe(201);
  return { orders, copy };
}

const proofsOf = (p: Page) =>
  Object.fromEntries([...p.improvements, ...p.fixes].map((l) => [l.issueKey, l.proof]));

const keyOf = async (issueId: string) => {
  const [row] = [...(await db.execute(sql`SELECT iss_seq FROM issues WHERE id = ${issueId}`))];
  return `ISS-${(row as { iss_seq: number }).iss_seq}`;
};

describe('a verdict says how its outside call was proven (ISS-1329 c2)', () => {
  it('refuses any word but live or simulated by name, and writes nothing', async () => {
    const { orders } = await plantedRelease();
    const r = await api(ownerToken, 'POST', `/api/issues/${orders}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      identity: { kind: 'commit', sha: BUILD },
      evidence: ['mock'],
      integrationProof: 'mocked',
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('integrationProof \\"mocked\\" is no proof');
    const [row] = [
      ...(await db.execute(
        sql`SELECT count(*)::int AS n FROM criterion_verdicts WHERE issue_id = ${orders}`,
      )),
    ];
    expect((row as { n: number }).n).toBe(0);
  });

  it('keeps the saying the REST door was sent', async () => {
    const { orders } = await plantedRelease();
    const r = await api(ownerToken, 'POST', `/api/issues/${orders}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      identity: { kind: 'commit', sha: BUILD },
      evidence: ['send against the PGPrints test account on staging'],
      integrationProof: 'live',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [row] = [
      ...(await db.execute(
        sql`SELECT integration_proof AS p FROM criterion_verdicts WHERE id = ${String(r.body.verdictId)}`,
      )),
    ];
    expect(row).toEqual({ p: 'live' });
  });
});

describe('a release whose only proof of an outside call is a mock reads simulated (ISS-1329 c4)', () => {
  it('reads the line simulated on both views, and a line no judge said a proof of reads none', async () => {
    const { orders, copy } = await plantedRelease();
    await judge(orders, 1, 'simulated');
    await judge(orders, 2, 'simulated');
    await judge(copy, 1, null);
    const want = { [await keyOf(orders)]: 'simulated', [await keyOf(copy)]: null };
    expect(proofsOf(await page('user'))).toEqual(want);
    expect(proofsOf(await page('developer'))).toEqual(want);
  });

  it('keeps the mock through a restating pass and beside a criterion proven live', async () => {
    const { orders } = await plantedRelease();
    const key = await keyOf(orders);
    await judge(orders, 1, 'simulated');
    await judge(orders, 1, null);
    await judge(orders, 2, 'live');
    expect(proofsOf(await page())[key]).toBe('simulated');
    await judge(orders, 1, 'live');
    expect(proofsOf(await page())[key]).toBe('live');
  });
});
