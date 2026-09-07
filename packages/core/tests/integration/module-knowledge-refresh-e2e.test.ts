/**
 * ISS-948 (Tier 3a) — the module knowledge refresh loop, against a real Postgres.
 *
 * Everything here is something a mocked client cannot fail: the jsonb append and its dedupe, the
 * `metadata` merge that must not drop sibling keys, `labels_slug_chk` / `labels_knowledge_entry_chk`
 * standing over the fixtures, and the `activity_log` row that is the operator-readable half. The
 * pure staleness rule is unit-tested in `src/labels/module-knowledge-refresh.test.ts`; this file
 * owns the loop.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  writeIssueContext: typeof import('../../src/pipeline/issue-context-store.js')['writeIssueContext'];
  moduleNodeBodyHash: typeof import('../../src/labels/module-knowledge-refresh.js')['moduleNodeBodyHash'];
};

let harness: TestDatabase;
let mods: Mods;
let user: { id: string };
let project: { id: string };

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [storeMod, refreshMod] = await Promise.all([
    import('../../src/pipeline/issue-context-store.js'),
    import('../../src/labels/module-knowledge-refresh.js'),
  ]);
  mods = {
    writeIssueContext: storeMod.writeIssueContext,
    moduleNodeBodyHash: refreshMod.moduleNodeBodyHash,
  };
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  runs.clear();
  await truncateAll(harness.db);
  user = await createTestUser(harness.db);
  project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
});

const runs = new Map<string, string>();

const ACTOR = { type: 'user', id: '', agency: 'agent' } as const;
const actor = () => ({ ...ACTOR, id: user.id });

async function insertIssue(title: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${project.id}, ${Math.floor(Math.random() * 1_000_000)},
            ${title}, 'open', ${user.id})
  `);
  return id;
}

/** One run per issue, reused across attempts — `pipeline_runs_issue_open_uq` allows exactly one. */
async function runFor(issueId: string): Promise<string> {
  const existing = runs.get(issueId);
  if (existing) return existing;
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id) VALUES (${id}, ${project.id}, ${issueId})
  `);
  runs.set(issueId, id);
  return id;
}

async function insertNode(slug: string, body: string, metadata = '{}'): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO knowledge_entries (id, project_id, kind, slug, title, body, metadata)
    VALUES (${id}, ${project.id}, 'reference', ${slug}, ${slug}, ${body}, ${metadata}::jsonb)
  `);
  return id;
}

async function insertModule(slug: string, nodeId: string | null): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO labels (id, project_id, name, color, kind, slug, knowledge_entry_id)
    VALUES (${id}, ${project.id}, ${slug}, '#1f6f4a', 'module', ${slug}, ${nodeId})
  `);
  return id;
}

async function attribute(issueId: string, labelId: string, isPrimary: boolean): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO issue_labels (issue_id, label_id, is_primary)
    VALUES (${issueId}, ${labelId}, ${isPrimary})
  `);
}

interface NodeState {
  related_issue_ids: string[];
  metadata: Record<string, unknown>;
  body: string;
}

async function readNode(nodeId: string): Promise<NodeState> {
  const rows = await harness.db.execute(sql`
    SELECT related_issue_ids, metadata, body FROM knowledge_entries WHERE id = ${nodeId}
  `);
  return (rows as unknown as NodeState[])[0] as NodeState;
}

async function activityActions(issueId: string): Promise<Array<{ action: string; payload: unknown }>> {
  const rows = await harness.db.execute(sql`
    SELECT action, payload FROM activity_log WHERE issue_id = ${issueId} ORDER BY created_at
  `);
  return rows as unknown as Array<{ action: string; payload: unknown }>;
}

type TestResult = 'pass' | 'fail' | 'blocked_fixture' | 'verified_by_test';

function testPayload(result: TestResult) {
  return {
    step: 'test' as const,
    schema_version: 1 as const,
    result,
    ...(result === 'blocked_fixture' || result === 'verified_by_test'
      ? { resultReason: 'A documented reason.' }
      : {}),
    failures: [],
    flakyTests: [],
  };
}

async function landTest(
  issueId: string,
  result: TestResult = 'pass',
  attempt = 1,
): Promise<{ id: string }> {
  return mods.writeIssueContext({
    projectId: project.id,
    issueId,
    pipelineRunId: await runFor(issueId),
    step: 'test',
    attempt,
    kind: 'handoff',
    payload: testPayload(result),
    actor: actor(),
  });
}

