/**
 * A close is its builder's verdict where the project judges its own work (owner 2026-11-08, D2):
 * each traced criterion the close did not move out, holding no verdict, is recorded passing at the
 * landing its mark names, an asserted mark's commit included (ISS-1148), and the boot backfill
 * answers an issue closed before that over a verdict from an earlier landing. Split from
 * `close-in-scope-e2e.test.ts`, which holds the close itself.
 *
 * @direct-test-of packages/core/src/issues/criteria/close-verdicts.ts
 * @direct-test-of packages/core/src/issues/close-in-scope.ts
 * @direct-test-of packages/core/src/issues/merged-at.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  completeIssueReadyRecord,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { declareControls } from '../helpers/project-controls.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const LIVE = {
  live: {
    tier: 'production' as const,
    deployment: { mode: 'external' as const, target: 'catalog-deploy' },
  },
};
const SHA = 'ab12'.repeat(10);

let projectId = '';
let ownerId = '';
let call: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await seedProjectDocument(projectId, ownerId, { environments: LIVE, defaultBranch: 'main' });
  // a member agent's box, as a pool runner is: the run that holds the issue it closes
  const holder = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, holder, 'member');
  const deviceId = await createTestDevice(holder);
  const pat = await mintPat({
    permissions: ['*'],
    userId: holder,
    name: 'box-holder',
    deviceId,
    projectIds: [projectId],
  });
  call = requester(app, { holder: pat.plaintext });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

let seq = 300;
/** An issue its run landed: at `status` with its merge recorded, and `criteria` as its live rows. */
async function landed(
  criteria: string[],
  status = 'awaiting_release',
): Promise<{ id: string; key: string }> {
  seq += 1;
  const id = randomUUID();
  await rows(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha)
    VALUES (${id}, ${projectId}, ${seq}, ${`catalog work ${seq}`}, ${status}, ${ownerId}, now(), ${SHA})`);
  for (const [i, statement] of criteria.entries()) {
    await rows(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position)
      VALUES (${id}, ${i + 1}, ${statement}, ${i})`);
  }
  return { id, key: `ISS-${seq}` };
}

/** The holder's box claims the issue: the lease its close then works under. */
async function lease(id: string): Promise<void> {
  ok(
    await call('holder', 'PATCH', `/api/issues/${id}`, {
      sessionContext: {
        lease: {
          holder: 'catalog-master-holder',
          renewedAt: new Date().toISOString(),
          minutes: 60,
        },
      },
    }),
  );
}

const close = (id: string) =>
  call('holder', 'POST', `/api/issues/${id}/transition`, { toStatus: 'closed' });

