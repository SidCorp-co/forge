// REQ-76: each project chooses how tightly Forge gates its agents. The catalog is read where anyone
// can read it (BC-1); a project with no profile keeps today's gates (BC-2); one gate is overridden on
// its own (BC-3); yolo opens an issue and agrees a requirement over their gaps, recording each as
// advice (BC-4, BC-5); the kernel holds under every profile (BC-10); a refusal names its gate, the
// profile and the key (BC-11); a change is made through its own door with a reason and recorded with
// who made it (BC-12); and a failed deploy raises a yolo project to standard, which only a person
// lowers again (BC-13).

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyDeploySettlement } from '../../src/release-batch/coolify-confirm.js';
import { raiseOnIncident } from '../../src/release-batch/gate-raise.js';
import { type ApiResponse, api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
let owner: string;
let member: string;
let agent: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  owner = await userToken(ownerId);
  const memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  member = await userToken(memberId);
  const bot = await createTestUser({ kind: 'agent' });
  await addProjectMember(projectId, bot.id, 'admin');
  agent = await patToken(bot.id, [projectId]);
  await seedProjectDocument(projectId, ownerId, {
    environments: {
      beta: { tier: 'staging', deploysFrom: 'main', deployment: { mode: 'external' } },
    } as never,
  });
});

type Gate = { id: string; mode: string; profile: string; from: string; key: string };
type View = {
  declared: boolean;
  revision: number;
  profile: string;
  raised: { from: string; cause: string; ref: string; at: string } | null;
  overrides: Record<string, string>;
  gates: Gate[];
  changes: {
    profileFrom: string | null;
    profileTo: string;
    overridesTo: Record<string, string>;
    actorKind: string;
    cause: string;
    reason: string;
    ref: string | null;
  }[];
};

const gatesOf = async (token = owner): Promise<View> => {
  const r = await api(token, 'GET', `/api/projects/${projectId}/gates`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as unknown as View;
};

const modeOf = (view: View, id: string) => view.gates.find((g) => g.id === id);

async function setGates(
  token: string,
  body: { profile: string; overrides?: Record<string, string>; reason?: string },
): Promise<ApiResponse> {
  const { revision } = await gatesOf();
  return api(token, 'PUT', `/api/projects/${projectId}/gates`, {
    baseRevision: revision,
    overrides: {},
    reason: 'set for this test',
    ...body,
  });
}

const codes = (r: ApiResponse) =>
  ((r.body.error as { refusals?: { code: string }[] } | undefined)?.refusals ?? []).map(
    (x) => x.code,
  );

let seq = 0;
async function issueAt(status: string, over: { requirementId?: string } = {}): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, requirement_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'draft', ${ownerId}, ${over.requirementId ?? null})
  `);
  if (status !== 'draft') await seedIssueStatus(id, status);
  return id;
}

describe('BC-1: the gate catalog', () => {
  it('lists every policy gate with what it refuses and its default per profile, and the kernel apart, with no credential', async () => {
    const r = await api(null, 'GET', '/api/gates');
    expect(r.status).toBe(200);
    const body = r.body as {
      profiles: string[];
      gates: { id: string; refuses: string; defaults: Record<string, unknown> }[];
      kernel: { id: string }[];
    };
    expect(body.profiles).toEqual(['strict', 'standard', 'yolo']);
    const scope = body.gates.find((g) => g.id === 'scope_hold');
    expect(scope?.refuses).toContain('a scope another live run holds');
    expect(scope?.defaults).toEqual({ strict: 'enforce', standard: 'enforce', yolo: 'off' });
    expect(body.kernel.map((k) => k.id)).toEqual(
      expect.arrayContaining(['merged', 'close_by_release', 'pat_fence']),
    );
    expect(body.gates.map((g) => g.id)).not.toContain('merged');
  });
});

describe('BC-2: a project that set no profile keeps its gates as they were', () => {
  it('reads standard, each keyed gate following its own switch', async () => {
    const view = await gatesOf(member);
    expect(view.profile).toBe('standard');
    expect(view.raised).toBeNull();
    expect(modeOf(view, 'scope_hold')).toMatchObject({ mode: 'enforce', from: 'profile' });
    expect(modeOf(view, 'approval_admit')).toMatchObject({
      mode: 'off',
      from: 'key',
      key: 'approvals.admit',
    });
  });
});

describe('BC-3 and BC-12: a profile and one override, set through their door and recorded', () => {
  it('sets yolo with scope_hold kept enforced, and records who, when and why', async () => {
    const r = await setGates(owner, {
      profile: 'yolo',
      overrides: { scope_hold: 'enforce' },
      reason: 'POC pace, but two runs must not share a scope',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const view = await gatesOf();
    expect(view.profile).toBe('yolo');
    expect(modeOf(view, 'scope_hold')).toMatchObject({
      mode: 'enforce',
      from: 'override',
      key: 'gates.overrides.scope_hold',
    });
    expect(modeOf(view, 'design_record')).toMatchObject({ mode: 'off', from: 'profile' });
    expect(view.changes[0]).toMatchObject({
      profileFrom: null,
      profileTo: 'yolo',
      overridesTo: { scope_hold: 'enforce' },
      actorKind: 'person',
      cause: 'set',
      reason: 'POC pace, but two runs must not share a scope',
    });
    const stored = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM project_gate_changes WHERE project_id = ${projectId}`,
    );
    expect(stored[0]?.n).toBe(1);
  });

  it('refuses a change with no reason, and one sent through the generic config write', async () => {
    const bare = await setGates(owner, { profile: 'yolo', reason: '   ' });
    expect(bare.status).toBe(422);
    expect(codes(bare)).toEqual(['GATES_REASON_REQUIRED']);

    const held = (await api(owner, 'GET', `/api/projects/${projectId}/config`)).body as {
      revision: number;
      document: Record<string, unknown>;
    };
    const sideways = await api(owner, 'PUT', `/api/projects/${projectId}/config`, {
      baseRevision: held.revision,
      document: { ...held.document, gates: { profile: 'yolo' } },
    });
    expect(codes(sideways)).toEqual(['GATES_WRITTEN_THROUGH_THEIR_DOOR']);
    expect((await gatesOf()).profile).toBe('standard');
  });

  it('refuses a member without project.admin', async () => {
    const r = await setGates(member, { profile: 'yolo' });
    expect(r.status).toBe(403);
  });

  it('keeps the gates when the generic config write changes something else', async () => {
    expect((await setGates(owner, { profile: 'yolo' })).status).toBe(200);
    const held = (await api(owner, 'GET', `/api/projects/${projectId}/config`)).body as {
      revision: number;
      document: Record<string, unknown>;
    };
    const other = await api(owner, 'PUT', `/api/projects/${projectId}/config`, {
      baseRevision: held.revision,
      document: { ...held.document, approvals: { agree: true } },
    });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect((await gatesOf()).profile).toBe('yolo');
  });
});

