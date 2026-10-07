/**
 * A design hold follows the workflow's live revision. Only the newest revision of a workflow is
 * ever decided, so a revision a later write superseded undecided can never be approved: a blocks
 * edge from the issue that delivered it holds on the newest revision instead, and lifts when that
 * one is approved (hop ISS-44 held ISS-46..48 on a superseded rev 4 while rev 5 went on).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { blockingEdgesIn } from '../../src/issues/blocked-by.js';
import { designHoldPhrase, designHoldsOf } from '../../src/issues/design-delivery.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let workflowId: string;
let seq = 0;

async function issueAt(status: string): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId})
    `),
  );
  return id;
}

async function revision(n: number, designIssue: string | null, decision: 'approve' | null) {
  await db.execute(sql`
    INSERT INTO project_workflow_designs
      (workflow_id, revision, document, proposed_by_user, design_issue_id,
       decision, decided_by_user, decided_at)
    VALUES (${workflowId}, ${n}, '{}'::jsonb, ${ownerId}, ${designIssue},
            ${decision}, ${decision ? ownerId : null}, ${decision ? sql`now()` : null})
  `);
}

async function approve(n: number) {
  await db.execute(sql`
    UPDATE project_workflow_designs
       SET decision = 'approve', decided_by_user = ${ownerId}, decided_at = now()
     WHERE workflow_id = ${workflowId} AND revision = ${n}
  `);
}

async function edge(from: string, to: string) {
  await db.execute(sql`
    INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
    VALUES (${projectId}, ${from}, ${to}, 'blocks')
  `);
}

async function heldPhrase(issueId: string): Promise<string | null> {
  const holds = (await designHoldsOf(db, [issueId])).get(issueId);
  return holds ? designHoldPhrase(holds) : null;
}

async function edgeHolds(from: string, to: string): Promise<boolean> {
  const edges = await blockingEdgesIn(db, projectId, [to]);
  return edges.find((e) => e.fromId === from && e.toId === to)?.holds ?? false;
}

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  workflowId = randomUUID();
  await db.execute(sql`
    INSERT INTO project_workflows (id, project_id, flow, kind, revision, document, written_by_user)
    VALUES (${workflowId}, ${projectId}, 'hop-source-integration', 'flow', 1, '{}'::jsonb, ${ownerId})
  `);
});

describe('a design hold on a superseded revision', () => {
  it('follows the newest revision, naming it, while that one waits on its approver', async () => {
    const inherited = await issueAt('awaiting_release');
    const drawing = await issueAt('in_progress');
    const build = await issueAt('open');
    await edge(inherited, build);
    await revision(3, null, 'approve');
    await revision(4, inherited, null);
    await revision(5, drawing, null);

    expect(await heldPhrase(inherited)).toBe('design hop-source-integration rev 5 is not approved');
    expect(await edgeHolds(inherited, build)).toBe(true);
  });

  it('lifts once the newest revision is approved, though the superseded one never was', async () => {
    const inherited = await issueAt('awaiting_release');
    const drawing = await issueAt('in_progress');
    const build = await issueAt('open');
    await edge(inherited, build);
    await revision(3, null, 'approve');
    await revision(4, inherited, null);
    await revision(5, drawing, null);

    await approve(5);

    expect(await heldPhrase(inherited)).toBeNull();
    expect(await edgeHolds(inherited, build)).toBe(false);
  });

  it('still holds on an issue whose own revision is the newest and undecided', async () => {
    const drawing = await issueAt('awaiting_release');
    const build = await issueAt('open');
    await edge(drawing, build);
    await revision(1, null, 'approve');
    await revision(2, drawing, null);

    expect(await heldPhrase(drawing)).toBe('design hop-source-integration rev 2 is not approved');
    expect(await edgeHolds(drawing, build)).toBe(true);
  });

  it('holds nothing once the revision the issue delivered is approved, whatever came after', async () => {
    const drawing = await issueAt('awaiting_release');
    const build = await issueAt('open');
    await edge(drawing, build);
    await revision(1, drawing, 'approve');
    await revision(2, null, null);

    expect(await heldPhrase(drawing)).toBeNull();
    expect(await edgeHolds(drawing, build)).toBe(false);
  });
});
