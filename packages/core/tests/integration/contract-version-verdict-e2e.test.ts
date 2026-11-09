/**
 * REQ-5 BC-11 (ISS-1174): a verdict may name a contract version as its identity. It is refused when
 * the issue's project never recorded that version, or when the contract is another project's, at
 * both doors that write a verdict: `POST /api/issues/:id/verdicts` and a comment's
 * `forge-record: verdict` fence. A verdict on a version reads as standing while that version is
 * current, and superseded once a later version is approved; a later version only proposed
 * supersedes nothing. Through the app's own routes, against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/criteria/verdict-record.ts
 * @direct-test-of packages/core/src/messaging/verdict-contract.ts
 * @direct-test-of packages/core/src/ecosystem/contract-holding.ts
 * @direct-test-of packages/core/src/issues/verdict-standing.ts
 * @direct-test-of packages/core/src/issues/criteria-anchors.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { unearnedCriteriaReports } from '../../src/issues/criteria-verdicts.js';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import { seedContractVersion } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { declareControls } from '../helpers/project-controls.js';

const FENCE = '```';

const w = { projectId: '', slug: '', otherSlug: '', issueId: '', token: '', agent: '' };

beforeEach(async () => {
  await truncateAll();
  const owner = (await createTestUser({ verified: true })).id;
  const project = await createTestProject(owner);
  const other = await createTestProject(owner);
  w.projectId = project.id;
  w.slug = project.slug;
  w.otherSlug = other.slug;
  w.token = await userToken(owner);
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(w.projectId, agent, 'member');
  w.agent = await userToken(agent);
  // the release hold weighs a verdict only where the project asks for verdicts
  await declareControls(w.projectId, owner, { delivery: { verdictsRequired: true } as never });
  await seedContractVersion({ providerId: w.projectId, ref: `${w.slug}/api`, version: '1.0.0' });
  // the other project holds the very version named, so only whose contract it is can refuse it
  await seedContractVersion({ providerId: other.id, ref: `${w.otherSlug}/api`, version: '1.0.0' });
  w.issueId = (
    await createTestIssue(w.projectId, owner, 1, { status: 'open', createdAt: new Date() })
  ).id;
  const criteria = await api(w.token, 'PUT', `/api/issues/${w.issueId}/criteria`, {
    criteria: [{ n: 1, statement: 'The order history call answers every past order' }],
  });
  expect(criteria.status, JSON.stringify(criteria.body)).toBeLessThan(300);
});

const judge = (ref: string, version: string) =>
  api(w.token, 'POST', `/api/issues/${w.issueId}/verdicts`, {
    criterion: 1,
    verdict: 'pass',
    reason: 'the contract test held against the provider',
    identity: { kind: 'contract', ref, version },
    evidence: ['https://ci.example.test/runs/7/contract-test.log'],
  });

/** A comment by an agent carrying one verdict fence naming `contract`. */
const fenced = (contract: string) =>
  api(w.agent, 'POST', `/api/issues/${w.issueId}/comments`, {
    body: [
      'Judged against the provider contract.',
      '',
      `${FENCE}forge-record: verdict · contract 1`,
      'criterion: 1',
      'verdict: pass',
      `contract: ${contract}`,
      'evidence: https://ci.example.test/runs/7/contract-test.log',
      FENCE,
    ].join('\n'),
    intent: 'note',
  });

const codes = (res: ApiResponse) =>
  ((res.body.error as { refusals?: Array<{ code: string }> })?.refusals ?? []).map((r) => r.code);

async function verdictsStored(): Promise<number> {
  const [row] = await rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM criterion_verdicts WHERE issue_id = ${w.issueId}`,
  );
  return Number(row?.n);
}

/** Criterion 1 as the release hold weighs it: its standing and the sentence saying why. */
async function weighed(): Promise<{ standing: string | null; why: string }> {
  const [report] = await unearnedCriteriaReports([w.issueId], {
    kind: 'undeclared',
    missing: 'a probe',
    route: 'none',
  });
  const unearned = report?.unearned.find((u) => u.criterion === 1);
  if (unearned) return { standing: unearned.standing, why: unearned.why };
  const earned = report?.earned.find((e) => e.criterion === 1);
  if (!earned) throw new Error(`criterion 1 was not weighed: ${JSON.stringify(report)}`);
  return { standing: earned.standing, why: earned.why };
}

describe('BC-11 a verdict names only a contract version its own project recorded', () => {
  it('(a) refuses a version the project never recorded, naming the versions it did', async () => {
    const res = await judge(`${w.slug}/api`, '9.9.9');
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codes(res)).toEqual(['VERDICT_CONTRACT_UNKNOWN']);
    expect(String(res.body.detail)).toContain(
      `names contract \`${w.slug}/api\` at version \`9.9.9\`, and this project recorded no such version of it. The versions it recorded, newest first: \`1.0.0\``,
    );
    expect(await verdictsStored()).toBe(0);
  });

  it("(b) refuses another project's contract, at a version that project did record", async () => {
    const res = await judge(`${w.otherSlug}/api`, '1.0.0');
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codes(res)).toEqual(['VERDICT_CONTRACT_UNKNOWN']);
    // it names whose contract it is, and never says this project recorded no version of its own
    expect(String(res.body.detail)).toContain(
      `which is project \`${w.otherSlug}\`'s contract, and this issue's project is \`${w.slug}\``,
    );
    expect(String(res.body.detail)).not.toContain('versions recorded: none');
    expect(await verdictsStored()).toBe(0);
  });

  it('records a version the project recorded', async () => {
    const res = await judge(`${w.slug}/api`, '1.0.0');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await verdictsStored()).toBe(1);
  });

  it('(a) refuses the same unrecorded version in a verdict fence, under verdict-contract', async () => {
    const res = await fenced(`${w.slug}/api@9.9.9`);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const said = JSON.stringify(res.body);
    expect(said).toContain('verdict-contract');
    expect(said).toContain('this project recorded no such version of it');
    expect(await verdictsStored()).toBe(0);
  });

  it("(b) refuses another project's contract in a verdict fence, under verdict-contract", async () => {
    const res = await fenced(`${w.otherSlug}/api@1.0.0`);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const said = JSON.stringify(res.body);
    expect(said).toContain('verdict-contract');
    expect(said).toContain(`which is project \`${w.otherSlug}\`'s contract`);
    expect(await verdictsStored()).toBe(0);
  });
});

describe('BC-11 a contract verdict is superseded once a later version is approved', () => {
  it('(c) stands on the current version, still stands beside a later one only proposed, and is superseded once that one is approved', async () => {
    const res = await judge(`${w.slug}/api`, '1.0.0');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await weighed()).toEqual({
      standing: 'stands',
      why: expect.stringContaining('the version that is current'),
    });

    await new Promise((r) => setTimeout(r, 15));
    await seedContractVersion({
      providerId: w.projectId,
      ref: `${w.slug}/api`,
      version: '1.1.0',
      classification: 'non-breaking',
      approval: 'proposed',
    });
    expect((await weighed()).standing, 'a proposed version is not current').toBe('stands');

    const approved = await api(
      w.token,
      'POST',
      `/api/projects/${w.projectId}/contracts/api/versions/1.1.0/decision`,
      { decision: 'approve' },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await weighed()).toEqual({
      standing: 'superseded',
      why: expect.stringContaining(
        `judged against contract ${w.slug}/api@1.0.0, and that contract's current version is now 1.1.0`,
      ),
    });
  });
});
