/**
 * ISS-1388 — a `labels` replace-set is not refused over an issue a run holds.
 *
 * The module-taxonomy-migration guide tells its reader, beside Pass 2, that the pass takes no lease
 * and is run between waves. That sentence is true only while `updateIssueFields` carries no lease
 * precondition for a label write; this plants the hazard it names — a run's label change, then a
 * migrator's replace-set over the same held issue — and reads back what survived. If a refusal is
 * ever added, this goes red and the page has to change with it, not the other way round.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let mods: {
  openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
  isIssueLeaseHeld: typeof import('../../src/devices/run-session.js').isIssueLeaseHeld;
  updateIssueFields: typeof import('../../src/issues/update-service.js').updateIssueFields;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const runSession = await import('../../src/devices/run-session.js');
  const update = await import('../../src/issues/update-service.js');
  mods = {
    openRunSession: runSession.openRunSession,
    isIssueLeaseHeld: runSession.isIssueLeaseHeld,
    updateIssueFields: update.updateIssueFields,
  };
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

const SEQ = 890;

/** One project, one box serving it, one issue, and two labels: the run's and the migrator's. */
async function heldIssueWithTwoLabels() {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const box = await createTestDevice(harness.db, user.id);
  await harness.db.execute(sql`
    UPDATE projects
       SET agent_config = ${JSON.stringify({
         pipelineConfig: { poolBacklog: { statuses: ['draft'], limit: 20 } },
       })}::jsonb
     WHERE id = ${project.id}
  `);
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, name, type, status)
    VALUES (gen_random_uuid(), ${project.id}, ${box.id}, 'ra', 'claude-code', 'online')
  `);
  const issueRows = (await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (gen_random_uuid(), ${project.id}, ${SEQ}, 'a held issue', 'draft', ${user.id})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const labelRows = (await harness.db.execute(sql`
    INSERT INTO labels (id, project_id, name, color, kind, slug)
    VALUES (gen_random_uuid(), ${project.id}, 'run-label', '#111111', 'label', NULL),
           (gen_random_uuid(), ${project.id}, 'billing', '#222222', 'module', 'billing')
    RETURNING id, name
  `)) as unknown as Array<{ id: string; name: string }>;
  const labelId = (name: string) => {
    const row = labelRows.find((r) => r.name === name);
    if (!row) throw new Error(`label ${name} was not seeded`);
    return row.id;
  };
  return {
    project,
    box,
    user,
    issueId: issueRows[0]?.id as string,
    runLabel: labelId('run-label'),
    module: labelId('billing'),
  };
}

async function labelIdsOf(issueId: string): Promise<string[]> {
  const rows = (await harness.db.execute(
    sql`SELECT label_id FROM issue_labels WHERE issue_id = ${issueId} ORDER BY label_id`,
  )) as unknown as Array<{ label_id: string }>;
  return rows.map((r) => r.label_id);
}

describe('a labels replace-set over an issue a run holds', () => {
  it('lands, and drops the label the run had just set, with no refusal', async () => {
    const { project, box, user, issueId, runLabel, module } = await heldIssueWithTwoLabels();
    const actor = { type: 'user', id: user.id, agency: 'human' } as const;

    await mods.openRunSession({
      deviceId: box.id,
      projectId: project.id,
      issueKeys: [`ISS-${SEQ}`],
      name: 'run-a',
    });
    expect(
      await mods.isIssueLeaseHeld({
        deviceId: box.id,
        issueKey: `ISS-${SEQ}`,
        projectId: project.id,
      }),
      'the issue has to be held for the write below to prove anything about a held issue',
    ).toBe(true);

    // The run labels the issue; the migrator read the set before this and does not know.
    await mods.updateIssueFields({
      issueId,
      updates: { updatedAt: new Date() },
      labelIds: [{ labelId: runLabel, isPrimary: false }],
      actor,
    });
    expect(await labelIdsOf(issueId)).toEqual([runLabel]);

    await mods.updateIssueFields({
      issueId,
      updates: { updatedAt: new Date() },
      labelIds: [{ labelId: module, isPrimary: true }],
      actor,
    });

    expect(
      await labelIdsOf(issueId),
      "the migrator's replace-set overwrote the run's label while the run held the issue",
    ).toEqual([module]);
  });
});
