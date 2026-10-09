/**
 * REQ-34 BC-8, BC-9 through the gates on dev today: the issue-ready checklist (draft → open), the
 * design record (in_progress → approved, ISS-467) and the patterns check (in_progress →
 * awaiting_release, ISS-466). Each move is made through the issue's own route, the kernel records
 * how it stood, and the `gated-moves` report counts a project's moves over its period: passed,
 * refused by the gate, sent through by exception (an issue born at open past the checklist), and
 * recorded before the gate (`no checklist`, never inside passed). A refusal by a guard that is no
 * gate, and a read that evaluates a gate without moving, keep nothing.
 *
 * @direct-test-of packages/core/src/lifecycle/gated-moves.ts
 * @direct-test-of packages/core/src/lifecycle/transition.ts
 * @direct-test-of packages/core/src/lifecycle/checklist-judge.ts
 * @direct-test-of packages/core/src/report-queries/gated-moves.ts
 * @direct-test-of packages/contracts/src/move-gates.ts
 * @direct-test-of packages/core/src/db/schema-lifecycle.ts
 * @direct-test-of packages/core/src/issues/checklist-routes.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { THIS_REPOSITORY } from '../../src/lib/this-repository.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createReadyDraftIssue,
  createTestIssue,
  createTestModule,
  createTestProject,
  createTestUser,
  rows,
  seedIssueStatus,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

let token = '';
let adminId = '';
let forge = '';
let ready = '';
let seq = 0;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const admin = await createTestUser({ verified: true });
  adminId = admin.id;
  ({ id: forge } = await createTestProject(admin.id));
  await seedProjectDocument(forge, admin.id, {
    environments: {
      dev: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
    },
    source: {
      type: 'git',
      git: { repository: THIS_REPOSITORY, defaultBranch: 'main', branches: ['main'] },
    },
  });
  await createTestModule(forge, 'issues');
  ({ id: ready } = await createTestProject(admin.id));
  for (const p of [forge, ready]) await addProjectMember(p, admin.id, 'admin');
  token = await userToken(admin.id);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) => {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
};

const codes = (res: { body: Doc }): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.code);

const move = (issue: string, toStatus: string) =>
  call('POST', `/api/issues/${issue}/transition`, { toStatus });

async function issueIn(projectId: string, status: string, createdAt = new Date()) {
  seq += 1;
  return (await createTestIssue(projectId, adminId, seq, { status, createdAt })).id;
}

const DAY = 86_400_000;

async function report(projectId: string): Promise<Record<string, Doc>> {
  const res = await call('POST', `/api/projects/${projectId}/report-queries/gated-moves/runs`, {
    params: { days: 14 },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const counts: Record<string, Doc> = {};
  for (const row of res.body.frame.rows as Doc[]) {
    counts[row.gateId] = {
      passed: row.passed,
      refused: row.refused,
      exception: row.exception,
      noChecklist: row.noChecklist,
    };
  }
  return counts;
}

const refusedRows = async (issue: string) =>
  rows<{ gate: string; code: string }>(sql`
    SELECT gate, refusals->0->>'code' AS code FROM kernel_refused_moves
     WHERE entity = 'issue' AND entity_id = ${issue} ORDER BY created_at
  `);

describe('the issue-ready checklist, counted over a period', () => {
  it('counts passed, refused, born past it, and recorded before it apart (BC-8, BC-9)', async () => {
    // a born-at-open issue from before the gate first judged anything: never asked it
    await issueIn(ready, 'open', new Date(Date.now() - 3 * DAY));

    const gap = await issueIn(ready, 'draft');
    expect(codes(await move(gap, 'open'))).toContain('CHECKLIST_INCOMPLETE');
    expect(await refusedRows(gap)).toEqual([{ gate: 'issue_ready', code: 'CHECKLIST_INCOMPLETE' }]);

    seq += 1;
    const { id: whole } = await createReadyDraftIssue(ready, adminId, seq, 1);
    expect((await move(whole, 'open')).status).toBe(200);
    const [recorded] = await rows<{ checklist: string; gates: string[] }>(sql`
      SELECT checklist, gates FROM kernel_transitions WHERE entity = 'issue' AND entity_id = ${whole}
    `);
    expect(recorded).toEqual({ checklist: 'issue_ready', gates: ['issue_ready'] });

    // a move recorded before checklists: no checklist, gates not recorded
    const before = await issueIn(ready, 'open');
    await db.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source)
      VALUES ('issue', ${before}, 'draft', 'open', 'user', 'human', ${adminId}, 'issues')
    `);

    // born at open after the gate judged a move: past the checklist, by exception
    await issueIn(ready, 'open');

    // a refusal older than the period is not counted; it is the design record's, so the moment the
    // issue checklist first judged a move stays this test's own
    const old = await issueIn(ready, 'in_progress', new Date(Date.now() - 30 * DAY));
    await db.execute(sql`
      INSERT INTO kernel_refused_moves (entity, entity_id, from_status, to_status, machine_version, gate, gate_version, refusals, actor_type, actor_agency, source, created_at)
      VALUES ('issue', ${old}, 'in_progress', 'approved', 5, 'design_record', 1,
              '[{"code":"DESIGN_RECORD_MISSING","path":"/status","detail":"x"}]'::jsonb,
              'user', 'human', 'issues', now() - interval '20 days')
    `);

    const counts = await report(ready);
    expect(counts.issue_ready).toEqual({ passed: 1, refused: 1, exception: 1, noChecklist: 2 });
    expect(counts.design_record).toEqual({ passed: 0, refused: 0, exception: 0, noChecklist: 0 });
  });

  it('keeps nothing for a read that evaluates the checklist without moving', async () => {
    const gap = await issueIn(ready, 'draft');
    const read = await call('GET', `/api/issues/${gap}/checklist`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.checklists[0].now.complete).toBe(false);
    expect(await refusedRows(gap)).toEqual([]);
  });
});

describe('the move checks, counted by the gate that refused', () => {
  it('counts the design record refused then passed, and the patterns check refused', async () => {
    const before = await report(forge);

    const designed = await issueIn(forge, 'open');
    expect(
      (
        await call('PATCH', `/api/issues/${designed}`, {
          plan: 'Build it to the catalogued pattern.',
          acceptanceCriteria: '1. The rule lives in one module.',
        })
      ).status,
    ).toBe(200);
    await seedIssueStatus(designed, 'in_progress');
    expect(codes(await move(designed, 'approved'))).toEqual(['DESIGN_RECORD_MISSING']);
    const put = await call('PUT', `/api/issues/${designed}/design`, {
      criteria: [
        {
          criterion: 1,
          class: 'code_property',
          pattern: 'core-module',
          proof: 'review: one writer',
        },
      ],
      modules: ['issues'],
      contracts: [],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await move(designed, 'approved')).status).toBe(200);
    expect(await refusedRows(designed)).toEqual([
      { gate: 'design_record', code: 'DESIGN_RECORD_MISSING' },
    ]);

    const pending = await issueIn(forge, 'in_progress');
    // no merge recorded: the merged guard refuses first, and that refusal is no gate's
    expect(codes(await move(pending, 'awaiting_release'))).toEqual(['MERGE_NOT_RECORDED']);
    expect(await refusedRows(pending)).toEqual([]);
    await db.execute(
      sql`UPDATE issues SET merged_at = now(), merged_commit_sha = ${'c'.repeat(40)} WHERE id = ${pending}`,
    );
    const named = await call('POST', `/api/issues/${pending}/patterns`, {
      pattern: 'queue-door',
      summary: 'a queue consumer as a door',
    });
    expect(named.status, JSON.stringify(named.body)).toBe(201);
    // the read that shows the hold evaluates the check and keeps nothing
    expect((await call('GET', `/api/issues/${pending}/patterns`)).body.refusal.code).toBe(
      'PATTERN_REVIEW_PENDING',
    );
    expect(await refusedRows(pending)).toEqual([]);
    expect(codes(await move(pending, 'awaiting_release'))).toEqual(['PATTERN_REVIEW_PENDING']);
    expect(await refusedRows(pending)).toEqual([
      { gate: 'patterns', code: 'PATTERN_REVIEW_PENDING' },
    ]);

    const after = await report(forge);
    expect(after.design_record).toEqual({
      passed: before.design_record?.passed + 1,
      refused: before.design_record?.refused + 1,
      exception: 0,
      noChecklist: 0,
    });
    expect(after.patterns).toEqual({ passed: 0, refused: 1, exception: 0, noChecklist: 0 });
    expect(after.issue_ready).toEqual(before.issue_ready);
  });
});
