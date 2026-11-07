/**
 * ISS-1103: on forge-dev (QA on dev.577) FB-512, Planned and waiting on REQ-86, showed "Shipped
 * 0.4.0-dev.532" in its ETA cell: REQ-86's only issue had shipped, and the requirement still waited on
 * the verdicts that deliver it. The feedback forecast now says what a shipped line still owes: a
 * planned item whose carrier shipped and is not delivered owes `judgement`; a resolved one owes
 * nothing, and nothing that has not shipped owes it.
 *
 * @direct-test-of packages/core/src/forecast/feedback.ts
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import type { Body } from '../helpers/api.js';
import { completeIssueReadyRecord } from '../helpers/factories.js';
import {
  ago,
  feedback,
  issue,
  read,
  servingMaster,
  shipRelease,
  type World,
  world,
} from '../helpers/forecast-world.js';

const byKey = (list: Body[], key: string) => {
  const found = list.find((x) => x.key === key);
  if (!found) throw new Error(`${key} is not in ${JSON.stringify(list.map((x) => x.key))}`);
  return found;
};

/** An issue that closed and shipped, carrying a requirement agreed at revision 1 and left at
 *  `status`, and an item routed to that requirement. */
async function routedToShipped(w: World, status: 'agreed' | 'delivered') {
  const doneAt = ago(26);
  const done = await issue(w, { status: 'closed', createdAt: ago(30), mergedAt: doneAt });
  w.reqSeq += 1;
  const { requirementId } = await completeIssueReadyRecord(
    w.projectId,
    w.userId,
    done.id,
    w.reqSeq,
  );
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  if (status === 'delivered') {
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE requirements SET status = 'delivered' WHERE id = ${requirementId}`),
    );
  }
  const version = await shipRelease(w, [done.id], ago(25));
  const key = await feedback(w);
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      UPDATE feedback SET status = 'triaged', route = 'new_requirement', routed_requirement_id = ${requirementId}
       WHERE project_id = ${w.projectId} AND fb_seq = ${w.fbSeq}`),
  );
  return { key, version };
}

describe('ISS-1103 a shipped line says what it still owes', () => {
  let w: World;
  const fb = { planned: '', resolved: '', open: '' };
  let plannedVersion = '';

  beforeAll(async () => {
    w = await world();
    await servingMaster(w);
    const planned = await routedToShipped(w, 'agreed');
    fb.planned = planned.key;
    plannedVersion = planned.version;
    fb.resolved = (await routedToShipped(w, 'delivered')).key;
    const open = await issue(w, { status: 'open', createdAt: ago(1) });
    fb.open = await feedback(w, [open.id]);
  }, 120_000);

  it('a planned item whose carrier shipped and awaits its verdicts owes judgement, beside its version', async () => {
    const f = byKey((await read(w, '/feedback')).items as Body[], fb.planned);
    expect((f.delivery as Body).shipped).toMatchObject({ version: plannedVersion });
    expect(f.owes).toBe('judgement');
  });

  it('a resolved item owes nothing once its requirement is delivered', async () => {
    const f = byKey((await read(w, '/feedback')).items as Body[], fb.resolved);
    expect((f.delivery as Body).shipped).not.toBeNull();
    expect(f.owes).toBeNull();
  });

  it('an item whose work has not shipped owes no judgement yet', async () => {
    const f = byKey((await read(w, '/feedback')).items as Body[], fb.open);
    expect((f.delivery as Body).shipped).toBeNull();
    expect(f.owes).toBeNull();
  });

  it('the item read says the same as its row', async () => {
    const one = await read(w, `/feedback/${fb.planned}`);
    expect((one.forecast as Body).owes).toBe('judgement');
  });
});
