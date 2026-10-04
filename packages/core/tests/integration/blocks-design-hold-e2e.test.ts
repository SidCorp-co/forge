import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let userId: string;
let projectId: string;
let deviceToken: string;
let app: { request: (path: string, init?: RequestInit) => Promise<Response> };

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  ({ app } = (await import('../../src/index.js')) as unknown as { app: typeof app });
});

afterAll(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, userId)).id;
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId: userId, name: 'design-box', platform: 'linux' });
  deviceToken = issued.plaintext;
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, name, type, status)
    VALUES (${randomUUID()}, ${projectId}, ${issued.device.id}, 'design-runner', 'claude-code', 'online')
  `);
});

async function issue(seq: number, status = 'open'): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${userId},
            CASE WHEN ${status} = 'closed' THEN now() END)
  `);
  return id;
}

async function blocks(from: string, to: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind)
    VALUES (${randomUUID()}, ${projectId}, ${from}, ${to}, 'blocks')
  `);
}

async function workflow(flow: string, revision: number): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO project_workflows (id, project_id, flow, kind, status, revision, document, design_status, written_by_user)
    VALUES (${id}, ${projectId}, ${flow}, 'state', 'designed', ${revision}, '{}'::jsonb, 'proposed', ${userId})
  `);
  return id;
}

async function proposed(workflowId: string, revision: number, designIssue: string | null) {
  await harness.db.execute(sql`
    INSERT INTO project_workflow_designs (workflow_id, revision, document, proposed_by_user, design_issue_id)
    VALUES (${workflowId}, ${revision}, '{}'::jsonb, ${userId}, ${designIssue})
  `);
}

async function decide(workflowId: string, revision: number, decision: 'approve' | 'return') {
  await harness.db.execute(sql`
    UPDATE project_workflow_designs
       SET decision = ${decision}, decided_by_user = ${userId}, decided_at = now(),
           reason = ${decision === 'return' ? 'not yet' : null}
     WHERE workflow_id = ${workflowId} AND revision = ${revision}
  `);
}

async function designVerdict(issueId: string, workflowId: string, revision: number) {
  const criterion = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issue_criteria (id, issue_id, n, statement, position)
    VALUES (${criterion}, ${issueId}, 1, 'the revision is drawn', 0)
  `);
  await harness.db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, design_workflow_id, design_revision, author_agency)
    VALUES (${criterion}, ${issueId}, 'pass', 'design', ${workflowId}, ${revision}, 'agent')
  `);
}

async function admissible(): Promise<string[]> {
  const res = await app.request('/api/devices/me/issues/admissible', {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ issueKey: string }> };
  return body.items.map((i) => i.issueKey).sort();
}

describe('FB-57 a blocks edge from an issue that delivers a design (real Postgres)', () => {
  it('holds the dependent while the revision the blocker proposed is only proposed, whatever its status', async () => {
    await issue(99);
    const blocker = await issue(1, 'awaiting_release');
    const held = await issue(2);
    await blocks(blocker, held);
    const wf = await workflow('hop-access-decision', 5);
    await proposed(wf, 5, blocker);

    expect(await admissible()).toEqual(['ISS-99']);

    await harness.db.execute(
      sql`UPDATE issues SET status = 'closed', merged_at = now() WHERE id = ${blocker}`,
    );
    expect(await admissible()).toEqual(['ISS-99']);
  });

  it('releases it once that revision is approved', async () => {
    const blocker = await issue(1, 'awaiting_release');
    const held = await issue(2);
    await blocks(blocker, held);
    const wf = await workflow('hop-access-decision', 5);
    await proposed(wf, 5, blocker);
    await decide(wf, 5, 'approve');

    expect(await admissible()).toEqual(['ISS-2']);
  });

  it('keeps holding it when the revision was returned, and reads the latest revision it proposed', async () => {
    await issue(99);
    const blocker = await issue(1, 'awaiting_release');
    const held = await issue(2);
    await blocks(blocker, held);
    const wf = await workflow('hop-access-decision', 6);
    await proposed(wf, 5, blocker);
    await decide(wf, 5, 'approve');
    await proposed(wf, 6, blocker);
    await decide(wf, 6, 'return');

    expect(await admissible()).toEqual(['ISS-99']);
  });

  it('holds on a design verdict too: an issue judged against a revision delivers it', async () => {
    await issue(99);
    const blocker = await issue(1, 'awaiting_release');
    const held = await issue(2);
    await blocks(blocker, held);
    const wf = await workflow('hop-identity', 2);
    await proposed(wf, 2, null);
    await designVerdict(blocker, wf, 2);

    expect(await admissible()).toEqual(['ISS-99']);
    await decide(wf, 2, 'approve');
    expect(await admissible()).toEqual(['ISS-2', 'ISS-99']);
  });

  it('planted control: a blocker that delivers no design still settles on its status alone', async () => {
    const blocker = await issue(1, 'awaiting_release');
    const held = await issue(2);
    await blocks(blocker, held);
    const wf = await workflow('someone-else', 1);
    await proposed(wf, 1, null);

    expect(await admissible()).toEqual(['ISS-2']);
  });

  it('the standing read and the dependency read say the dependent waits on the design approval', async () => {
    const blocker = await issue(1, 'awaiting_release');
    const held = await issue(2);
    await blocks(blocker, held);
    const wf = await workflow('hop-access-decision', 5);
    await proposed(wf, 5, blocker);

    const { listIssueStanding } = await import('../../src/issues/standing-read.js');
    const list = await listIssueStanding(projectId, 'open', null);
    const dependent = list.issues.find((i) => i.id === held);
    expect(dependent?.standing.attentionGroup).toBe('stuck');
    expect(dependent?.standing.waitingOn).toMatchObject({ who: 'ISS-1', act: 'design approval' });
    expect(dependent?.standing.waitingOn.rule).toContain(
      'design hop-access-decision rev 5 is not approved',
    );
    expect(list.issues.find((i) => i.id === blocker)?.standing.blocks.map((b) => b.key)).toEqual([
      'ISS-2',
    ]);
    expect(dependent?.standing.wave).toBe(1);

    const { loadIssueDependencyEdges } = await import('../../src/issues/dependency-read.js');
    const edges = await loadIssueDependencyEdges(held, projectId);
    expect(edges.incoming.map((e) => e.fromDesignHold)).toEqual([
      'design hop-access-decision rev 5 is not approved',
    ]);

    await decide(wf, 5, 'approve');
    const after = await listIssueStanding(projectId, 'open', null);
    expect(after.issues.find((i) => i.id === held)?.standing.blockedBy).toEqual([]);
    expect(
      (await loadIssueDependencyEdges(held, projectId)).incoming[0]?.fromDesignHold,
    ).toBeNull();
  });
});
