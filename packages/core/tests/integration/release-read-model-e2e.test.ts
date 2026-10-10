/**
 * The release read model a person reads (`release-batch/release-read.ts`): the gate as words, who a
 * release waits on, and the requirements and criteria it carries — through the app's own routes,
 * against real Postgres.
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { addVerdict, replaceCriteria } from '../../src/issues/criteria/service.js';
import { userNames } from '../../src/lib/people.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

const BETA_SHA = 'e7af41887a0e90ed541bb0dbfb34d4f9cb4f8510';

let projectId: string;
let ownerId: string;
let agentId: string;
const tokens: Record<'owner' | 'member' | 'agent', string> = { owner: '', member: '', agent: '' };

const fx = releaseWorld(() => ({ projectId, ownerId }));
let unplant: (() => void) | null = null;

afterEach(() => {
  unplant?.();
});

beforeEach(async () => {
  // the requirement's coverage reads production serving BETA_SHA, so a verdict at it is checked
  // (ISS-489 r3); this world's production declares no probe of its own
  unplant = plantLiveBuild(BETA_SHA);
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

const call = (who: keyof typeof tokens, method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(tokens[who], method, `/api/projects/${projectId}${path}`, body);

const evidence = {
  evidence: { environment: 'beta', commit: BETA_SHA, reading: 'GET /api/health 200' },
};

type Release = {
  key: string;
  state: string;
  attentionGroup: string;
  waitingOn: { kind: string; who: string; act: string };
  gates: Array<{ code: string; title: string; sentence: string; detail: string }>;
  can: { cut: boolean; decide: boolean; split: boolean };
  requirementsCompleted: Array<{
    key: string;
    completes: boolean;
    advances: Array<{ code: string }>;
    remaining: { issues: string[]; criteria: string[] };
    coverage: { criteria: number; passing: number; judged: number };
  }>;
  issueCriteria: Array<{
    key: string;
    criteria: Array<{ n: number; standing: string; bc: string | null; identity: string | null }>;
  }>;
  contents: Array<{
    requirement: { key: string } | null;
    issues: Array<{ key: string; proof: string }>;
  }>;
  criteria: { proven: number; failing: number; open: number; total: number };
};

const detail = async (who: keyof typeof tokens, version: string) => {
  const r = await call(who, 'GET', `/releases/${version}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.release as Release;
};

const rows = async (query: ReturnType<typeof sql>) => [...(await db.execute(query))];

async function agreedRequirement(): Promise<{ id: string; bc: Record<string, string> }> {
  const created = await call('owner', 'POST', '/requirements', {
    title: 'Reminders',
    reason: 'planted',
    criteria: [{ body: 'A nurse sees the reminder' }, { body: 'A doctor sees the report' }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const key = String(created.body.key);
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  for (const [path, body] of [
    [`/requirements/${key}/revisions/1/propose`, {}],
    [`/requirements/${key}/revisions/1/accept`, {}],
    [`/requirements/${key}/agree`, { revision: 1, reason: 'Agreed with the owner for this test.' }],
  ] as const) {
    const r = await call('owner', 'POST', path, body);
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
  }
  const [req] = await rows(sql`SELECT id FROM requirements WHERE project_id = ${projectId}`);
  const bcs = await rows(
    sql`SELECT id, code FROM requirement_criteria WHERE requirement_id = ${(req as { id: string }).id}`,
  );
  return {
    id: (req as { id: string }).id,
    bc: Object.fromEntries(bcs.map((b) => [String(b.code), String(b.id)])),
  };
}

/** An issue planned against the requirement: its criteria trace `bc`, with the verdicts given. */
async function traceIssue(
  issueId: string,
  requirementId: string,
  criteria: Array<{ bc: string; verdict: 'pass' | 'fail' | null }>,
) {
  await seedIssueStatus(issueId, 'in_progress');
  await db.execute(
    sql`UPDATE issues SET requirement_id = ${requirementId}, planned_revision = 1 WHERE id = ${issueId}`,
  );
  await replaceCriteria(
    issueId,
    criteria.map((c, i) => ({
      n: i + 1,
      statement: `criterion ${i + 1} of ${issueId.slice(0, 4)}`,
      requirementCriterionId: c.bc,
    })),
  );
  for (const [i, c] of criteria.entries()) {
    if (!c.verdict) continue;
    await addVerdict({
      issue: { id: issueId, projectId },
      draft: {
        criterion: i + 1,
        verdict: c.verdict,
        reason: null,
        identity: { kind: 'commit', sha: BETA_SHA },
        evidence: ['vitest'],
      },
      author: { userId: ownerId, deviceId: null, agency: 'human' },
    });
  }
  await seedIssueStatus(issueId, 'awaiting_release');
}

