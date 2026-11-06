// @direct-test-of packages/core/src/release-batch/draft-approval.ts
// @direct-test-of packages/core/src/release-batch/release-read-views.ts
// @direct-test-of packages/core/src/release-batch/version-routes.ts
// @direct-test-of packages/core/src/release-batch/release-read.ts
// @direct-test-of packages/core/src/permissions/holders-named.ts
// @direct-test-of packages/core/src/release-page/sections.ts
// @direct-test-of packages/core/src/development/needs-you-draft-approval.ts
// @direct-test-of packages/core/src/release-batch/release-gates.ts
/**
 * ISS-869 (FB-465): Autoflow's own rules ask its owner to approve a release before the master opens
 * the upstream MR. Its release 0.1.0 was a draft with no run, the project declaring no production, so
 * `POST release-batches/:runId/approvals` had nothing to approve; and its page listed the agent
 * itself as the approver, able to cut and decide nothing. A draft on such a project is decided by its
 * listed approvers, the people holding releases.approve, keyed on its version; the agent is never
 * listed, and its token is refused by name. Against real Postgres, over REST, on the landed world
 * whose document declares no production.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { BRANCH, F4, landedIssue, seedLandedWorld, world } from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

type Release = {
  version: string;
  state: string;
  can: { cut: boolean; decide: boolean };
  gates: Array<{ code: string }>;
  approvers: Array<{ id: string; name: string; kind: string }>;
  draftApproval: null | {
    version: string;
    decision: string;
    decidedBy: { id: string };
    reason: string | null;
  };
};

/** The release page's header and acts, as `GET …/releases/:version/page` answers them. */
type Page = { header: { recordedNotCut: boolean }; can: { approve: boolean } };

