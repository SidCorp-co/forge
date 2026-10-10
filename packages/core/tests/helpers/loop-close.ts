/**
 * A resolved feedback item whose violated criterion passes on the running build, planted for loop
 * close (Feedback lifecycle r14 loop-check): an agreed requirement, a closed issue tracing its BC-1
 * with a pass verdict at a commit the planted live build holds, and the item naming BC-1 violated.
 * The item reads resolved by its own route, which the caller sets; the sweep then answers "is the
 * problem gone?" from that record.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { api } from './api.js';
import type { Doc } from './ecosystem-world.js';
import { createTestIssue, makeAgreeReady } from './factories.js';
import { plantLiveBuild } from './live-build.js';

const LIVE = '9999999999999999999999999999999999999999';

async function okay(r: Promise<{ status: number; body: Doc }>) {
  const res = await r;
  if (res.status >= 300)
    throw new Error(`loop-close plant: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** An agreed requirement with two criteria, written by `userId` as one ready to agree; its key. */
export async function agreedRequirement(
  token: string,
  projectId: string,
  userId: string,
): Promise<string> {
  const on = (path: string, body: unknown) =>
    api(token, 'POST', `/api/projects/${projectId}${path}`, body);
  const key = String(
    (
      await okay(
        on('/requirements', {
          title: 'The board keeps its filter',
          reason: 'planted',
          criteria: [{ body: 'A reload keeps the filter.' }, { body: 'A shared link carries it.' }],
        }),
      )
    ).key,
  );
  await makeAgreeReady(projectId, Number(key.slice(4)), userId);
  await okay(on(`/requirements/${key}/revisions/1/propose`, {}));
  await okay(on(`/requirements/${key}/revisions/1/accept`, {}));
  await okay(
    on(`/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    }),
  );
  return key;
}

/**
 * Names BC-1 of a new agreed requirement violated on the resolved item `feedbackId`, with closed
 * issue `seq` tracing BC-1 and passing at `sha`, and plants a live build holding `sha` (or not, with
 * `shipped: false`). Answers the call that puts the live build back.
 */
export async function vouchedByPassingCriterion(input: {
  token: string;
  projectId: string;
  ownerId: string;
  feedbackId: string;
  seq: number;
  sha: string;
  shipped?: boolean;
}): Promise<{ requirement: string; unplant: () => void }> {
  const { token, projectId, ownerId, feedbackId, seq, sha } = input;
  const unplant = plantLiveBuild(LIVE, { [sha]: input.shipped ?? true });
  const requirement = await agreedRequirement(token, projectId, ownerId);
  const { id: issueId } = await createTestIssue(projectId, ownerId, seq, {
    status: 'closed',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  await okay(
    api(token, 'POST', `/api/projects/${projectId}/requirements/${requirement}/issues`, {
      issue: `ISS-${seq}`,
    }),
  );
  await okay(api(token, 'POST', `/api/issues/${issueId}/criteria/traces`, { codes: ['BC-1'] }));
  await okay(
    api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      reason: 'pass on the running build',
      identity: { kind: 'commit', sha },
      evidence: ['shot.png'],
    }),
  );
  await db.execute(sql`
    UPDATE feedback SET violated_criterion_id = (
      SELECT c.id FROM requirement_criteria c JOIN requirements r ON r.id = c.requirement_id
       WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(requirement.slice(4))} AND c.code = 'BC-1')
     WHERE id = ${feedbackId}
  `);
  return { requirement, unplant };
}
