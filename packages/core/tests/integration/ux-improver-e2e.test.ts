// ISS-579 acceptance, walked against a real Postgres rather than a mocked query
// builder: seeded ux_findings with a repeated gap must yield exactly ONE
// consolidated rule at status=proposed with correct evidence links, and a single
// non-recurring finding must yield none.
//
// Also covers the three properties a SCHEDULED writer needs that a one-shot test
// would miss — re-running must refresh evidence rather than queue a duplicate, a
// proposal must not reach the compiled prose before a human approves it, and
// approving a supersede proposal must retire what it replaces so the prose never
// carries the same rule at two severities.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Improver = typeof import('../../src/projects/ux-improver.js');
type SignUserToken = typeof import('../../src/auth/jwt.js').signUserToken;

const EMPTY_SEARCH = [
  'Searchable list has no empty-search state; filtering to zero results renders blank.',
  'Filtering the searchable table to zero results renders a blank empty-search area.',
  'No empty-search state — searchable results list renders blank when filtered to zero.',
];

let harness: TestDatabase;
let improver: Improver;
let signUserToken: SignUserToken;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  process.env.EMBEDDINGS_BASE_URL ??= 'https://stub.invalid';
  process.env.EMBEDDINGS_API_KEY ??= 'stub-key';

  improver = (await import('../../src/projects/ux-improver.js')) as Improver;
  const [routesMod, jwtMod, errMod] = await Promise.all([
    import('../../src/projects/ux-contract-routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  signUserToken = jwtMod.signUserToken;
  app = new Hono();
  app.route('/api/ux-contract-rules', routesMod.uxContractRuleRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function seedProject() {
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  return { owner, project };
}

async function seedIssue(projectId: string, ownerId: string, title: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${title}, 'closed', ${ownerId})
    `);
  return id;
}

async function seedFinding(projectId: string, issueId: string, detail: string) {
  await harness.db.execute(sql`
      INSERT INTO ux_findings (project_id, issue_id, stage, kind, detail, severity)
      VALUES (${projectId}, ${issueId}, 'review', 'missing-state', ${detail}, 'must')
    `);
}

async function proposedRules(projectId: string) {
  const rows = await harness.db.execute(sql`
      SELECT id, "group", text, severity, source, status, evidence_issue_ids, supersedes_rule_id
      FROM ux_contract_rules
      WHERE project_id = ${projectId} AND status = 'proposed'
      ORDER BY order_index
    `);
  return rows as unknown as Array<{
    id: string;
    group: string;
    text: string;
    severity: string;
    source: string;
    status: string;
    evidence_issue_ids: string[];
    supersedes_rule_id: string | null;
  }>;
}

describe('UX improver — the recurrence bar (ISS-579 acceptance)', () => {
  it('turns a gap repeated across three issues into exactly ONE proposed rule carrying every evidence issue', async () => {
    const { owner, project } = await seedProject();
    const issueIds: string[] = [];
    for (let i = 0; i < EMPTY_SEARCH.length; i += 1) {
      const issueId = await seedIssue(project.id, owner.id, `UI issue ${i}`);
      issueIds.push(issueId);
      await seedFinding(project.id, issueId, EMPTY_SEARCH[i] as string);
    }

    const report = await improver.loadUxImproverReport(project.id);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]?.kind).toBe('add');

    const { outcomes } = await improver.applyUxImproverProposals(project.id, [
      report.candidates[0]?.key as string,
    ]);
    expect(outcomes).toEqual([
      expect.objectContaining({ action: 'proposed', ruleId: expect.any(String) }),
    ]);

    const rules = await proposedRules(project.id);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.source).toBe('learned');
    expect(rules[0]?.group).toBe('states');
    expect(rules[0]?.text).toContain('empty-search');
    expect([...(rules[0]?.evidence_issue_ids ?? [])].sort()).toEqual([...issueIds].sort());
  });

  it('writes no rule at all from a single non-recurring finding', async () => {
    const { owner, project } = await seedProject();
    const issueId = await seedIssue(project.id, owner.id, 'one-off UI issue');
    await seedFinding(project.id, issueId, EMPTY_SEARCH[0] as string);

    const report = await improver.loadUxImproverReport(project.id);
    expect(report.candidates).toHaveLength(0);
    expect(report.refused[0]?.reason).toBe('one-off');

    await improver.applyUxImproverProposals(project.id, ['add:states:whatever']);
    expect(await proposedRules(project.id)).toHaveLength(0);
  });
});

describe('UX improver — safe to re-run on a cadence (ISS-579)', () => {
  it('is safe to re-run on its own cadence: a second pass refreshes evidence instead of queueing a duplicate', async () => {
    const { owner, project } = await seedProject();
    for (let i = 0; i < EMPTY_SEARCH.length; i += 1) {
      const issueId = await seedIssue(project.id, owner.id, `UI issue ${i}`);
      await seedFinding(project.id, issueId, EMPTY_SEARCH[i] as string);
    }

    const first = await improver.loadUxImproverReport(project.id);
    await improver.applyUxImproverProposals(project.id, [first.candidates[0]?.key as string]);

    const fourth = await seedIssue(project.id, owner.id, 'UI issue 3');
    await seedFinding(
      project.id,
      fourth,
      'Zero-result filtering on the searchable list renders a blank empty-search region.',
    );

    const second = await improver.loadUxImproverReport(project.id);
    expect(second.candidates.filter((c) => c.kind === 'add')).toHaveLength(0);
    expect(second.refused.some((r) => r.reason === 'already-proposed')).toBe(true);

    const { outcomes } = await improver.applyUxImproverProposals(project.id, []);
    expect(outcomes).toEqual([
      expect.objectContaining({ action: 'evidence-refreshed', ruleId: expect.any(String) }),
    ]);

    const rules = await proposedRules(project.id);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.evidence_issue_ids).toHaveLength(4);
    expect(rules[0]?.evidence_issue_ids).toContain(fourth);
  });

  it('unions ACROSS refusals — two unrelated clusters matching one proposal do not clobber each other', async () => {
    const { owner, project } = await seedProject();
    const RULE_TEXT = 'alpha bravo charlie delta echo foxtrot';
    const CLUSTERS = ['alpha bravo charlie delta', 'charlie delta echo foxtrot'];
    await harness.db.execute(sql`
      INSERT INTO ux_contract_rules (project_id, "group", text, severity, source, status, evidence_issue_ids)
      VALUES (${project.id}, 'states', ${RULE_TEXT}, 'must', 'learned', 'proposed', '[]'::jsonb)
    `);

    const seeded: string[] = [];
    for (const detail of CLUSTERS) {
      for (let i = 0; i < 3; i += 1) {
        const issueId = await seedIssue(project.id, owner.id, `UI issue ${detail} ${i}`);
        seeded.push(issueId);
        await seedFinding(project.id, issueId, detail);
      }
    }

    const report = await improver.loadUxImproverReport(project.id);
    const refreshTargets = report.refused.filter((r) => r.reason === 'already-proposed');
    expect(refreshTargets).toHaveLength(2);
    expect(new Set(refreshTargets.map((r) => r.targetRuleId)).size).toBe(1);

    const { outcomes } = await improver.applyUxImproverProposals(project.id, []);

    expect(outcomes).toHaveLength(1);
    const rules = await proposedRules(project.id);
    expect([...(rules[0]?.evidence_issue_ids ?? [])].sort()).toEqual([...seeded].sort());
  });

  it('a third pass with no new findings writes nothing at all', async () => {
    const { owner, project } = await seedProject();
    for (let i = 0; i < EMPTY_SEARCH.length; i += 1) {
      const issueId = await seedIssue(project.id, owner.id, `UI issue ${i}`);
      await seedFinding(project.id, issueId, EMPTY_SEARCH[i] as string);
    }
    const first = await improver.loadUxImproverReport(project.id);
    await improver.applyUxImproverProposals(project.id, [first.candidates[0]?.key as string]);

    const { outcomes } = await improver.applyUxImproverProposals(project.id, []);

    expect(outcomes).toEqual([]);
    expect(await proposedRules(project.id)).toHaveLength(1);
  });
});

describe('UX improver — supersede: propose, then approve (ISS-579)', () => {
  it('proposes a should→must strengthen linked to the rule it replaces, not a second copy of it', async () => {
    const { owner, project } = await seedProject();
    const ruleId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO ux_contract_rules (id, project_id, "group", text, severity, source, status)
      VALUES (
        ${ruleId}, ${project.id}, 'states',
        'empty-search must be distinct from first-run empty and offer a clear-filter action.',
        'should', 'preset', 'active'
      )
    `);

    for (let i = 0; i < EMPTY_SEARCH.length; i += 1) {
      const issueId = await seedIssue(project.id, owner.id, `UI issue ${i}`);
      await harness.db.execute(sql`
        INSERT INTO ux_findings (project_id, issue_id, stage, kind, rule_id, detail, severity)
        VALUES (${project.id}, ${issueId}, 'review', 'missing-state', ${ruleId}, ${EMPTY_SEARCH[i] as string}, 'must')
      `);
    }

    const report = await improver.loadUxImproverReport(project.id);
    expect(report.candidates[0]?.kind).toBe('strengthen');

    await improver.applyUxImproverProposals(project.id, [report.candidates[0]?.key as string]);

    const rules = await proposedRules(project.id);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.severity).toBe('must');
    expect(rules[0]?.supersedes_rule_id).toBe(ruleId);

    const activeCount = await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM ux_contract_rules
      WHERE project_id = ${project.id} AND status = 'active'
    `);
    expect((activeCount as unknown as Array<{ n: number }>)[0]?.n).toBe(1);
  });

  it('approving a strengthen proposal retires the rule it supersedes, so the prose carries it once', async () => {
    const { owner, project } = await seedProject();
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`,
    );
    await harness.db.execute(sql`
      INSERT INTO project_members (project_id, user_id, role)
      VALUES (${project.id}, ${owner.id}, 'admin')
    `);
    const ruleId = randomUUID();
    const RULE_TEXT =
      'empty-search must be distinct from first-run empty and offer a clear-filter action.';
    await harness.db.execute(sql`
      INSERT INTO ux_contract_rules (id, project_id, "group", text, severity, source, status)
      VALUES (${ruleId}, ${project.id}, 'states', ${RULE_TEXT}, 'should', 'preset', 'active')
    `);
    for (let i = 0; i < EMPTY_SEARCH.length; i += 1) {
      const issueId = await seedIssue(project.id, owner.id, `UI issue ${i}`);
      await harness.db.execute(sql`
        INSERT INTO ux_findings (project_id, issue_id, stage, kind, rule_id, detail, severity)
        VALUES (${project.id}, ${issueId}, 'review', 'missing-state', ${ruleId}, ${EMPTY_SEARCH[i] as string}, 'must')
      `);
    }

    const report = await improver.loadUxImproverReport(project.id);
    await improver.applyUxImproverProposals(project.id, [report.candidates[0]?.key as string]);
    const proposalId = (await proposedRules(project.id))[0]?.id as string;

    const token = await signUserToken(owner.id);
    const res = await app.request(`/api/ux-contract-rules/${proposalId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(res.status).toBe(200);

    const rows = await harness.db.execute(sql`
      SELECT id, status FROM ux_contract_rules WHERE project_id = ${project.id}
    `);
    const byId = new Map(
      (rows as unknown as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]),
    );
    expect(byId.get(proposalId)).toBe('active');
    expect(byId.get(ruleId)).toBe('retired');

    const proseRows = await harness.db.execute(sql`
      SELECT agent_config -> 'projectFacts' ->> 'ux-contract' AS prose
      FROM projects WHERE id = ${project.id}
    `);
    const prose = (proseRows as unknown as Array<{ prose: string | null }>)[0]?.prose ?? '';
    expect(prose.split(RULE_TEXT)).toHaveLength(2);
  });

  it('leaves the compiled contract prose untouched while a proposal is only proposed', async () => {
    const { owner, project } = await seedProject();
    for (let i = 0; i < EMPTY_SEARCH.length; i += 1) {
      const issueId = await seedIssue(project.id, owner.id, `UI issue ${i}`);
      await seedFinding(project.id, issueId, EMPTY_SEARCH[i] as string);
    }

    const report = await improver.loadUxImproverReport(project.id);
    await improver.applyUxImproverProposals(project.id, [report.candidates[0]?.key as string]);

    const rows = await harness.db.execute(sql`
      SELECT agent_config -> 'projectFacts' ->> 'ux-contract' AS prose
      FROM projects WHERE id = ${project.id}
    `);
    const prose = (rows as unknown as Array<{ prose: string | null }>)[0]?.prose ?? '';
    expect(prose).not.toContain('empty-search state');
  });
});