// owner 2026-11-08 (D2, G2): where the project judges its own work, a close is its builder's
// verdict: each traced criterion it did not move out, holding no verdict, is recorded passing at its
// landing, sourced the close, so no requirement owes "judge BC-x on ISS-y" for ever. An independent
// judge still owes it. Last in the file: it turns the project's judge independent.
describe("a close is its builder's verdict where the project judges its own work (D2)", () => {
  const verdictsOf = (issueId: string) =>
    rows<{
      n: number;
      verdict: string;
      identity_kind: string;
      commit_sha: string;
      reason: string;
    }>(sql`
      SELECT c.n, v.verdict, v.identity_kind, v.commit_sha, v.reason
        FROM criterion_verdicts v JOIN issue_criteria c ON c.id = v.criterion_id
       WHERE v.issue_id = ${issueId} ORDER BY c.n`);

  it('records each traced criterion holding no verdict passing at the landing, and nothing else', async () => {
    const { id } = await landed([]);
    await completeIssueReadyRecord(projectId, ownerId, id, seq);
    // criterion 2 traces nothing: no requirement waits on it, so the close records nothing for it
    await rows(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position)
      VALUES (${id}, 2, 'its own outcome', 1)`);
    await lease(id);
    const r = await close(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await verdictsOf(id)).toEqual([
      {
        n: 1,
        verdict: 'pass',
        identity_kind: 'commit',
        commit_sha: SHA,
        // the close's source, as every reader shows it beside the verdict (`CLOSE_VERDICT_REASON`)
        reason:
          "met in scope at the issue's close: the project judges its own work, so the close is its builder's verdict",
      },
    ]);
  });

  // forge-dev 2026-11-08: no source host, so every mark is asserted and `merged_commit_sha` is empty;
  // reading only that column recorded no verdict for any issue closed there (ISS-690, ISS-60, …)
  it('records at the commit an asserted mark claims, where no merge was observed', async () => {
    const claimed = 'cd34'.repeat(10);
    const { id } = await landed([]);
    await completeIssueReadyRecord(projectId, ownerId, id, seq);
    await rows(sql`UPDATE issues SET merged_commit_sha = NULL WHERE id = ${id}`);
    await rows(sql`
      INSERT INTO activity_log (issue_id, actor_type, actor_id, actor_agency, action, payload)
      VALUES (${id}, 'user', ${ownerId}, 'agent', 'issue.mergeMarked',
              ${JSON.stringify({ commit: claimed, stamped: true })}::jsonb)`);
    await lease(id);
    const r = await close(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await verdictsOf(id)).map((v) => [v.n, v.verdict, v.commit_sha])).toEqual([
      [1, 'pass', claimed],
    ]);
  });

  // an issue closed before the close recorded its verdict, its criterion holding a fail from an earlier
  // landing (ISS-690: failed on 0.4.0-dev.557, met again and closed at 946913bbcd) or a reading of a
  // runtime: the backfill answers it at the landing; a verdict written after the close is kept as newest
  it('backfills at the landing over a verdict from an earlier landing, never over one after the close', async () => {
    const { backfillCloseVerdicts, CLOSE_VERDICTS_BACKFILL_KEY } = await import(
      '../../src/issues/criteria/close-verdicts.js'
    );
    const earlier = 'ef56'.repeat(10);
    const before = await landed([], 'closed');
    await completeIssueReadyRecord(projectId, ownerId, before.id, seq);
    const after = await landed([], 'closed');
    await completeIssueReadyRecord(projectId, ownerId, after.id, seq);
    for (const { id } of [before, after]) {
      await rows(sql`
        INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type,
                                        actor_agency, source, created_at)
        VALUES (${randomUUID()}, 'issue', ${id}, 'awaiting_release', 'closed', 'system', 'agent',
                'fixture', now() - interval '1 hour')`);
    }
    const failAt = (id: string, at: string) =>
      rows(sql`
        INSERT INTO criterion_verdicts
          (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha, author_agency, created_at)
        SELECT id, issue_id, 'fail', 'not met', 'commit', ${earlier}, 'agent', now() - ${at}::interval
          FROM issue_criteria WHERE issue_id = ${id} AND n = 1`);
    await failAt(before.id, '1 day');
    await failAt(after.id, '1 minute');
    await rows(sql`DELETE FROM backfill_markers WHERE key = ${CLOSE_VERDICTS_BACKFILL_KEY}`);
    const report = await backfillCloseVerdicts();
    expect(report?.verdicts).toBeGreaterThanOrEqual(1);
    expect((await verdictsOf(before.id)).map((v) => [v.verdict, v.commit_sha]).sort()).toEqual([
      ['fail', earlier],
      ['pass', SHA],
    ]);
    expect((await verdictsOf(after.id)).map((v) => v.verdict)).toEqual(['fail']);
    // once: the marker holds it, and a second boot writes nothing
    expect(await backfillCloseVerdicts()).toBeNull();
  });

  it('records nothing where an independent judge owes the criteria', async () => {
    await declareControls(projectId, ownerId, { gates: { profile: 'strict' } });
    const { id } = await landed([]);
    await completeIssueReadyRecord(projectId, ownerId, id, seq);
    await lease(id);
    const r = await close(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await verdictsOf(id)).toEqual([]);
  });
});
