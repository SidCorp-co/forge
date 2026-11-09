/**
 * A requirement whose landed issues an open release run already claims waits on that run's own act,
 * never on a cut of the next version (ISS-1186, FB-599): adminhub-api's REQ-23 read "cut 0.20.0"
 * while 0.19.0's run, waiting on its approvers, claimed ISS-219, its only issue. The claim is read in
 * one statement over the landed issues, beside the release leg.
 *
 * @direct-test-of packages/core/src/forecast/release.ts
 * @direct-test-of packages/core/src/requirements/standing-read.ts
 * @direct-test-of packages/core/src/release-batch/waiting-issues.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { releaseClaimsFor } from '../../src/forecast/release.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';

let projectId: string;
let ownerId: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
});

/** A release-batch run cut as `version`, claiming `issueIds`, in `status`. */
async function run(version: string, status: string, issueIds: string[], released = false) {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version,
                               release_released_at, metadata)
    VALUES (${id}, ${projectId}, 'system', ${status}, now(), ${version},
            ${released ? sql`now()` : sql`NULL`},
            ${JSON.stringify({ source: 'release-batch', issueIds })}::jsonb)`);
  for (const issueId of issueIds) {
    await db.execute(sql`UPDATE issues SET release_batch_run_id = ${id} WHERE id = ${issueId}`);
  }
  return id;
}

async function askApproval(runId: string, decision: string | null = null) {
  await db.execute(sql`
    INSERT INTO release_approvals (project_id, run_id, requested_by_user, evidence_commit,
                                   evidence_reading, decision, decided_by_user, decided_at)
    VALUES (${projectId}, ${runId}, ${ownerId}, ${'c'.repeat(40)}, 'served', ${decision},
            ${decision ? ownerId : null}, ${decision ? sql`now()` : sql`NULL`})`);
}

let seq = 0;
const landed = async () => {
  seq += 1;
  const at = new Date();
  return (
    await createTestIssue(projectId, ownerId, seq, {
      status: 'awaiting_release',
      createdAt: at,
      mergedAt: at,
    })
  ).id;
};

describe('the open release run claiming a landed issue, and the act it waits on (ISS-1186)', () => {
  it('names its approvers approving its version while its approval is undecided', async () => {
    const issue = await landed();
    const runId = await run('0.19.0', 'running', [issue]);
    await askApproval(runId);
    const claims = await releaseClaimsFor(projectId, ownerId, [issue]);
    expect(claims.byIssue.get(issue)).toBe(runId);
    const claim = claims.runs.get(runId);
    expect(claim?.version).toBe('0.19.0');
    expect(claim?.leg).toMatchObject({ kind: 'person', version: '0.19.0' });
    expect(claim?.leg && 'says' in claim.leg ? claim.leg.says.act : null).toEqual({
      key: 'standing.act.approveReleaseV',
      vars: { v: '0.19.0' },
    });
  });

  it('names the run at work once its approval is given, and nothing for a shipped or unclaimed issue', async () => {
    const [approved, shipped, free] = [await landed(), await landed(), await landed()];
    const runId = await run('0.19.0', 'running', [approved]);
    await askApproval(runId, 'approved');
    await run('0.18.0', 'completed', [shipped], true);
    const claims = await releaseClaimsFor(projectId, null, [approved, shipped, free]);
    expect(claims.runs.get(runId)).toEqual({ version: '0.19.0', leg: null });
    expect([...claims.byIssue.keys()]).toEqual([approved]);
    expect(await releaseClaimsFor(projectId, null, [])).toEqual({
      byIssue: new Map(),
      runs: new Map(),
    });
  });
});
