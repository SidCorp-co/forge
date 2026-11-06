// @direct-test-of packages/core/src/permissions/master-acts.ts
// @direct-test-of packages/core/src/release-batch/routes.ts
// @direct-test-of packages/core/src/release-batch/record-blocker.ts
// @direct-test-of packages/core/src/issues/draft-release-notes.ts
/**
 * REQ-79 r6 BC-17 (owner ruling 2026-10-31): a project's master alone takes a landed issue through
 * release to close. Outside strict its agent token cuts and records the release that closes it
 * (a release's close is reachable by an agent), and an issue with no release note gets one
 * drafted at that door, never a refusal. Under strict both stay as they were: the cut and the record
 * ask project.admin, and a missing note is refused RELEASE_RECORD_MISSING. Over REST, real Postgres,
 * on a project with no production environment, whose landing is its release.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import {
  F4,
  judgedAll,
  landedIssue,
  refusalsOf,
  seedLandedWorld,
  statusOf,
  world,
} from '../helpers/landed-world.js';
import { declareControls } from '../helpers/project-controls.js';

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

const ACCOUNT = 'Landed on release/stg by the master; nothing deploys from there.';

let agentToken = '';
let memberToken = '';

beforeEach(async () => {
  await seedLandedWorld();
  // the project's own agent: an agent account holding the member role, as a handle is minted
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(world.projectId, agentId, 'member');
  agentToken = (
    await mintPat({
      userId: agentId,
      name: 'master',
      projectIds: [world.projectId],
      permissions: ['*'],
    })
  ).plaintext;
  // a person holding the same role: no master, whatever the profile
  const memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(world.projectId, memberId, 'member');
  memberToken = (
    await mintPat({
      userId: memberId,
      name: 'cli',
      projectIds: [world.projectId],
      permissions: ['*'],
    })
  ).plaintext;
});

const strict = () =>
  declareControls(world.projectId, world.ownerId, { gates: { profile: 'strict' } });

const recordAs = (token: string, issueIds: string[]) =>
  api(token, 'POST', `/api/projects/${world.projectId}/release-records`, {
    issueIds,
    commit: F4,
    account: ACCOUNT,
  });

const cutAs = (token: string, issueIds: string[]) =>
  api(token, 'POST', `/api/projects/${world.projectId}/release-batches`, { issueIds });

async function judgedLanding(seq: number): Promise<string> {
  const id = await landedIssue(seq, F4);
  await judgedAll(id, F4);
  return id;
}

const noteOf = async (issueId: string) => {
  const [row] = (await db.execute(
    sql`SELECT release_notes FROM issues WHERE id = ${issueId}`,
  )) as unknown as Array<{ release_notes: Record<string, unknown> | null }>;
  return row?.release_notes ?? null;
};

describe('BC-17: outside strict the master records the release that closes a landed issue', () => {
  it("records the landing with the master's agent token and closes the issue", async () => {
    const issue = await judgedLanding(5);

    const res = await recordAs(agentToken, [issue]);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ closed: [issue] });
    expect(await statusOf(issue)).toBe('closed');
  });

  it('passes the cut door to the next reason, which is no permission', async () => {
    const issue = await judgedLanding(6);

    const res = await cutAs(agentToken, [issue]);

    expect(refusalsOf(res.body).map((r) => r.code)).not.toContain('PERMISSION_FORBIDDEN');
    expect(res.status).not.toBe(403);
  });

  it("refuses a person's member token as before: a master is an agent's credential", async () => {
    const issue = await judgedLanding(7);

    const res = await recordAs(memberToken, [issue]);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(refusalsOf(res.body).map((r) => r.code)).toEqual(['PERMISSION_FORBIDDEN']);
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('under strict refuses the same agent token at both doors, naming project.admin', async () => {
    // landed before the project turned strict, whose merge mark asks a merge check
    const issue = await judgedLanding(8);
    await strict();

    const recorded = await recordAs(agentToken, [issue]);
    const cut = await cutAs(agentToken, [issue]);

    for (const res of [recorded, cut]) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      const [refusal] = refusalsOf(res.body);
      expect(refusal?.code).toBe('PERMISSION_FORBIDDEN');
      expect(refusal?.detail).toContain('project.admin');
    }
    expect(await statusOf(issue)).toBe('awaiting_release');
  });
});

describe('outside strict a missing release note is drafted at the door, never a refusal', () => {
  async function unwritten(seq: number, category: string | null): Promise<string> {
    const id = await judgedLanding(seq);
    await db.execute(
      sql`UPDATE issues SET release_notes = NULL, category = ${category} WHERE id = ${id}`,
    );
    return id;
  }

  it('drafts the note from the issue, with no short title, so the master fills it in later', async () => {
    const issue = await unwritten(9, 'bug');

    const res = await recordAs(world.token, [issue]);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await statusOf(issue)).toBe('closed');
    expect(await noteOf(issue)).toEqual({ section: 'Fixed', userFacing: 'issue 9' });
  });

  it('keeps a written note as it was', async () => {
    const issue = await judgedLanding(10);
    const before = await noteOf(issue);

    expect((await recordAs(world.token, [issue])).status).toBe(201);
    expect(await noteOf(issue)).toEqual(before);
  });

  it('under strict refuses the record RELEASE_RECORD_MISSING and drafts nothing', async () => {
    const issue = await unwritten(11, null);
    await strict();

    const res = await recordAs(world.token, [issue]);

    expect(refusalsOf(res.body).map((r) => r.code)).toContain('RELEASE_RECORD_MISSING');
    expect(await noteOf(issue)).toBeNull();
    expect(await statusOf(issue)).toBe('awaiting_release');
  });
});
