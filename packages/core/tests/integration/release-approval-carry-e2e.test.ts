/**
 * A release approval carries its unproven criteria by name (ISS-914): through the app's routes and
 * the MCP `releases.decide` action, against real Postgres. The release carries two issues and four
 * criteria; on the build its approval was asked at only ISS-a criterion 1 is proven, and the other
 * three (a short, a pass on the merged commit only, a fail) are unproven. An approval carrying all
 * three is accepted and records them with the approver's why; one leaving any uncarried is refused
 * CHECKLIST_INCOMPLETE naming it; a carry naming a proven or unknown criterion is refused by its
 * entry. Approval is the releases.approve permission alone (ADR 0007): an agent's token holding it
 * approves, an actor without it is refused. A carried criterion stays unproven on the release.
 *
 * @direct-test-of packages/core/src/release-batch/approval-carry.ts
 * @direct-test-of packages/core/src/release-batch/approval-checklist.ts
 * @direct-test-of packages/core/src/release-batch/approvals.ts
 * @direct-test-of packages/core/src/release-batch/version-routes.ts
 * @direct-test-of packages/core/src/product-door/releases-tool.ts
 * @direct-test-of packages/core/src/db/schema-release-ledger.ts
 * @direct-test-of packages/contracts/src/releases.ts
 * @direct-test-of packages/contracts/src/release-page.ts
 * @direct-test-of packages/core/src/release-batch/release-facts.ts
 * @direct-test-of packages/core/src/release-page/claims.ts
 * @direct-test-of packages/core/src/release-page/facts.ts
 * @direct-test-of packages/core/src/issues/design-record.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { reopenedNow } from '../helpers/landed-requirement.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { declareControls } from '../helpers/project-controls.js';
import { BUILD, releasePageWorld } from '../helpers/release-page-world.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

type Json = Record<string, unknown>;
type Refusal = { code: string; path: string; detail: string };

let projectId: string;
let ownerId: string;
let agentId: string;
const tokens: Record<'owner' | 'member' | 'agent', string> = { owner: '', member: '', agent: '' };
const fx = releaseWorld(() => ({ projectId, ownerId }));
const world = releasePageWorld(() => ({ projectId, ownerId, call, fx }));

function call(who: keyof typeof tokens, method: 'GET' | 'POST', path: string, body?: unknown) {
  return api(tokens[who], method, `/api/projects/${projectId}${path}`, body);
}

let unplant: (() => void) | null = null;

afterEach(() => {
  unplant?.();
});

beforeEach(async () => {
  unplant = plantLiveBuild(BUILD);
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  tokens.owner = await userToken(ownerId);
  const member = await createTestUser({ verified: true });
  await addProjectMember(projectId, member.id, 'member');
  tokens.member = await userToken(member.id);
  agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'admin');
  tokens.agent = await patToken(agentId, [projectId], 'master');
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

const keyOf = async (issueId: string) => {
  const [row] = [...(await db.execute(sql`SELECT iss_seq FROM issues WHERE id = ${issueId}`))];
  return `ISS-${(row as { iss_seq: number }).iss_seq}`;
};

/** The cut release waiting on approval, its verdicts asked, with its two issues' keys. */
async function waiting() {
  const w = await world.releaseWorldOfFour();
  await declareControls(projectId, ownerId, { delivery: { verdictsRequired: true } });
  return {
    ...w,
    keyA: await keyOf(w.a),
    keyB: await keyOf(w.b),
    path: `/release-batches/${w.runId}/approvals/${w.approvalId}/decision`,
  };
}

async function stored(approvalId: string) {
  const [row] = [
    ...(await db.execute(
      sql`SELECT decision, decided_by_user, reason, carried FROM release_approvals WHERE id = ${approvalId}`,
    )),
  ];
  return row as {
    decision: string | null;
    decided_by_user: string | null;
    reason: string | null;
    carried: { issue: string; n: number; standing: string; why: string }[];
  };
}

const refusalsOf = (body: Json) => (body.error as { refusals: Refusal[] }).refusals;

async function release() {
  const r = await call('member', 'GET', '/releases/0.1.0');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.release as {
    approval: { decision: string | null; carried: Json[] } | null;
    criteria: { proven: number; total: number };
  };
}