describe('ISS-948 · a passing test refreshes the primary module and touches the secondaries', () => {
  it('appends the issue to the primary node and stamps its flow record', async () => {
    const node = await insertNode('module-pipeline', 'flow A');
    const mod = await insertModule('pipeline', node);
    const issueId = await insertIssue('landed');
    await attribute(issueId, mod, true);

    await landTest(issueId);

    const after = await readNode(node);
    expect(after.related_issue_ids).toEqual([issueId]);
    expect(after.metadata.moduleFlow).toEqual({
      staleSince: expect.any(String),
      staleByIssueId: issueId,
      bodyHash: mods.moduleNodeBodyHash('flow A'),
    });
  });

  it('appends to a secondary node and leaves it without a flow record', async () => {
    const primaryNode = await insertNode('module-pipeline', 'flow A');
    const secondaryNode = await insertNode('module-web', 'flow W');
    const primary = await insertModule('pipeline', primaryNode);
    const secondary = await insertModule('web', secondaryNode);
    const issueId = await insertIssue('landed');
    await attribute(issueId, primary, true);
    await attribute(issueId, secondary, false);

    await landTest(issueId);

    const touched = await readNode(secondaryNode);
    expect(touched.related_issue_ids).toEqual([issueId]);
    expect(touched.metadata).not.toHaveProperty('moduleFlow');
  });

  it('keeps sibling metadata keys the refresh did not write', async () => {
    const node = await insertNode('module-pipeline', 'flow A', '{"owner":"platform"}');
    const mod = await insertModule('pipeline', node);
    const issueId = await insertIssue('landed');
    await attribute(issueId, mod, true);

    await landTest(issueId);

    expect((await readNode(node)).metadata.owner).toBe('platform');
  });

  it('records one activity row naming the primary node and the touched nodes', async () => {
    const primaryNode = await insertNode('module-pipeline', 'flow A');
    const secondaryNode = await insertNode('module-web', 'flow W');
    const primary = await insertModule('pipeline', primaryNode);
    const secondary = await insertModule('web', secondaryNode);
    const issueId = await insertIssue('landed');
    await attribute(issueId, primary, true);
    await attribute(issueId, secondary, false);

    await landTest(issueId);

    const rows = await activityActions(issueId);
    expect(rows.map((r) => r.action)).toEqual(['module_knowledge_refreshed']);
    const payload = rows[0]?.payload as {
      primary: { slug: string; nodeId: string; appended: boolean };
      touched: Array<{ slug: string; nodeId: string; appended: boolean }>;
      skipped: unknown[];
    };
    expect(payload.primary).toMatchObject({ slug: 'pipeline', nodeId: primaryNode, appended: true });
    expect(payload.touched).toEqual([
      { slug: 'web', nodeId: secondaryNode, appended: true },
    ]);
    expect(payload.skipped).toEqual([]);
  });
});

describe('ISS-948 · the loop is idempotent', () => {
  it('does not double-append the same issue', async () => {
    const node = await insertNode('module-pipeline', 'flow A');
    const mod = await insertModule('pipeline', node);
    const issueId = await insertIssue('landed');
    await attribute(issueId, mod, true);

    await landTest(issueId);
    await landTest(issueId);

    expect((await readNode(node)).related_issue_ids).toEqual([issueId]);
  });

  it('does not move the flow record on a replay against an unchanged body', async () => {
    const node = await insertNode('module-pipeline', 'flow A');
    const mod = await insertModule('pipeline', node);
    const issueId = await insertIssue('landed');
    await attribute(issueId, mod, true);

    await landTest(issueId);
    const first = (await readNode(node)).metadata.moduleFlow as { staleSince: string };
    await landTest(issueId, 'pass', 2);
    const second = (await readNode(node)).metadata.moduleFlow as { staleSince: string };

    expect(second.staleSince).toBe(first.staleSince);
  });

  it('re-arms against the new body once the flow has been redrawn', async () => {
    const node = await insertNode('module-pipeline', 'flow A');
    const mod = await insertModule('pipeline', node);
    const firstIssue = await insertIssue('first');
    await attribute(firstIssue, mod, true);
    await landTest(firstIssue);
    const before = (await readNode(node)).metadata.moduleFlow as { staleSince: string };

    await harness.db.execute(
      sql`UPDATE knowledge_entries SET body = 'flow A, redrawn' WHERE id = ${node}`,
    );
    const secondIssue = await insertIssue('second');
    await attribute(secondIssue, mod, true);
    await landTest(secondIssue);

    const after = (await readNode(node)).metadata.moduleFlow as {
      staleSince: string;
      staleByIssueId: string;
      bodyHash: string;
    };
    expect(after.bodyHash).toBe(mods.moduleNodeBodyHash('flow A, redrawn'));
    expect(after.staleByIssueId).toBe(secondIssue);
    expect(new Date(after.staleSince).getTime()).toBeGreaterThan(
      new Date(before.staleSince).getTime(),
    );
  });
});

