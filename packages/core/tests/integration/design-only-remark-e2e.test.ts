/**
 * ISS-570 (FB-142), REQ-45 BC-4: an issue whose deliverable is a design it drew is marked again on
 * its approved revisions, and its agent closes it through `design_delivered`.
 *
 * hop, 2026-10-08: a design issue whose approval stamp was cleared held an approved revision and no
 * code, so its agent's mark was refused NO_WORK_EVIDENCE (`work-evidence.ts` counts code alone) and
 * the close refused DESIGN_NOT_DELIVERED (the close reads design-only off the mark). Here the same
 * shape: the approval stamps, the mark is cleared, the agent marks it again and closes it.
 *
 * @direct-test-of packages/core/src/issues/merge-marker.ts
 * @direct-test-of packages/core/src/issues/design-delivery.ts
 * @direct-test-of packages/core/src/issues/merge-mark-kind.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { boxToken } from '../helpers/preview-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
let person: string;
let agent: string;
let workflowId: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  await seedProjectDocument(projectId, ownerId, { environments: {}, defaultBranch: 'dev' });
  person = await userToken(ownerId);
  agent = await boxToken(ownerId, await createTestDevice(ownerId));
  workflowId = randomUUID();
  await db.execute(sql`
    INSERT INTO project_workflows (id, project_id, flow, kind, revision, document, written_by_user)
    VALUES (${workflowId}, ${projectId}, 'issue-lifecycle', 'flow', 1, '{}'::jsonb, ${ownerId})
  `);
});

let seq = 0;
async function unmarkedIssue(): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`design ${seq}`}, 'in_progress', ${ownerId})
  `);
  return id;
}

async function drawRevision(
  issueId: string,
  revision: number,
  decision: 'approve' | null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO project_workflow_designs
      (workflow_id, revision, document, proposed_by_user, design_issue_id,
       decision, decided_by_user, decided_at)
    VALUES (${workflowId}, ${revision}, '{}'::jsonb, ${ownerId}, ${issueId},
            ${decision}, ${decision ? ownerId : null}, ${decision ? sql`now()` : null})
  `);
}

async function markOf(id: string) {
  const [row] = await rows<{
    merged_at: unknown;
    merged_commit_sha: string | null;
    merged_artifacts: unknown;
    status: string;
  }>(
    sql`SELECT merged_at, merged_commit_sha, merged_artifacts, status FROM issues WHERE id = ${id}`,
  );
  return row;
}

function refusal(res: ApiResponse): { code: string; detail: string } {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  const listed = (res.body.error as { refusals?: Array<{ code: string; detail: string }> })
    ?.refusals?.[0];
  return { code: listed?.code ?? String(res.body.code), detail: listed?.detail ?? '' };
}

const mark = (token: string, id: string, body: Record<string, unknown> = { target: 'dev' }) =>
  api(token, 'POST', `/api/issues/${id}/merge`, body);
const close = (token: string, id: string) =>
  api(token, 'POST', `/api/issues/${id}/transition`, { toStatus: 'closed' });

const REV2 = [{ surface: 'design', ref: 'issue-lifecycle@rev2', change: 'changed' }];

describe('criterion 1: an agent re-marks a design issue on its approved revision and closes it', () => {
  it('marks again after the approval stamp was cleared, records the revision as design, and closes', async () => {
    const id = await unmarkedIssue();
    await drawRevision(id, 2, 'approve');
    // the stamp an approval writes, then cleared: the issue holds the revision and no mark
    await db.execute(
      sql`UPDATE issues SET merged_at = now(), merged_artifacts = ${JSON.stringify(REV2)}::jsonb WHERE id = ${id}`,
    );
    expect((await api(agent, 'DELETE', `/api/issues/${id}/merge`)).status).toBe(200);
    expect((await markOf(id))?.merged_at).toBeNull();

    const marked = await mark(agent, id);
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);
    expect(marked.body.action).toBe('merged');
    expect(marked.body.artifacts).toEqual(REV2);
    expect(String(marked.body.detail)).toContain('approved design issue-lifecycle@rev2');
    const held = await markOf(id);
    expect(held?.merged_at).not.toBeNull();
    expect(held?.merged_commit_sha).toBeNull();
    expect(held?.merged_artifacts).toEqual(REV2);

    const closed = await close(agent, id);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await markOf(id))?.status).toBe('closed');
  });

  it('names the newest approved revision of each workflow it drew, and a person marks it the same way', async () => {
    const id = await unmarkedIssue();
    await drawRevision(id, 2, 'approve');
    await drawRevision(id, 3, 'approve');

    const marked = await mark(person, id);
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);
    expect(marked.body.artifacts).toEqual([
      { surface: 'design', ref: 'issue-lifecycle@rev3', change: 'changed' },
    ]);
    expect((await close(person, id)).status).toBe(200);
  });
});

describe('criterion 2: no approved revision, no mark', () => {
  it('refuses NO_WORK_EVIDENCE naming the drawn revision that waits on its approver', async () => {
    const id = await unmarkedIssue();
    await drawRevision(id, 2, null);

    const refused = refusal(await mark(agent, id));
    expect(refused.code).toBe('NO_WORK_EVIDENCE');
    expect(refused.detail).toContain('issue-lifecycle rev 2 is not approved');
    expect((await markOf(id))?.merged_at).toBeNull();
    expect(refusal(await close(agent, id)).code).toBe('DESIGN_NOT_DELIVERED');
  });

  it('refuses NO_WORK_EVIDENCE as before on an issue that drew no design', async () => {
    const id = await unmarkedIssue();
    const refused = refusal(await mark(agent, id));
    expect(refused.code).toBe('NO_WORK_EVIDENCE');
    expect(refused.detail).not.toContain('not approved');
    expect((await markOf(id))?.merged_at).toBeNull();
  });
});

describe('criterion 3: approved designs never stand in for code', () => {
  it('marks an issue carrying a branch as before, never as its approved revision', async () => {
    const id = await unmarkedIssue();
    await drawRevision(id, 2, 'approve');
    const patched = await api(agent, 'PATCH', `/api/issues/${id}`, {
      workState: { step: 'plan', branch: 'feat/design-and-code', headSha: 'a'.repeat(40) },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    const marked = await mark(agent, id);
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);
    expect((await markOf(id))?.merged_artifacts).toBeNull();
    expect(refusal(await close(agent, id)).code).toBe('DESIGN_NOT_DELIVERED');
  });

  it('refuses an issue linked as a workflow build: the approval is evidence there, not its landing', async () => {
    const id = await unmarkedIssue();
    await drawRevision(id, 2, 'approve');
    await db.execute(sql`
      INSERT INTO workflow_builds (issue_id, workflow_id, project_id, linked_by_user)
      VALUES (${id}, ${workflowId}, ${projectId}, ${ownerId})
    `);

    expect(refusal(await mark(agent, id)).code).toBe('NO_WORK_EVIDENCE');
    expect((await markOf(id))?.merged_at).toBeNull();
  });

  it('keeps a landing sent beside it on its own route rather than taking the design for it', async () => {
    const id = await unmarkedIssue();
    await drawRevision(id, 2, 'approve');
    const refused = refusal(await mark(agent, id, { target: 'dev', commit: 'c'.repeat(40) }));
    expect(refused.code).not.toBe('NO_WORK_EVIDENCE');
    expect((await markOf(id))?.merged_artifacts).toBeNull();
  });
});