describe('ISS-914: an approval carries its unproven criteria by name', () => {
  it('takes a carry of all, records each carried criterion with its why, and leaves each unproven on the release', async () => {
    const w = await waiting();
    const res = await call('owner', 'POST', w.path, {
      decision: 'approve',
      reason: 'beta serves it; the rest is flag-off there',
      carry: { all: true, why: 'behind a flag that is off on beta' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const expected = [
      { issue: w.keyA, n: 2, why: 'behind a flag that is off on beta' },
      { issue: w.keyB, n: 1, why: 'behind a flag that is off on beta' },
      { issue: w.keyB, n: 2, why: 'behind a flag that is off on beta' },
    ];
    expect(res.body).toMatchObject({ decision: 'approved', carried: expected });
    const row = await stored(w.approvalId);
    expect(row).toMatchObject({
      decision: 'approved',
      decided_by_user: ownerId,
      reason: 'beta serves it; the rest is flag-off there',
    });
    expect(row.carried).toMatchObject(expected);
    expect(row.carried.find((c) => c.issue === w.keyB && c.n === 2)?.standing).toBeTruthy();
    const read = await release();
    expect(read.approval?.carried).toMatchObject(expected);
    // a carried criterion stays owed: the release still proves one of four
    expect(read.criteria).toMatchObject({ proven: 1, total: 4 });
  });

  it('takes a carry naming each unproven criterion, each with its own why', async () => {
    const w = await waiting();
    const res = await call('owner', 'POST', w.path, {
      decision: 'approve',
      reason: 'approved on my word',
      carry: [
        { issue: w.keyA, n: 2, why: 'phone layout judged next round' },
        { issue: w.keyB, n: 1, why: 'commit-only: docs' },
        { issue: w.keyB, n: 2, why: 'flag off on beta' },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stored(w.approvalId)).carried.map((c) => [c.issue, c.n, c.why])).toEqual([
      [w.keyA, 2, 'phone layout judged next round'],
      [w.keyB, 1, 'commit-only: docs'],
      [w.keyB, 2, 'flag off on beta'],
    ]);
  });

  it('still refuses CHECKLIST_INCOMPLETE naming the one criterion left uncarried, and records nothing', async () => {
    const w = await waiting();
    const res = await call('owner', 'POST', w.path, {
      decision: 'approve',
      reason: 'approved on my word',
      carry: [
        { issue: w.keyA, n: 2, why: 'phone layout judged next round' },
        { issue: w.keyB, n: 1, why: 'commit-only: docs' },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('CHECKLIST_INCOMPLETE');
    const refusals = refusalsOf(res.body);
    expect(refusals.map((r) => [r.code, r.path])).toEqual([
      ['CHECKLIST_INCOMPLETE', '/answers/verdicts'],
    ]);
    expect(refusals[0]?.detail).toContain(`${w.keyB} criterion 2 (fail)`);
    expect(refusals[0]?.detail).not.toContain(`${w.keyA} criterion 2`);
    expect(refusals[0]?.detail).not.toContain(`${w.keyB} criterion 1`);
    expect(await stored(w.approvalId)).toMatchObject({ decision: null, carried: [] });
  });

  it('refuses a carry naming a proven criterion RELEASE_CARRY_PROVEN, and one not on the release RELEASE_CARRY_UNKNOWN, each at its entry', async () => {
    const w = await waiting();
    const proven = await call('owner', 'POST', w.path, {
      decision: 'approve',
      reason: 'ok',
      carry: [
        { issue: w.keyA, n: 2, why: 'x' },
        { issue: w.keyA, n: 1, why: 'already proven' },
      ],
    });
    expect(proven.status, JSON.stringify(proven.body)).toBe(409);
    expect(proven.body.code).toBe('RELEASE_CARRY_PROVEN');
    expect(refusalsOf(proven.body).map((r) => [r.code, r.path])).toEqual([
      ['RELEASE_CARRY_PROVEN', '/carry/1'],
    ]);

    const unknown = await call('owner', 'POST', w.path, {
      decision: 'approve',
      reason: 'ok',
      carry: [
        { issue: w.keyA, n: 7, why: 'no such criterion' },
        { issue: 'ISS-99999', n: 1, why: 'no such issue' },
      ],
    });
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(422);
    expect(unknown.body.code).toBe('RELEASE_CARRY_UNKNOWN');
    const named = refusalsOf(unknown.body);
    expect(named.map((r) => [r.code, r.path])).toEqual([
      ['RELEASE_CARRY_UNKNOWN', '/carry/0'],
      ['RELEASE_CARRY_UNKNOWN', '/carry/1'],
    ]);
    expect(named[0]?.detail).toContain(`${w.keyA} has no criterion 7`);
    expect(named[1]?.detail).toContain('ISS-99999 is not on this release');

    const onReturn = await call('owner', 'POST', w.path, {
      decision: 'return',
      reason: 'not yet',
      carry: { all: true, why: 'x' },
    });
    expect(onReturn.status).toBe(422);
    expect(onReturn.body.code).toBe('RELEASE_APPROVAL_SHAPE');
    expect(await stored(w.approvalId)).toMatchObject({ decision: null, carried: [] });
  });

  it('takes the approval of an agent token holding releases.approve, and refuses an actor without it by name', async () => {
    const w = await waiting();
    const byMember = await call('member', 'POST', w.path, {
      decision: 'approve',
      reason: 'not mine to say',
      carry: { all: true, why: 'x' },
    });
    expect(byMember.status).toBe(403);
    expect(JSON.stringify(byMember.body)).toContain('releases.approve');
    expect(await stored(w.approvalId)).toMatchObject({ decision: null });

    const byAgent = await call('agent', 'POST', w.path, {
      decision: 'approve',
      reason: 'approved on the owner’s word',
      carry: { all: true, why: 'flag off on beta' },
    });
    expect(byAgent.status, JSON.stringify(byAgent.body)).toBe(200);
    expect(byAgent.body).toMatchObject({ decision: 'approved', decidedBy: { id: agentId } });
    expect(await stored(w.approvalId)).toMatchObject({ decided_by_user: agentId });
  });
});

describe('ISS-914: the MCP releases.decide action takes the same carry', () => {
  let token = '';
  beforeEach(async () => {
    token = await patToken(ownerId, [projectId], 'mcp-owner');
  });

  async function mcp(args: Json) {
    const res = await api(
      token,
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'forge_releases', arguments: { projectId, version: '0.1.0', ...args } },
      },
      { accept: 'application/json, text/event-stream' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const result = res.body.result as { content: { text: string }[]; isError?: boolean };
    const text = result.content[0]?.text ?? '';
    return { isError: result.isError === true, text, json: JSON.parse(text) as Json };
  }

  it('refuses an uncarried criterion by name, then approves with a carry of all', async () => {
    const w = await waiting();
    const short = await mcp({
      action: 'decide',
      decision: 'approve',
      reason: 'ok',
      carry: [{ issue: w.keyA, n: 2, why: 'x' }],
    });
    expect(short.isError, short.text).toBe(true);
    expect(short.text).toContain('CHECKLIST_INCOMPLETE');
    expect(short.text).toContain(`${w.keyB} criterion 2`);

    const done = await mcp({
      action: 'decide',
      decision: 'approve',
      reason: 'approved on my word',
      carry: { all: true, why: 'flag off on beta' },
    });
    expect(done.isError, done.text).toBe(false);
    expect(done.json).toMatchObject({
      act: 'approve',
      approval: { decision: 'approved', carried: [{ issue: w.keyA, n: 2 }, {}, {}] },
    });
    expect((await stored(w.approvalId)).carried).toHaveLength(3);
  });
});

// ISS-914 (FB-471): a code-property criterion is the review's alone, judged against the diff, and QA
// is refused on it (VERDICT_JUDGED_BY_REVIEW), so on a project judged on its testing environment
// the runtime pass the build rule asked of it was one it could never earn: the review's commit pass
// proves it. Here the project is judged on beta; ISS-a criterion 1 is observable and ISS-b
// criterion 1 a code property, each holding only a commit pass (ISS-b's at the merged commit).
describe('ISS-914: a code property is proven by its review on a release judged on beta', () => {
  /** Class `criterionClass` on criterion `n` of `issueId`, as a recorded design holds it. */
  async function designed(issueId: string, lines: Array<[number, string]>) {
    await db.execute(sql`
      INSERT INTO issue_designs (issue_id, project_id, revision, modules, contracts, recorded_by)
      VALUES (${issueId}, ${projectId}, 1, '{}'::uuid[], '{}'::text[], ${ownerId})
      ON CONFLICT (issue_id) DO NOTHING
    `);
    for (const [n, criterionClass] of lines) {
      await db.execute(sql`
        INSERT INTO issue_design_criteria (criterion_id, issue_id, criterion_class, pattern, proof)
        SELECT id, issue_id, ${criterionClass}, NULL, 'review: the diff'
          FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL
      `);
    }
  }

  async function judgedOnBeta() {
    const w = await waiting();
    await declareControls(projectId, ownerId, {
      delivery: { verdictsRequired: true, judgedOn: 'beta' },
    });
    await designed(w.a, [[1, 'observable']]);
    await designed(w.b, [[1, 'code_property']]);
    return w;
  }

  type Criterion = { n: number; proven: boolean; standing: string; unverified: string | null };
  async function criteriaOf(key: string): Promise<Criterion[]> {
    const r = await call('member', 'GET', '/releases/0.1.0');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const read = r.body.release as { issueCriteria: Array<{ key: string; criteria: Criterion[] }> };
    return read.issueCriteria.find((i) => i.key === key)?.criteria ?? [];
  }

  it("counts the code property's commit pass proven, and asks no carry of it", async () => {
    const w = await judgedOnBeta();

    expect((await release()).criteria).toMatchObject({ proven: 1, total: 4 });
    const [b1] = await criteriaOf(w.keyB);
    expect(b1).toMatchObject({ n: 1, proven: true, standing: 'pass', unverified: null });

    const res = await call('owner', 'POST', w.path, {
      decision: 'approve',
      reason: 'the review proves the code property',
      carry: [
        { issue: w.keyA, n: 1, why: 'judged on beta next round' },
        { issue: w.keyA, n: 2, why: 'phone layout judged next round' },
        { issue: w.keyB, n: 2, why: 'flag off on beta' },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stored(w.approvalId)).carried.map((c) => [c.issue, c.n])).toEqual([
      [w.keyA, 1],
      [w.keyA, 2],
      [w.keyB, 2],
    ]);
  });

  it('leaves an observable criterion with only a commit pass unproven, not judged on beta', async () => {
    const w = await judgedOnBeta();

    const [a1] = await criteriaOf(w.keyA);
    expect(a1).toMatchObject({ n: 1, proven: false, standing: 'unjudged' });
    expect(a1?.unverified).toMatch(/^Not judged on beta: /);
    const res = await call('owner', 'POST', w.path, {
      decision: 'approve',
      reason: 'approved on my word',
      carry: [
        { issue: w.keyA, n: 2, why: 'phone layout judged next round' },
        { issue: w.keyB, n: 2, why: 'flag off on beta' },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('CHECKLIST_INCOMPLETE');
    const [refusal] = refusalsOf(res.body);
    expect(refusal?.detail).toContain(`${w.keyA} criterion 1 (Not judged on beta`);
    expect(refusal?.detail).not.toContain(`${w.keyB} criterion 1`);
  });

  it("counts no review pass recorded before the issue's last reopen", async () => {
    const w = await judgedOnBeta();
    await reopenedNow(w.b);

    expect((await release()).criteria).toMatchObject({ proven: 0, total: 4 });
    const [b1] = await criteriaOf(w.keyB);
    expect(b1).toMatchObject({ n: 1, proven: false, standing: 'unjudged' });
    expect(b1?.unverified).toBe(
      "Not reviewed: a code property is proven by the review's pass on the diff",
    );
    const res = await call('owner', 'POST', w.path, {
      decision: 'approve',
      reason: 'approved on my word',
      carry: [
        { issue: w.keyA, n: 1, why: 'x' },
        { issue: w.keyA, n: 2, why: 'x' },
        { issue: w.keyB, n: 2, why: 'x' },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(refusalsOf(res.body)[0]?.detail).toContain(`${w.keyB} criterion 1 (Not reviewed`);
  });
});
