// @direct-test-of packages/core/src/release-batch/draft-approval.ts
// @direct-test-of packages/core/src/release-batch/release-read-views.ts
// @direct-test-of packages/core/src/release-batch/version-routes.ts
// @direct-test-of packages/core/src/release-batch/release-read.ts
// @direct-test-of packages/core/src/permissions/holders-named.ts
// @direct-test-of packages/core/src/release-page/sections.ts
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
    const page = await api(
      world.token,
      'GET',
      `/api/projects/${world.projectId}/releases/${d.version}/page?view=user`,
    );
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.header.recordedNotCut).toBe(true);
    expect(page.body.can.approve).toBe(true);
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
    const page = await api(
      world.token,
      'GET',
      `/api/projects/${world.projectId}/releases/${d.version}/page?view=user`,
    );
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.header.recordedNotCut).toBe(false);
    expect(page.body.can.approve).toBe(false);
    const res = await decide(world.token, d.version, { decision: 'approve', reason: 'ok' });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('RELEASE_DRAFT_NOT_APPROVABLE');
    expect(JSON.stringify(res.body)).toContain('release.changeRequests');
    expect((await draft()).draftApproval).toBeNull();
  });
});
