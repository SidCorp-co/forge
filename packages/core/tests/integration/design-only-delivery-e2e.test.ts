/**
 * REQ-45 BC-4: an issue whose merge mark names design revisions alone is design-only. A release
 * roster leaves it out, a batch naming nothing else is refused `RELEASE_ALL_DESIGN_ONLY`, and the
 * agent closes it once every revision it delivers is approved. Every other mark — a commit, read
 * paths, or a merge asserted with nothing named, which is every mark on a project with no source
 * host — is code, and stays on the roster.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { isRefusal } from '../../src/lib/refusal.js';
import { createReleaseBatch } from '../../src/release-batch/create.js';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { SKIP_NOTE, seedProduction, seedProjectDocument } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
let token: string;
let workflowId: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  workflowId = randomUUID();
  await db.execute(sql`
    INSERT INTO project_workflows (id, project_id, flow, kind, revision, document, written_by_user)
    VALUES (${workflowId}, ${projectId}, 'issue-lifecycle', 'flow', 1, '{}'::jsonb, ${ownerId})
  `);
});

type Mark = 'asserted' | 'commit' | 'design';

let seq = 0;
async function issueAt(status: string, mark: Mark): Promise<string> {
  const id = randomUUID();
  seq += 1;
  const sha = mark === 'commit' ? 'a'.repeat(40) : null;
  const artifacts =
    mark === 'design'
      ? JSON.stringify([{ surface: 'design', ref: 'issue-lifecycle rev 2', change: 'changed' }])
      : null;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes,
                        merged_at, merged_commit_sha, merged_artifacts)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId},
            ${JSON.stringify(SKIP_NOTE)}::jsonb, now(), ${sha}, ${artifacts}::jsonb)
  `);
  return id;
}

async function drawRevision(issueId: string, decision: 'approve' | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO project_workflow_designs
      (workflow_id, revision, document, proposed_by_user, design_issue_id,
       decision, decided_by_user, decided_at)
    VALUES (${workflowId}, 2, '{}'::jsonb, ${ownerId}, ${issueId},
            ${decision}, ${decision ? ownerId : null}, ${decision ? sql`now()` : null})
  `);
}

async function statusOf(id: string): Promise<string> {
  const [row] = await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`);
  return String(row?.status);
}

function refusalCodes(res: ApiResponse): string[] {
  const listed = (res.body.error as { refusals?: Array<{ code: string }> } | undefined)?.refusals;
  return listed?.map((r) => r.code) ?? [String(res.body.code)];
}

describe('the release roster (REQ-45 BC-4)', () => {
  it('keeps a merge asserted with no commit, paths or artifacts, and a commit mark, and leaves out a design-only mark', async () => {
    await seedProduction({ projectId, ownerId, config: { releaseRunnerLabel: 'release-box' } });
    const asserted = await issueAt('awaiting_release', 'asserted');
    const committed = await issueAt('awaiting_release', 'commit');
    const design = await issueAt('awaiting_release', 'design');

    const res = await api(token, 'GET', `/api/projects/${projectId}/release-batches/roster`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const listed = (res.body.issues as Array<{ id: string }>).map((i) => i.id);
    expect(listed).toContain(asserted);
    expect(listed).toContain(committed);
    expect(listed).not.toContain(design);
  });

  it('refuses a batch naming only design-only issues, and cuts nothing', async () => {
    const design = await issueAt('awaiting_release', 'design');

    const err = await createReleaseBatch({ projectId, userId: ownerId, issueIds: [design] }).catch(
      (e: unknown) => e,
    );

    expect(isRefusal(err, 'RELEASE_ALL_DESIGN_ONLY'), String(err)).toBe(true);
    const [runs] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pipeline_runs WHERE project_id = ${projectId}`,
    );
    expect(runs?.n).toBe(0);
  });
});

describe('the design-only close (REQ-45 BC-4)', () => {
  beforeEach(async () => {
    await seedProjectDocument(projectId, ownerId, { environments: {} });
  });

  it('closes a design-only issue from in_progress once its revision is approved', async () => {
    const id = await issueAt('in_progress', 'design');
    await drawRevision(id, 'approve');

    const res = await api(token, 'POST', `/api/issues/${id}/transition`, { toStatus: 'closed' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(id)).toBe('closed');
  });

  // issue-lifecycle revision 24: draft → closed is the owed filing's edge, which a design-only draft
  // still closes along on its approved design (ISS-774)
  it('closes a design-only draft once its revision is approved', async () => {
    const id = await issueAt('draft', 'design');
    await drawRevision(id, 'approve');

    const res = await api(token, 'POST', `/api/issues/${id}/transition`, { toStatus: 'closed' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(id)).toBe('closed');
  });

  it('refuses the close while the revision it delivers waits on its approver', async () => {
    const id = await issueAt('in_progress', 'design');
    await drawRevision(id, null);

    const res = await api(token, 'POST', `/api/issues/${id}/transition`, { toStatus: 'closed' });

    expect(res.status).toBe(422);
    expect(refusalCodes(res)).toEqual(['DESIGN_NOT_DELIVERED']);
    expect(await statusOf(id)).toBe('in_progress');
  });

  it('refuses the close of an issue whose merge was asserted with nothing named', async () => {
    const id = await issueAt('in_progress', 'asserted');

    const res = await api(token, 'POST', `/api/issues/${id}/transition`, { toStatus: 'closed' });

    expect(res.status).toBe(422);
    expect(refusalCodes(res)).toEqual(['DESIGN_NOT_DELIVERED']);
    expect(await statusOf(id)).toBe('in_progress');
  });
});

// A design approval stamps the issue that drew it (`design-landing.ts:markApprovedDesign`). On
// forge-dev, 2026-10-14, that stamp alone let ISS-526, a code carrier, enter `awaiting_release`
// before any code was marked. `awaiting_release` waits for a release, and none carries a design-only
// issue, so the stamp never enters it; it still closes a design-only issue (`design_delivered`).
describe('a design stamp alone does not enter awaiting_release', () => {
  beforeEach(async () => {
    await seedProjectDocument(projectId, ownerId, { environments: {} });
  });

  it('refuses awaiting_release by name on an issue whose only mark is a design approval', async () => {
    const id = await issueAt('in_progress', 'design');
    await drawRevision(id, 'approve');

    const res = await api(token, 'POST', `/api/issues/${id}/transition`, {
      toStatus: 'awaiting_release',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(refusalCodes(res)).toEqual(['MERGE_DESIGN_ONLY']);
    expect(JSON.stringify(res.body)).toContain('issue-lifecycle rev 2');
    expect(JSON.stringify(res.body)).toContain('changedPaths');
    expect(await statusOf(id)).toBe('in_progress');
  });

  it('lets the same issue on once a commit is marked over the stamp', async () => {
    const id = await issueAt('in_progress', 'design');
    await db.execute(sql`UPDATE issues SET merged_commit_sha = ${'b'.repeat(40)} WHERE id = ${id}`);

    const res = await api(token, 'POST', `/api/issues/${id}/transition`, {
      toStatus: 'awaiting_release',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(id)).toBe('awaiting_release');
  });

  it('still closes a design-only issue on its stamp once its revision is approved', async () => {
    const id = await issueAt('in_progress', 'design');
    await drawRevision(id, 'approve');

    const res = await api(token, 'POST', `/api/issues/${id}/transition`, { toStatus: 'closed' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(id)).toBe('closed');
  });
});