describe('a draft release reads its gate as words', () => {
  it('waits on the master for a missing release note, with the sentence on the face and the code behind it', async () => {
    await fx.insertIssue('awaiting_release', null);
    const list = await call('owner', 'GET', '/releases');
    expect(list.body).toMatchObject({
      releases: [
        {
          key: '0.1.0',
          state: 'draft',
          attentionGroup: 'waiting',
          waitingOn: { kind: 'agent', who: 'Master', act: 'write the release note on ISS-1' },
        },
      ],
      counts: { stuck: 0, waiting: 1, needs_you: 0 },
    });
    const draft = await detail('owner', '0.1.0');
    expect(draft.can).toEqual({ cut: false, decide: false, split: false });
    expect(draft.gates).toHaveLength(1);
    expect(draft.gates[0]).toMatchObject({
      code: 'RELEASE_RECORD_MISSING',
      title: 'Release note missing',
    });
    expect(draft.gates[0]?.sentence).toMatch(/^ISS-1 has no release note/);
    expect(draft.gates[0]?.sentence).not.toMatch(/RELEASE_|\/api\//);
    expect(draft.gates[0]?.detail).toMatch(/RELEASE_RECORD_REMEDY|release note/);
  });

  it('waits on an admin to cut it once nothing holds it, and offers the cut to an admin only', async () => {
    await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A new thing' });
    const owner = await detail('owner', '0.1.0');
    expect(owner).toMatchObject({
      attentionGroup: 'needs_you',
      waitingOn: { kind: 'you', act: 'cut 0.1.0' },
      can: { cut: true },
    });
    const member = await detail('member', '0.1.0');
    expect(member).toMatchObject({
      attentionGroup: 'waiting',
      waitingOn: {
        kind: 'person',
        who: expect.not.stringMatching(/^(A project (writer|admin)|A holder of .+|Nobody)$/),
      },
      can: { cut: false },
    });
  });

  it('refuses a version that is neither cut nor the draft, by name', async () => {
    await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A new thing' });
    expect((await call('owner', 'GET', '/releases/0.9.0')).status).toBe(404);
  });
});

describe('a release awaiting approval names its approver', () => {
  it('shows a member the holders who can decide by name and never by address', async () => {
    await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A new thing' });
    const cut = await call('owner', 'POST', '/release-batches', {
      issueIds: [(await rows(sql`SELECT id FROM issues WHERE project_id = ${projectId}`))[0]?.id],
    });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    const runId = String(cut.body.runId);
    const asked = await call('agent', 'POST', `/release-batches/${runId}/approvals`, evidence);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const several = await detail('member', '0.1.0');
    expect(several.waitingOn).toMatchObject({
      kind: 'person',
      act: 'approve',
      who: expect.stringContaining(', '),
    });

    await db.execute(
      sql`UPDATE project_members SET role = 'member' WHERE project_id = ${projectId} AND user_id = ${agentId}`,
    );
    const member = await detail('member', '0.1.0');
    expect(member.attentionGroup).toBe('waiting');
    expect(member.waitingOn).toMatchObject({
      kind: 'person',
      act: 'approve',
      who: (await userNames([ownerId])).get(ownerId),
    });
    expect(member.waitingOn.who).not.toContain('@');
    expect(JSON.stringify(member)).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
    const owner = await detail('owner', '0.1.0');
    expect(owner).toMatchObject({ attentionGroup: 'needs_you', can: { decide: true } });
    const agent = await detail('agent', '0.1.0');
    expect(agent.can.decide).toBe(false);
  });
});

describe('the requirements a release completes and the criteria of its issues', () => {
  it('reads each criterion with its standing, the criterion it proves and what it was judged against', async () => {
    const req = await agreedRequirement();
    const a = await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A' });
    const b = await fx.insertIssue('awaiting_release', { section: 'Fixed', userFacing: 'B' });
    await traceIssue(a, req.id, [{ bc: req.bc['BC-1'] as string, verdict: 'pass' }]);
    await traceIssue(b, req.id, [
      { bc: req.bc['BC-2'] as string, verdict: 'pass' },
      { bc: req.bc['BC-2'] as string, verdict: null },
    ]);
    const draft = await detail('owner', '0.1.0');
    const first = draft.issueCriteria.find((i) => i.criteria.length === 1);
    expect(first?.criteria[0]).toMatchObject({
      n: 1,
      standing: 'pass',
      bc: 'BC-1',
      identity: `commit ${BETA_SHA.slice(0, 12)}`,
    });
    const second = draft.issueCriteria.find((i) => i.criteria.length === 2);
    expect(second?.criteria.map((c) => c.standing)).toEqual(['pass', 'unjudged']);
    expect(draft.criteria).toEqual({ proven: 2, failing: 0, open: 1, total: 3 });
    expect(draft.contents).toHaveLength(1);
    expect(draft.contents[0]?.requirement?.key).toBe('REQ-1');
    expect(draft.contents[0]?.issues.map((i) => i.proof).sort()).toEqual(['open', 'proven']);
  });

  it('is partial while another issue of the requirement is open, and completes once nothing is owed', async () => {
    const req = await agreedRequirement();
    const a = await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A' });
    const b = await fx.insertIssue('awaiting_release', { section: 'Fixed', userFacing: 'B' });
    await traceIssue(a, req.id, [{ bc: req.bc['BC-1'] as string, verdict: 'pass' }]);
    await traceIssue(b, req.id, [{ bc: req.bc['BC-2'] as string, verdict: 'pass' }]);
    const open = await fx.insertIssue('in_progress', null, false);
    await db.execute(
      sql`UPDATE issues SET requirement_id = ${req.id}, planned_revision = 1 WHERE id = ${open}`,
    );
    const partial = (await detail('owner', '0.1.0')).requirementsCompleted[0];
    expect(partial).toMatchObject({ key: 'REQ-1', completes: false });
    expect(partial?.advances.map((x) => x.code).sort()).toEqual(['BC-1', 'BC-2']);
    expect(partial?.remaining.issues).toHaveLength(1);
    await db.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${open}`);
    await seedIssueStatus(open, 'closed');
    expect((await detail('owner', '0.1.0')).requirementsCompleted[0]).toMatchObject({
      completes: true,
      remaining: { issues: [], criteria: [] },
    });
  });

  it('counts the requirement out of its own criteria, and a verdict that passes one grows passing by one', async () => {
    const req = await agreedRequirement();
    const a = await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A' });
    await traceIssue(a, req.id, [{ bc: req.bc['BC-1'] as string, verdict: null }]);
    const before = (await detail('owner', '0.1.0')).requirementsCompleted[0];
    expect(before?.coverage).toEqual({ criteria: 2, passing: 0, judged: 0 });
    await addVerdict({
      issue: { id: a, projectId },
      draft: {
        criterion: 1,
        verdict: 'pass',
        reason: null,
        identity: { kind: 'commit', sha: BETA_SHA },
        evidence: ['vitest'],
      },
      author: { userId: ownerId, deviceId: null, agency: 'human' },
    });
    const after = (await detail('owner', '0.1.0')).requirementsCompleted[0];
    expect(after?.coverage).toEqual({ criteria: 2, passing: 1, judged: 1 });
    expect(after?.remaining.criteria).toEqual(['BC-2']);
  });

  it('is partial while a criterion fails, naming it', async () => {
    const req = await agreedRequirement();
    const a = await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A' });
    await traceIssue(a, req.id, [
      { bc: req.bc['BC-1'] as string, verdict: 'pass' },
      { bc: req.bc['BC-2'] as string, verdict: 'fail' },
    ]);
    const r = (await detail('owner', '0.1.0')).requirementsCompleted[0];
    expect(r).toMatchObject({ completes: false, remaining: { criteria: ['BC-2'] } });
  });
});

describe('an issue reopened between two releases reads as the rework of the one that shipped it (BC-6)', () => {
  // J10 on 0.4.0-dev.227, ISS-455's real timeline: dev.224 shipped round 1 and released at 02:01;
  // dev.225's run started at 02:17; J8 reopened the issue at 02:21; its retry fix, with migration
  // 0495, was closed into dev.225 when that release shipped at 03:12. dev.225 read it as "reworked in
  // a later release", left its note out of Fixes, and asked for 0495's backup naming no issue.
  const RETRY = 'An assistant draft the model missed is tried again, up to three tries.';
  const MIGRATION = 'packages/core/drizzle/migrations/0495_intake_retry.sql';
  const day = (hms: string) => `2026-10-10T${hms}Z`;

  async function shippedRun(
    version: string,
    started: string,
    released: string,
    roster: { issueIds: string[]; rosterClosed: string[] },
  ) {
    const meta = {
      source: 'release-batch',
      ...roster,
      finish: { requestId: version, state: 'finished', commit: BETA_SHA, version: 1 },
    };
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, release_released_at, metadata)
      VALUES (gen_random_uuid(), ${projectId}, 'system', 'completed', ${day(started)}, ${version},
              ${day(released)}, ${JSON.stringify(meta)}::jsonb)
    `);
  }

  async function moved(issueId: string, from: string, to: string, at: string) {
    await db.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source, created_at)
      VALUES ('issue', ${issueId}, ${from}, ${to}, 'user', 'agent', ${agentId}, 'planted', ${day(at)})
    `);
  }

  type Page = {
    fixes: Array<{ issueKey: string; kind: string; line: string }>;
    withoutNotes: Array<{ issueKey: string; why: string }>;
    actionRequired: Array<{ kind: string; ref: string; issues: string[] }>;
  };
  const page = async (version: string) => {
    const r = await call('member', 'GET', `/releases/${version}/page?view=developer`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as unknown as Page;
  };

  /** ISS-455 shipped by dev.224, then reopened inside dev.225's window. */
  async function iss455() {
    const id = await fx.insertIssue('closed', { section: 'Fixed', userFacing: RETRY });
    await db.execute(sql`
      UPDATE issues SET merged_artifacts = ${JSON.stringify([
        { surface: 'data', ref: MIGRATION, change: 'added' },
      ])}::jsonb WHERE id = ${id}
    `);
    await shippedRun('0.4.0-dev.224', '01:19:11.380', '02:01:10.033', {
      issueIds: [id],
      rosterClosed: [],
    });
    await shippedRun('0.4.0-dev.225', '02:17:16.051', '03:12:04.688', {
      issueIds: [],
      rosterClosed: [id],
    });
    await moved(id, 'awaiting_release', 'closed', '02:01:10.040');
    await moved(id, 'closed', 'reopen', '02:21:48.000');
    return id;
  }

  it('lists the rework under dev.225 Fixes and names the issue on its migration ask, and keeps dev.224 reworked', async () => {
    const id = await iss455();
    await moved(id, 'awaiting_release', 'closed', '03:12:04.690');
    const dev225 = await page('0.4.0-dev.225');
    expect(dev225.withoutNotes).toEqual([]);
    const key = dev225.fixes[0]?.issueKey;
    expect(dev225.fixes).toEqual([{ issueKey: key, kind: 'fixed', line: RETRY }]);
    expect(dev225.actionRequired).toEqual([
      expect.objectContaining({ kind: 'migration', ref: MIGRATION, issues: [key] }),
    ]);

    const dev224 = await page('0.4.0-dev.224');
    expect(dev224.fixes).toEqual([]);
    expect(dev224.withoutNotes).toEqual([
      expect.objectContaining({ issueKey: key, why: 'reworked' }),
    ]);
    expect(dev224.actionRequired).toEqual([]);
  });

  it('reads it reworked on dev.225 as well where dev.225 never closed it', async () => {
    await iss455();
    const dev225 = await page('0.4.0-dev.225');
    expect(dev225.fixes).toEqual([]);
    expect(dev225.withoutNotes.map((w) => w.why)).toEqual(['reworked']);
  });
});