const pageOf = async (version: string): Promise<Page> => {
  const res = await api(
    world.token,
    'GET',
    `/api/projects/${world.projectId}/releases/${version}/page?view=user`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as Page;
};

let agentId = '';
let agentToken = '';

beforeEach(async () => {
  await seedLandedWorld({ verdictsRequired: false });
  agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(world.projectId, agentId, 'admin');
  agentToken = (
    await mintPat({
      userId: agentId,
      name: 'autoflow-master',
      projectIds: [world.projectId],
      permissions: ['*'],
    })
  ).plaintext;
});

/** The drafted release, as `token` reads it. */
async function draft(token = world.token): Promise<Release> {
  const listed = await api(token, 'GET', `/api/projects/${world.projectId}/releases`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  const version = (listed.body.releases as Array<{ version: string; state: string }>).find(
    (r) => r.state === 'draft',
  )?.version;
  expect(version, JSON.stringify(listed.body)).toBeTruthy();
  const res = await api(token, 'GET', `/api/projects/${world.projectId}/releases/${version}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.release as Release;
}

const decide = (token: string, version: string, body: Record<string, unknown>) =>
  api(token, 'POST', `/api/projects/${world.projectId}/releases/${version}/approval`, body);

describe('ISS-869: a release with no production is decided as a draft by its listed approvers', () => {
  it('lists the people who approve it, never the agent, and offers the decision to whoever holds releases.approve', async () => {
    await landedIssue(5, F4);
    const byOwner = await draft();
    expect(byOwner.state).toBe('draft');
    expect(byOwner.approvers.map((a) => a.id)).toEqual([world.ownerId]);
    expect(byOwner.approvers.map((a) => a.kind)).not.toContain('agent');
    expect(byOwner.can.decide).toBe(true);
    expect(byOwner.draftApproval).toBeNull();

    const byAgent = await draft(agentToken);
    expect(byAgent.approvers.map((a) => a.id)).not.toContain(agentId);
    // ISS-914, ADR 0007: approval is the permission alone, so the agent holding it may decide
    expect(byAgent.can.decide).toBe(true);
  });

  it('records the owner’s approval keyed on the version, with no run and no commit', async () => {
    await landedIssue(5, F4);
    const { version } = await draft();
    const res = await decide(world.token, version, {
      decision: 'approve',
      reason: 'Release notes read; open the upstream MR',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ version, decision: 'approved' });

    const after = await draft();
    expect(after.state).toBe('draft');
    expect(after.draftApproval).toMatchObject({
      version,
      decision: 'approved',
      decidedBy: { id: world.ownerId },
      reason: 'Release notes read; open the upstream MR',
    });
    const [count] = (await db.execute(
      sql`SELECT count(*)::int AS runs FROM pipeline_runs WHERE project_id = ${world.projectId}`,
    )) as unknown as Array<{ runs: number }>;
    expect(count?.runs).toBe(0);
  });

  it('stands only for the roster it was given on', async () => {
    await landedIssue(5, F4);
    const { version } = await draft();
    expect((await decide(world.token, version, { decision: 'approve' })).status).toBe(201);
    await landedIssue(6, F4);
    expect((await draft()).draftApproval).toBeNull();
  });

  it('takes the approval of an agent’s token holding releases.approve, naming the agent (ISS-914)', async () => {
    await landedIssue(5, F4);
    const { version } = await draft();
    const res = await decide(agentToken, version, { decision: 'approve', reason: 'mine' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await draft()).draftApproval).toMatchObject({
      decision: 'approved',
      decidedBy: { id: agentId },
      reason: 'mine',
    });
  });

  it('refuses a carry on a draft, which no checklist judges, and records nothing (ISS-914)', async () => {
    await landedIssue(5, F4);
    const { version } = await draft();
    const res = await decide(world.token, version, {
      decision: 'approve',
      reason: 'ok',
      carry: { all: true, why: 'flag off on stg' },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RELEASE_APPROVAL_SHAPE');
    expect(JSON.stringify(res.body)).toContain('/carry');
    expect((await draft()).draftApproval).toBeNull();
  });

  it('refuses a person who holds no releases.approve', async () => {
    await landedIssue(5, F4);
    const { version } = await draft();
    const member = (await createTestUser({ verified: true })).id;
    await addProjectMember(world.projectId, member, 'member');
    const res = await decide(await userToken(member), version, { decision: 'approve' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('releases.approve');
  });

  it('refuses a version that is not the draft, and a return with no reason, by name', async () => {
    await landedIssue(5, F4);
    const { version } = await draft();
    const other = await decide(world.token, '9.9.9', { decision: 'approve' });
    expect(other.status).toBe(404);
    expect(other.body.code).toBe('RELEASE_VERSION_UNKNOWN');
    expect(JSON.stringify(other.body)).toContain(version);
    const bare = await decide(world.token, version, { decision: 'return' });
    expect(bare.body.code).toBe('RELEASE_RETURN_WITHOUT_REASON');
    const returned = await decide(world.token, version, {
      decision: 'return',
      reason: 'Hold until the upstream freeze lifts',
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    expect((await draft()).draftApproval).toMatchObject({ decision: 'returned' });
  });

  it('refuses a draft decision where the project declares production, naming the run’s approval', async () => {
    await seedProjectDocument(world.projectId, world.ownerId, {
      environments: { live: { tier: 'production', deployment: { mode: 'external' } } },
    });
    await landedIssue(5, F4);
    const { version, can } = await draft();
    expect(can.decide).toBe(false);
    const res = await decide(world.token, version, { decision: 'approve' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RELEASE_DRAFT_NOT_APPROVABLE');
    expect(JSON.stringify(res.body)).toContain('release-batches/<runId>/approvals');
  });

  // ISS-1019: catalog-fe's 0.13.0 offered "Approve release" while its gate stood at NO_RELEASE_GATE,
  // and its page named neither the blocker nor what the release becomes.
  it('names a no-production draft recorded by its master, not cut, and offers the decision on it as its door takes it', async () => {
    await landedIssue(5, F4);
    const d = await draft();
    expect(d.gates.map((g) => g.code)).toContain('NO_RELEASE_GATE');
    expect(d.can).toMatchObject({ cut: false, decide: true });
    const page = await pageOf(d.version);
    expect(page.header.recordedNotCut).toBe(true);
    expect(page.can.approve).toBe(true);
    expect(
      (await decide(world.token, d.version, { decision: 'approve', reason: 'ok' })).status,
    ).toBe(201);
  });

  it('offers no draft decision on a project releasing through its change requests, and its door refuses one by name', async () => {
    await landedIssue(5, F4);
    await seedProjectDocument(world.projectId, world.ownerId, {
      environments: {},
      defaultBranch: BRANCH,
      extra: { release: { approval: { required: false }, changeRequests: true } },
    });
    const d = await draft();
    expect(d.gates.map((g) => g.code)).not.toContain('NO_RELEASE_GATE');
    expect(d.can.decide).toBe(false);
    const page = await pageOf(d.version);
    expect(page.header.recordedNotCut).toBe(false);
    expect(page.can.approve).toBe(false);
    const res = await decide(world.token, d.version, { decision: 'approve', reason: 'ok' });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('RELEASE_DRAFT_NOT_APPROVABLE');
    expect(JSON.stringify(res.body)).toContain('release.changeRequests');
    expect((await draft()).draftApproval).toBeNull();
  });
});

// ISS-1075 (FB-543): autoflow requires a person's release approval and declares no production. Its
// 0.1.0 offered "record the landing" to the master, which closes the release's issues before the
// approver decided. The record is the approver's until the approval stands, then the master's.
describe('ISS-1075: a record that a required approval holds', () => {
  beforeEach(async () => {
    await seedLandedWorld({ verdictsRequired: false, approvalRequired: true });
  });

  const recordOwner = async (token = world.token) => {
    const listed = await api(token, 'GET', `/api/projects/${world.projectId}/releases`);
    const version = (listed.body.releases as Array<{ version: string; state: string }>).find(
      (r) => r.state === 'draft',
    )?.version as string;
    const res = await api(token, 'GET', `/api/projects/${world.projectId}/releases/${version}`);
    const gate = (
      res.body.release as { gates: Array<{ code: string; owner: { kind: string } }> }
    ).gates.find((g) => g.code === 'NO_RELEASE_GATE');
    return { version, kind: gate?.owner.kind };
  };

  it('names the approver for the record, owes the master nothing, and is the master’s once approved', async () => {
    await landedIssue(5, F4);
    const before = await recordOwner();
    expect(before.kind, 'the master was offered a record the approval holds').toBe('person');
    const { releaseActsOwed } = await import('../../src/release-batch/master-owed-acts.js');
    const owed = JSON.stringify(await releaseActsOwed(world.projectId));
    expect(owed).not.toContain('record the landing');

    expect(
      (await decide(world.token, before.version, { decision: 'approve', reason: 'ok' })).status,
    ).toBe(201);
    expect((await recordOwner()).kind).toBe('agent');
  });

  // round 3 (FB-543 reopened): autoflow's own agent holds releases.approve, so its read said
  // "You" and can.decide true while every other surface named the person who owes the approval
  it('reads the approval as the person’s to an agent holding releases.approve, and offers it no decision', async () => {
    await landedIssue(5, F4);
    const { version } = await recordOwner();
    const agent = (await createTestUser({ kind: 'agent' })).id;
    await addProjectMember(world.projectId, agent, 'admin');
    const token = (
      await mintPat({
        userId: agent,
        name: 'autoflow-master',
        projectIds: [world.projectId],
        permissions: ['*'],
      })
    ).plaintext;
    const res = await api(token, 'GET', `/api/projects/${world.projectId}/releases/${version}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const release = res.body.release as {
      can: { decide: boolean };
      waitingOn: { kind: string };
      gates: Array<{ code: string; owner: { kind: string } }>;
    };
    expect(release.gates.find((g) => g.code === 'NO_RELEASE_GATE')?.owner.kind).toBe('person');
    expect(release.waitingOn.kind, 'the agent was told the approval is its own').toBe('person');
    expect(release.can.decide, 'the agent was offered the person’s decision').toBe(false);
    // the person who owes it still reads it as theirs
    const mine = await api(
      world.token,
      'GET',
      `/api/projects/${world.projectId}/releases/${version}`,
    );
    const own = mine.body.release as { can: { decide: boolean }; waitingOn: { kind: string } };
    expect(own.waitingOn.kind).toBe('you');
    expect(own.can.decide).toBe(true);
  });

  // round 2: the act the approver owes is the approval, a decision their Needs you holds and presses;
  // read live on dev.554, autoflow's owner had nothing in Needs you while the release waited on them
  it('puts the approval in the approver’s Needs you, the gate naming it first, and pressing it frees the record', async () => {
    await landedIssue(5, F4);
    const { version } = await recordOwner();
    const res = await api(
      world.token,
      'GET',
      `/api/projects/${world.projectId}/releases/${version}`,
    );
    const gate = (
      res.body.release as { gates: Array<{ code: string; detail: string; owner: { act: string } }> }
    ).gates.find((g) => g.code === 'NO_RELEASE_GATE');
    expect(gate?.owner.act, 'the approver was told to record, not to approve').toMatch(/^approve/i);
    expect(gate?.detail, 'the gate sent the reader to record before the approval').toMatch(
      /approv[^.]*before[^.]*record/i,
    );

    const read = await api(
      world.token,
      'GET',
      `/api/projects/${world.projectId}/needs-you/decisions`,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    type Answer = { id: string; act: string; path: string; body: Record<string, unknown> };
    const decisions = read.body.decisions as Array<{ key: string; answers: Answer[] }>;
    const mine = decisions.find((d) => d.key === version);
    expect(mine, `no decision on ${version} in ${JSON.stringify(decisions)}`).toBeDefined();
    const approve = mine?.answers.find((a) => a.id === 'approve') as Answer;
    expect(approve.act).toBe('release.decideDraft');

    const pressed = await api(world.token, 'POST', approve.path, {
      ...approve.body,
      reason: 'ok',
    });
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(201);
    expect((await recordOwner()).kind).toBe('agent');
  });
});
