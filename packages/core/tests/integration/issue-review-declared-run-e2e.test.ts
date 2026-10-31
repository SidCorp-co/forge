/**
 * ISS-831 (FB-410, adminhub-fe ISS-109; FB-427, sidcorp-mail ISS-10): a reviewer run its master
 * declared (`forge-runner run declare --role reviewer`) over an issue still in work takes the issue's
 * lease (`devices/run-take.ts:takenBy`), and the builder reading took every lease holder, and every
 * run declared over the issue before its landing, for the run that built it. So the reviewer's own
 * session was named the building run, its review refused REVIEW_BY_BUILDER, and its verdicts read as
 * the builder's and never counted. The building run itself still reviews nothing.
 *
 * It reaches its subject over HTTP, so it names what it guards:
 * @direct-test-of packages/core/src/issues/review.ts
 * @direct-test-of packages/core/src/issues/review-rules.ts
 * @direct-test-of packages/core/src/issues/built-by.ts
 * @direct-test-of packages/core/src/issues/pattern-runs.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { THIS_REPOSITORY } from '../../src/lib/this-repository.js';
import { closeWorld } from '../helpers/ecosystem-world.js';
import { bindTestRunner, rows } from '../helpers/factories.js';
import {
  boxToken,
  builtIssue,
  closeOnBox,
  codes,
  declareOnBox,
  detail,
  deviceId,
  fieldsOf,
  HEAD,
  keyOf,
  mark,
  post,
  project,
  review,
  reviewRecords,
  reviewVerdictOf,
  startReviewWorld,
  userId,
} from '../helpers/review-world.js';

beforeAll(startReviewWorld, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('ISS-831 a reviewer run its box declared over the issue', () => {
  /**
   * A project of its own, which the box serves so core admits the runs its master declares: the
   * issues of one project share a module, and a live run over one holds the scope of the rest.
   */
  const served = async (): Promise<string> => {
    const id = await project(THIS_REPOSITORY, true);
    await bindTestRunner(id, deviceId);
    return id;
  };

  it('records the review and its verdict as that run, not as the building run', async () => {
    const at = await served();
    const { id, builder } = await builtIssue(at);
    await closeOnBox(builder);
    const reviewer = await declareOnBox(at, await keyOf(id), 'reviewer');
    expect(reviewer.sessionId).not.toBe(builder);
    const res = await post(boxToken, id, review({ run: reviewer.runId }));
    expect([res.status, codes(res), detail(res)]).toEqual([201, [], '']);
    expect(res.body.review.reviewer.session).toBe(reviewer.sessionId);
    const [record] = await reviewRecords(id);
    expect(fieldsOf(record ?? { fields: [] }, 'reviewer-session')).toEqual([reviewer.sessionId]);
    expect(fieldsOf(record ?? { fields: [] }, 'builder')).toEqual([`run session ${builder}`]);
    expect(await reviewVerdictOf(id)).toEqual([{ session: reviewer.sessionId, byBuilder: false }]);
    const marked = await mark(id);
    expect([marked.status, marked.body.action]).toEqual([200, 'merged']);
  });

  it('takes a plugin-prefixed role as the same reviewer', async () => {
    const at = await served();
    const { id, builder } = await builtIssue(at);
    await closeOnBox(builder);
    const reviewer = await declareOnBox(at, await keyOf(id), 'forge:reviewer');
    const res = await post(boxToken, id, review({ run: reviewer.runId }));
    expect([res.status, codes(res)]).toEqual([201, []]);
    expect(await reviewVerdictOf(id)).toEqual([{ session: reviewer.sessionId, byBuilder: false }]);
  });

  it('still refuses the building run: naming it, or naming no run while it is live', async () => {
    const at = await served();
    const { id, builder } = await builtIssue(at);
    const named = await post(boxToken, id, review({ run: builder }));
    expect([named.status, codes(named)]).toEqual([422, ['REVIEW_BY_BUILDER']]);
    expect(detail(named)).toContain(builder);
    const unnamed = await post(boxToken, id, review());
    expect([unnamed.status, codes(unnamed)]).toEqual([422, ['REVIEW_BY_BUILDER']]);
    expect(await reviewRecords(id)).toEqual([]);
  });

  it('refuses a call naming no run while the building run is live, though a reviewer holds the issue', async () => {
    const at = await served();
    const { id, builder } = await builtIssue(at);
    // the building run lives on, having given the issue back, so the reviewer takes its lease
    await rows(sql`DELETE FROM issue_leases WHERE session_id = ${builder} RETURNING session_id`);
    const reviewer = await declareOnBox(at, await keyOf(id), 'reviewer');
    const unnamed = await post(boxToken, id, review());
    expect([unnamed.status, codes(unnamed)]).toEqual([422, ['REVIEW_RUN_UNNAMED']]);
    expect(await reviewRecords(id)).toEqual([]);
    const named = await post(boxToken, id, review({ run: reviewer.runId }));
    expect([named.status, named.body.review?.reviewer.session]).toEqual([201, reviewer.sessionId]);
  });

  it('still refuses a run declared to build, which holds the issue, as its builder', async () => {
    const at = await served();
    const { id, builder } = await builtIssue(at);
    await closeOnBox(builder);
    const rebuilder = await declareOnBox(at, await keyOf(id), 'forge:runner');
    const res = await post(boxToken, id, review({ run: rebuilder.runId }));
    expect([res.status, codes(res)]).toEqual([422, ['REVIEW_BY_BUILDER']]);
    expect(detail(res)).toContain(rebuilder.sessionId);
    expect(await reviewRecords(id)).toEqual([]);
  });

  it('counts a reviewer that recorded a check of its own as a builder', async () => {
    const at = await served();
    const { id, builder } = await builtIssue(at);
    await closeOnBox(builder);
    const reviewer = await declareOnBox(at, await keyOf(id), 'reviewer');
    await rows(sql`
      INSERT INTO issue_check_runs (id, issue_id, head_sha, kind, name, scope, command, files,
                                    result, duration_ms, started_at, via, run_session_id, recorded_by)
      VALUES (${randomUUID()}, ${id}, ${HEAD}, 'tests', 'unit', 'x', 'pnpm test', '[]'::jsonb,
              'pass', 10, now(), 'report', ${reviewer.sessionId}, ${userId})
      RETURNING id
    `);
    const res = await post(boxToken, id, review({ run: reviewer.runId }));
    expect([res.status, codes(res)]).toEqual([422, ['REVIEW_BY_BUILDER']]);
  });
});
