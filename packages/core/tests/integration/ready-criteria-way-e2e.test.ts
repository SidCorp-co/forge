/**
 * A requirement-linked draft with no criteria is refused at draft → open, and the refusal names the
 * way through rather than a dead end. Issue lifecycle's ready check keeps criteria (REQ-34: "(2)
 * criteria: numbered, each traced to a BC of that revision"), and the criteria are the run's to
 * write, so a master moving the draft was told only "Write numbered criteria" and parked it
 * (forge-core-61, 2026-10-30). The refusal now says to declare a run over the draft, which writes
 * them and then opens it; this suite walks that way through the box's own doors to show it holds.
 *
 * @direct-test-of packages/core/src/issues/checklist-record.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  completeIssueReadyRecord,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

const SEQ = 31;
const REQ_SEQ = 4;

let projectId = '';
let box = '';
let issueId = '';

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const admin = await createTestUser({ verified: true });
  projectId = (await createTestProject(admin.id)).id;
  await addProjectMember(projectId, admin.id, 'admin');
  const deviceId = await createTestDevice(admin.id);
  await bindTestRunner(projectId, deviceId);
  box = (
    await mintPat({
      permissions: ['*'],
      userId: admin.id,
      name: 'box-master',
      deviceId,
      projectIds: [projectId],
    })
  ).plaintext;
  issueId = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, ${SEQ}, 'A reload keeps the saved cards', 'draft', ${admin.id})
  `);
  // linked to REQ-4, agreed at revision 1 with BC-1; the criterion the record helper writes is taken
  // back off, so the draft stands where a master meets it: linked, and nobody has written criteria
  await completeIssueReadyRecord(projectId, admin.id, issueId, REQ_SEQ);
  await db.execute(sql`DELETE FROM issue_criteria WHERE issue_id = ${issueId}`);
  const master = await api(box, 'POST', '/api/devices/me/master-session', {
    projectId,
    name: 'forge-master-ready',
    maxJobPanes: 2,
  });
  expect(master.status, JSON.stringify(master.body)).toBe(200);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const open = () => api(box, 'POST', `/api/issues/${issueId}/transition`, { toStatus: 'open' });

async function statusOf(): Promise<string> {
  const [row] = await rows<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${issueId}`,
  );
  return String(row?.status);
}

describe('a requirement-linked draft with no criteria', () => {
  it('is refused at open naming the run that writes its criteria, never a dead end', async () => {
    const res = await open();
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusals = ((res.body as Doc).error?.refusals ?? []) as Array<{
      code: string;
      path: string;
      detail: string;
    }>;
    expect(refusals.map((r) => r.path)).toEqual(['/answers/criteria']);
    expect(refusals[0]?.code).toBe('CHECKLIST_INCOMPLETE');
    expect(refusals[0]?.detail).toContain(
      'What are its criteria, each traced to a BC of that revision? The issue has no acceptance criteria. ' +
        "They are the run's to write: declare a run over this draft (forge-runner run declare), and that run writes them, " +
        'each line starting with the BC it proves, as "(REQ-4 BC-<m>) <statement>", ' +
        'and then opens it.',
    );
    expect(await statusOf()).toBe('draft');
  });

  it('opens once a run declared over it has written its criteria, the way the refusal names', async () => {
    const declared = await api(box, 'POST', '/api/devices/me/run-sessions', {
      projectId,
      runId: randomUUID(),
      issueKeys: [`ISS-${SEQ}`],
      name: `iss-${SEQ}-run`,
      role: 'forge:runner',
    });
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    const written = await api(box, 'PUT', `/api/issues/${issueId}/criteria`, {
      criteria: [{ statement: `(REQ-${REQ_SEQ} BC-1) A reload shows every saved card` }],
    });
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    const res = await open();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf()).toBe('open');
  });
});
