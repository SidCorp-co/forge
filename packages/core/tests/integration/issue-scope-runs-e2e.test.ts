/**
 * A run that builds or changes no tree, against the scope hold (REQ-36 BC-5): a judge declared over
 * landed work neither holds a scope nor waits on one, at preflight, open or the move into build,
 * while a builder still holds the whole project against another builder; and a run core has not
 * admitted writes no verdict, refused naming the hold or lease its declaration waits behind.
 *
 * @direct-test-of packages/core/src/issues/issue-scope.ts
 * @direct-test-of packages/core/src/issues/issue-lease.ts
 * @direct-test-of packages/core/src/issues/criteria/recording-session.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld } from '../helpers/ecosystem-world.js';
import { seedIssueStatus } from '../helpers/factories.js';
import { refusalCodes as codes } from '../helpers/pattern-world.js';
import {
  call,
  close,
  closeBareRuns,
  design,
  details,
  landed,
  open,
  opened,
  preflight,
  startScopeWorld,
  waveIn,
} from '../helpers/scope-world.js';

let bareId = '';
let box = '';
let author = '';

beforeAll(async () => {
  ({ bareId, box, author } = await startScopeWorld());
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

// adminhub-fe ISS-54/55, 2026-10-26: judge run b7a0559f over ISS-54 held the whole project, and
// ISS-55's judge declarations queued behind it ISSUE_SCOPE_HELD. The hold binds runs that build
// or change the tree (REQ-36 BC-5); a judge neither holds a scope nor waits on one.
describe('a judge run, declared over landed work (REQ-36 BC-5)', () => {
  afterEach(closeBareRuns);

  it('holds no scope: a builder is taken at preflight and open while it runs', async () => {
    const w = await waveIn(bareId, 11, 12);
    await design(w(11).id, []);
    await design(w(12).id, []);
    await landed(w(11).id);
    const judge = await opened([w(11).key], bareId);

    expect(codes(await preflight([w(12).key], bareId))).toEqual([]);
    const builder = await opened([w(12).key], bareId);
    await close(builder.sessionId);
    await close(judge.sessionId);
  });

  it('waits on no scope: a judge is taken while a builder holds the whole project', async () => {
    const w = await waveIn(bareId, 13, 14);
    await design(w(13).id, []);
    await design(w(14).id, []);
    const builder = await opened([w(13).key], bareId);
    await landed(w(14).id);

    expect(codes(await preflight([w(14).key], bareId))).toEqual([]);
    const judge = await opened([w(14).key], bareId);
    await close(judge.sessionId);
    await close(builder.sessionId);
  });

  it('holds no scope at the move into build either', async () => {
    const w = await waveIn(bareId, 15, 16);
    const builder = await opened([w(16).key], bareId);
    await design(w(15).id, []);
    await landed(w(15).id);
    const judge = await opened([w(15).key], bareId);
    await db.execute(sql`
      INSERT INTO issue_work_state (issue_id, step, step_started_at) VALUES (${w(15).id}, 'release', now())
      ON CONFLICT (issue_id) DO UPDATE SET step = 'release', step_started_at = now()`);
    await seedIssueStatus(w(16).id, 'in_progress');
    await design(w(16).id, []);

    const moved = await call(author, 'PATCH', `/api/issues/${w(16).id}`, {
      workState: { step: 'build' },
    });

    expect([moved.status, details(moved)]).toEqual([200, '']);
    await close(judge.sessionId);
    await close(builder.sessionId);
  });

  it('still leaves a builder holding the whole project against another builder', async () => {
    const w = await waveIn(bareId, 17, 18);
    await design(w(17).id, []);
    await design(w(18).id, []);
    const builder = await opened([w(17).key], bareId);
    expect(codes(await preflight([w(18).key], bareId))).toEqual(['ISSUE_SCOPE_HELD']);
    await close(builder.sessionId);
  });
});

// adminhub-fe ISS-55, 2026-10-26: while its judge's declaration stood queued behind
// ISSUE_SCOPE_HELD, the box posted verdicts naming that run; core kept them and read them as the
// builder's (VERDICT_BY_BUILDER). A run core has not admitted writes no verdict.
describe('a verdict from a run core has not admitted', () => {
  afterEach(closeBareRuns);

  const verdictRows = async (issueId: string) =>
    (
      (await db.execute(sql`
        SELECT count(*)::int AS n FROM criterion_verdicts WHERE issue_id = ${issueId}`)) as unknown as Array<{
        n: number;
      }>
    )[0]?.n;

  it('is refused by name with the refusal its declaration waits behind, and nothing is written', async () => {
    const w = await waveIn(bareId, 21, 22);
    await design(w(21).id, []);
    await design(w(22).id, []);
    const holder = await opened([w(21).key], bareId);
    const queued = await open([w(22).key], bareId);
    expect(codes(queued.res)).toEqual(['ISSUE_SCOPE_HELD']);

    const res = await call(box, 'POST', `/api/issues/${w(22).id}/verdicts`, {
      criterion: 1,
      verdict: 'fail',
      reason: 'judged while queued',
      identity: { kind: 'commit', sha: 'f4e5fb66700ba7b35c8c607c8f7309fc5980861a' },
      withoutClip: 'an API route, nothing on screen',
      run: queued.runId,
    });

    expect([res.status, codes(res)]).toEqual([422, ['VERDICT_SESSION_NOT_ADMITTED']]);
    expect(res.body.error.refusals[0].path).toBe('/run');
    expect(details(res)).toContain(`recorded by run ${queued.runId}, which core has not admitted`);
    expect(details(res)).toContain('it waits behind ISSUE_SCOPE_HELD:');
    expect(details(res)).toContain(`held by live run ${holder.runId}`);
    expect(details(res)).toContain('Nothing was written.');
    expect(details(res), 'a scope wait names no builder run to close').not.toContain(
      'Close the builder run',
    );
    expect(details(res)).toContain('Record the verdict once the run is admitted.');
    expect(await verdictRows(w(22).id)).toBe(0);
    await close(holder.sessionId);
  });

  it('is refused for a pass queued behind another run holding the same issue, never read as the builder', async () => {
    const w = await waveIn(bareId, 23);
    const holder = await opened([w(23).key], bareId);
    const queued = await open([w(23).key], bareId);
    expect(codes(queued.res)).toEqual(['ISSUE_LEASE_HELD']);

    const res = await call(box, 'POST', `/api/issues/${w(23).id}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      reason: 'judged while queued',
      identity: { kind: 'commit', sha: 'f4e5fb66700ba7b35c8c607c8f7309fc5980861a' },
      run: queued.runId,
    });

    expect([res.status, codes(res)]).toEqual([422, ['VERDICT_SESSION_NOT_ADMITTED']]);
    expect(details(res)).toContain('it waits behind ISSUE_LEASE_HELD:');
    // forge-core-61, 2026-10-31 (ISS-838): a reviewer judges finished work, so the refusal names the
    // builder run to close, not only its session.
    expect(details(res)).toContain(
      `Close the builder run ${holder.runId} first, then record the verdict once run ${queued.runId} is admitted.`,
    );
    expect(await verdictRows(w(23).id)).toBe(0);
    await close(holder.sessionId);
  });
});
