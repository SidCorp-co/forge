/**
 * ISS-1332: adminhub-api FB-78, routed to REQ-25, read resolved with its chip done while REQ-25 stood
 * accepted and its issues ISS-245 and ISS-246 sat unreleased in 0.28.0, so a room agent told its
 * master the fix was live. A requirement-routed item now reads resolved only once the issues linked
 * to its requirement are closed and released (feedback-lifecycle r19, edge planned → resolved), and
 * an accepted requirement with no live issue to ship it reads triaged, owed a triage again. The
 * linked issues are read with the page's carriers, in the same statement.
 *
 * @direct-test-of packages/core/src/feedback/list-requirement.ts
 * @direct-test-of packages/core/src/feedback/list-read.ts
 * @direct-test-of packages/core/src/feedback/owed-triage.ts
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { owedTriages } from '../../src/feedback/owed-triage.js';
import { api, type Body } from '../helpers/api.js';
import { completeIssueReadyRecord } from '../helpers/factories.js';
import {
  ago,
  feedback,
  issue,
  servingMaster,
  shipRelease,
  type World,
  world,
} from '../helpers/forecast-world.js';

let w: World;

async function item(key: string): Promise<Body> {
  const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/feedback/${key}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.feedback as Body;
}

/** An item routed to a requirement standing accepted, whose one linked issue stands at `status`. */
async function routedToAccepted(
  status: string,
): Promise<{ key: string; issueId: string; issueKey: string }> {
  const linked = await issue(w, { status, createdAt: ago(30), mergedAt: ago(26) });
  w.reqSeq += 1;
  const { requirementId } = await completeIssueReadyRecord(
    w.projectId,
    w.userId,
    linked.id,
    w.reqSeq,
  );
  const key = await feedback(w);
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`UPDATE requirements SET status = 'accepted' WHERE id = ${requirementId}`);
    await tx.execute(sql`
      UPDATE feedback SET status = 'triaged', route = 'new_requirement', routed_requirement_id = ${requirementId}
       WHERE project_id = ${w.projectId} AND fb_seq = ${w.fbSeq}`);
  });
  return { key, issueId: linked.id, issueKey: linked.key };
}

describe('ISS-1332 a requirement-routed item resolves only once its requirement shipped', () => {
  const fb = { unreleased: '', shipped: '', nothing: '' };
  let unreleasedIssue = '';

  beforeAll(async () => {
    w = await world();
    await servingMaster(w);
    const unreleased = await routedToAccepted('awaiting_release');
    fb.unreleased = unreleased.key;
    unreleasedIssue = unreleased.issueKey;
    const shipped = await routedToAccepted('closed');
    await shipRelease(w, [shipped.issueId], ago(25));
    fb.shipped = shipped.key;
    fb.nothing = (await routedToAccepted('dropped')).key;
  }, 120_000);

  it('reads planned while its requirement stands accepted and its issue is unreleased, naming that issue', async () => {
    const f = await item(fb.unreleased);
    expect(f.phase).toBe('planned');
    expect(JSON.stringify(f.waitingOn)).toContain(unreleasedIssue);
  });

  it('reads resolved once that issue is closed and released', async () => {
    expect((await item(fb.shipped)).phase).toBe('resolved');
  });

  it('reads triaged, owed a triage again, once accepted with no live issue to ship it', async () => {
    const f = await item(fb.nothing);
    expect(f.phase).toBe('triaged');
    expect((f.waitingOn as Body).rule).toMatch(/stands accepted with no issue to ship/);
    const owed = (await owedTriages(w.projectId)).map((o) => o.key);
    expect(owed).toContain(fb.nothing);
    expect(owed).not.toContain(fb.unreleased);
    expect(owed).not.toContain(fb.shipped);
  });
});