describe('BC-4: yolo opens an issue over its gaps', () => {
  it('opens an issue with no requirement and no criteria, recording each gap as advice; standard refuses it', async () => {
    const held = await issueAt('draft');
    const refused = await api(owner, 'POST', `/api/issues/${held}/transition`, {
      toStatus: 'open',
    });
    expect(refused.status).toBe(422);
    expect(codes(refused)).toEqual(['CHECKLIST_INCOMPLETE', 'CHECKLIST_INCOMPLETE']);
    expect(JSON.stringify(refused.body)).toContain(
      "Gate issue_ready is enforced by this project's gate profile standard (gates.profile)",
    );

    expect((await setGates(owner, { profile: 'yolo' })).status).toBe(200);
    const id = await issueAt('draft');
    const opened = await api(agent, 'POST', `/api/issues/${id}/transition`, { toStatus: 'open' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const [move] = await rows<{
      answers: { question: string; provenance: string; source: string }[];
    }>(sql`
      SELECT checklist_answers AS answers FROM kernel_transitions
       WHERE entity = 'issue' AND entity_id = ${id} AND to_status = 'open'
    `);
    const waived = (move?.answers ?? []).filter((a) => a.provenance === 'waived');
    expect(waived.map((a) => `${a.question} ${a.source}`).sort()).toEqual([
      'criteria gate:issue_ready:yolo',
      'requirement gate:issue_ready:yolo',
    ]);
  });
});

describe('BC-5: yolo agrees a requirement over its checklist gaps', () => {
  async function currentRequirement(): Promise<string> {
    const made = await api(owner, 'POST', `/api/projects/${projectId}/requirements`, {
      title: 'Reminders reach the nurse',
      reason: 'planted',
      criteria: [{ body: 'A nurse sees the reminder' }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const key = String(made.body.key);
    for (const step of ['propose', 'accept']) {
      const r = await api(
        owner,
        'POST',
        `/api/projects/${projectId}/requirements/${key}/revisions/1/${step}`,
        {},
      );
      expect(r.status, `${step} ${JSON.stringify(r.body)}`).toBe(200);
    }
    return key;
  }

  it('standard refuses the gaps naming the gate; yolo agrees and keeps them as advice', async () => {
    const first = await currentRequirement();
    const refused = await api(
      owner,
      'POST',
      `/api/projects/${projectId}/requirements/${first}/agree`,
      {
        revision: 1,
        reason: 'agreed for this test',
      },
    );
    expect(refused.status).toBe(422);
    expect(new Set(codes(refused))).toEqual(new Set(['CHECKLIST_INCOMPLETE']));
    expect(JSON.stringify(refused.body)).toContain('Gate requirement_ready is enforced');

    expect((await setGates(owner, { profile: 'yolo' })).status).toBe(200);
    const agreed = await api(
      owner,
      'POST',
      `/api/projects/${projectId}/requirements/${first}/agree`,
      {
        revision: 1,
        reason: 'agreed for this test',
      },
    );
    expect(agreed.status, JSON.stringify(agreed.body)).toBe(200);
    const [row] = await rows<{ status: string }>(
      sql`SELECT status FROM requirements WHERE project_id = ${projectId} AND req_seq = ${Number(first.slice(4))}`,
    );
    expect(row?.status).toBe('agreed');
  });
});

describe('BC-10: the kernel holds under yolo', () => {
  beforeEach(async () => {
    expect((await setGates(owner, { profile: 'yolo' })).status).toBe(200);
  });

  it('still refuses awaiting_release with no recorded merge, and a close no release made', async () => {
    const working = await issueAt('in_progress');
    const unmerged = await api(owner, 'POST', `/api/issues/${working}/transition`, {
      toStatus: 'awaiting_release',
    });
    expect(codes(unmerged)).toContain('MERGE_NOT_RECORDED');

    const waiting = await issueAt('awaiting_release');
    const closed = await api(owner, 'POST', `/api/issues/${waiting}/transition`, {
      toStatus: 'closed',
    });
    expect(codes(closed)).toContain('CLOSE_ONLY_BY_RELEASE');
  });

  it('refuses an override naming a kernel rule, and a mode a gate cannot take', async () => {
    const kernel = await setGates(owner, { profile: 'yolo', overrides: { merged: 'off' } });
    expect(codes(kernel)).toEqual(['GATE_UNKNOWN']);
    expect(JSON.stringify(kernel.body)).toContain('no profile or override relaxes it');
    const triage = await setGates(owner, {
      profile: 'yolo',
      overrides: { feedback_triage: 'off' },
    });
    expect(codes(triage)).toEqual(['GATE_MODE_UNSUPPORTED']);
  });
});

describe('BC-11: a refusal names the gate, the profile and the key', () => {
  it('under strict, a member filing an issue at open is refused naming approval_admit and gates.profile', async () => {
    expect((await setGates(owner, { profile: 'strict' })).status).toBe(200);
    const r = await api(member, 'POST', `/api/projects/${projectId}/issues`, {
      title: 'Show the reminder',
      status: 'open',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(JSON.stringify(r.body)).toContain(
      "Gate approval_admit is enforced by this project's gate profile strict (gates.profile); gates.overrides.approval_admit relaxes it",
    );
  });
});

describe('BC-13: a failed deploy raises a yolo project, and only a person lowers it', () => {
  async function failedDeploy(): Promise<string> {
    const runId = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, metadata)
      VALUES (${runId}, ${projectId}, 'system', 'running', now(), '1.2.0',
              ${JSON.stringify({ source: 'release-batch', issueIds: [] })}::jsonb)
    `);
    await applyDeploySettlement(
      {
        runId,
        deliveryId: randomUUID(),
        bindingId: randomUUID(),
        deploymentUuid: 'dep-1',
        targetLabel: 'production',
      },
      'failed',
      'the container exited 137',
    );
    return runId;
  }

  it('raises to standard on the failure, refuses an agent lowering it, and lets a person', async () => {
    expect((await setGates(owner, { profile: 'yolo' })).status).toBe(200);
    const runId = await failedDeploy();

    const raised = await gatesOf();
    expect(raised.profile).toBe('standard');
    expect(raised.raised).toMatchObject({
      from: 'yolo',
      cause: 'deploy_failed',
      ref: `run ${runId}`,
    });
    expect(raised.changes[0]).toMatchObject({
      profileFrom: 'yolo',
      profileTo: 'standard',
      actorKind: 'forge',
      cause: 'deploy_failed',
    });
    expect(raised.changes[0]?.reason).toContain('the container exited 137');

    const byAgent = await setGates(agent, { profile: 'yolo', reason: 'back to speed' });
    expect(byAgent.status).toBe(403);
    expect(codes(byAgent)).toEqual(['GATE_PROFILE_RAISED']);
    const tighter = await setGates(agent, { profile: 'strict', reason: 'tighter is fine' });
    expect(tighter.status, JSON.stringify(tighter.body)).toBe(200);
    expect((await gatesOf()).raised).toMatchObject({ cause: 'deploy_failed' });

    const byPerson = await setGates(owner, { profile: 'yolo', reason: 'fixed the deploy' });
    expect(byPerson.status, JSON.stringify(byPerson.body)).toBe(200);
    const lowered = await gatesOf();
    expect(lowered.profile).toBe('yolo');
    expect(lowered.raised).toBeNull();
  });

  it('a rolled-back release raises it too; a standard project is left as it is', async () => {
    await failedDeploy();
    expect((await gatesOf()).changes).toEqual([]);

    expect((await setGates(owner, { profile: 'yolo' })).status).toBe(200);
    await raiseOnIncident({
      projectId,
      cause: 'release_reverted',
      ref: 'rollback of production to abc1234',
      why: 'target production was rolled back',
    });
    expect((await gatesOf()).raised).toMatchObject({ cause: 'release_reverted' });
  });
});