describe('ISS-948 · the cases that refresh nothing', () => {
  it('leaves every node alone for an issue with no primary module', async () => {
    const node = await insertNode('module-pipeline', 'flow A');
    const mod = await insertModule('pipeline', node);
    const issueId = await insertIssue('secondary only');
    await attribute(issueId, mod, false);

    const written = await landTest(issueId);

    expect(written.id).toBeTruthy();
    const after = await readNode(node);
    expect(after.related_issue_ids).toEqual([]);
    expect(after.metadata).toEqual({});
    expect(await activityActions(issueId)).toEqual([]);
  });

  it('leaves every node alone for an issue with no module at all', async () => {
    const node = await insertNode('module-pipeline', 'flow A');
    await insertModule('pipeline', node);
    const issueId = await insertIssue('unattributed');

    await landTest(issueId);

    expect((await readNode(node)).related_issue_ids).toEqual([]);
  });

  it('writes no knowledge entry when the primary has no node, and says so', async () => {
    const mod = await insertModule('pipeline', null);
    const issueId = await insertIssue('unbound primary');
    await attribute(issueId, mod, true);

    await landTest(issueId);

    const rows = await harness.db.execute(sql`SELECT count(*)::int AS n FROM knowledge_entries`);
    expect((rows as unknown as Array<{ n: number }>)[0]?.n).toBe(0);

    const activity = await activityActions(issueId);
    expect(activity.map((r) => r.action)).toEqual(['module_knowledge_refreshed']);
    expect((activity[0]?.payload as { skipped: unknown[] }).skipped).toEqual([
      { slug: 'pipeline', reason: 'no_knowledge_node' },
    ]);
  });

  for (const result of ['fail', 'blocked_fixture'] as const) {
    it(`refreshes nothing on a test handoff with result "${result}"`, async () => {
      const node = await insertNode('module-pipeline', 'flow A');
      const mod = await insertModule('pipeline', node);
      const issueId = await insertIssue('landed');
      await attribute(issueId, mod, true);

      await landTest(issueId, result);

      const after = await readNode(node);
      expect(after.related_issue_ids).toEqual([]);
      expect(after.metadata).toEqual({});
    });
  }

  // cm:guard `verified_by_test` belongs on the refreshing side, not with `blocked_fixture` — it is the verdict that the automated suite covers the AC, so the tests passed; `blocked_fixture` says the AC could not be exercised at all.
  it('refreshes the primary on a test handoff with result "verified_by_test"', async () => {
    const node = await insertNode('module-pipeline', 'flow A');
    const mod = await insertModule('pipeline', node);
    const issueId = await insertIssue('landed');
    await attribute(issueId, mod, true);

    await landTest(issueId, 'verified_by_test');

    expect((await readNode(node)).related_issue_ids).toEqual([issueId]);
  });

  it('refreshes nothing on a handoff from a step that is not `test`', async () => {
    const node = await insertNode('module-pipeline', 'flow A');
    const mod = await insertModule('pipeline', node);
    const issueId = await insertIssue('landed');
    await attribute(issueId, mod, true);

    await mods.writeIssueContext({
      projectId: project.id,
      issueId,
      pipelineRunId: await runFor(issueId),
      step: 'code',
      attempt: 1,
      kind: 'handoff',
      payload: {
        step: 'code',
        schema_version: 1,
        filesModified: [],
        decisions: [],
        verificationCommands: [],
        knownLimitations: [],
      },
      actor: actor(),
    });

    expect((await readNode(node)).related_issue_ids).toEqual([]);
  });

  it('leaves the handoff written when the node belongs to another project', async () => {
    const otherUser = await createTestUser(harness.db);
    const otherProject = await createTestProject(harness.db, otherUser.id);
    const foreignNode = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO knowledge_entries (id, project_id, kind, slug, title, body)
      VALUES (${foreignNode}, ${otherProject.id}, 'reference', 'module-pipeline', 'p', 'flow A')
    `);
    const mod = await insertModule('pipeline', foreignNode);
    const issueId = await insertIssue('cross-project node');
    await attribute(issueId, mod, true);

    const written = await landTest(issueId);

    expect(written.id).toBeTruthy();
    expect((await readNode(foreignNode)).related_issue_ids).toEqual([]);
    const activity = await activityActions(issueId);
    expect((activity[0]?.payload as { skipped: unknown[] }).skipped).toEqual([
      { slug: 'pipeline', reason: 'node_not_in_project' },
    ]);
  });
});

describe('ISS-948 · a refresh that fails does not fail the handoff', () => {
  it('returns the handoff row and records the failure when the refresh throws', async () => {
    const node = await insertNode('module-pipeline', 'flow A');
    const mod = await insertModule('pipeline', node);
    const issueId = await insertIssue('landed');
    await attribute(issueId, mod, true);

    // cm:guard break the READ the loop performs, not the loop's own code — a stubbed module would prove the stub. Dropping the column `loadAttributedModules` selects makes the query throw inside the try, which is the only shape that exercises the never-fatal contract.
    await harness.db.execute(sql`ALTER TABLE labels RENAME COLUMN slug TO slug_moved`);
    try {
      const written = await landTest(issueId);
      expect(written.id).toBeTruthy();
    } finally {
      await harness.db.execute(sql`ALTER TABLE labels RENAME COLUMN slug_moved TO slug`);
    }

    const activity = await activityActions(issueId);
    expect(activity.map((r) => r.action)).toEqual(['module_knowledge_refresh_failed']);
  });
});
