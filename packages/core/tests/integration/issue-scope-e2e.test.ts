/**
 * Two issues whose declared scope meets are never worked by two live runs at once (REQ-36 BC-5,
 * ISS-468). The scope is the design record's modules and contracts; held is a lease of a run that
 * has not ended. The designs here are the ones this wave's issues touch, read off their trees and
 * plans: ISS-453 and ISS-454 both change the issues kernel, ISS-455 and ISS-469 share no module.
 *
 * - The run-session preflight and open refuse ISSUE_SCOPE_HELD naming the holding issue and its
 *   run, and admit the same declaration once that run ends.
 * - The admissible list withholds a scope-held issue while the overlap stands.
 * - A group label claims its subtree; a contract both name meets; a pair sharing nothing is let
 *   through; an issue with no design declares no scope and is admitted by that rule.
 * - A design recorded after admission is asked at the move into build, where only a run already
 *   building counts, so the first to build goes first.
 *
 * @direct-test-of packages/core/src/issues/issue-scope.ts
 * @direct-test-of packages/core/src/issues/issue-lease.ts
 * @direct-test-of packages/core/src/issues/blocked-by.ts
 * @direct-test-of packages/core/src/issues/update-service.ts
 * @direct-test-of packages/core/src/devices/admissible.ts
 * @direct-test-of packages/core/src/db/schema-issue-designs.ts
 * @direct-test-of packages/core/src/db/schema-issue-leases.ts
 * @direct-test-of packages/core/src/issues/issue-lease-read.ts
 * @direct-test-of packages/core/src/issues/criteria/recording-session.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld } from '../helpers/ecosystem-world.js';
import { seedIssueStatus } from '../helpers/factories.js';
import { refusalCodes as codes } from '../helpers/pattern-world.js';
import {
  admissibleKeys,
  call,
  close,
  DESIGNS,
  design,
  details,
  open,
  opened,
  preflight,
  startScopeWorld,
  wave,
  waveIn,
} from '../helpers/scope-world.js';

let projectId = '';
let bareId = '';
let box = '';
let author = '';

beforeAll(async () => {
  ({ projectId, bareId, box, author } = await startScopeWorld());
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a declaration over an issue whose design meets a held one (criterion 1)', () => {
  it('is refused naming its holder at preflight and open, and taken after', async () => {
    const w = await wave(453, 454);
    await design(w(453).id, [...DESIGNS[453]]);
    await design(w(454).id, [...DESIGNS[454]]);
    const holder = await opened([w(453).key]);
    const leaseOf = async (key: string) =>
      (await call(box, 'GET', `/api/devices/me/issue-leases/${key}?projectId=${projectId}`)).body;
    expect(await leaseOf(w(453).key)).toMatchObject({ held: true, heldByThisDevice: true });

    const pre = await preflight([w(454).key]);
    expect([pre.status, codes(pre)]).toEqual([422, ['ISSUE_SCOPE_HELD']]);
    expect(details(pre)).toContain(`${w(454).key} shares module issues with ${w(453).key}`);
    expect(details(pre)).toContain(`held by live run ${holder.runId}`);
    expect(details(pre)).toContain('until that run ends');
    // the Runs page reads the run by the id the refusal names (FB-122)
    const listed = await call(author, 'GET', `/api/projects/${projectId}/runs/standing`);
    const ids = (listed.body.items as Array<{ boxRunId: string | null }>).map((r) => r.boxRunId);
    expect(ids).toContain(holder.runId);

    const refused = await open([w(454).key]);
    expect([refused.res.status, codes(refused.res)]).toEqual([422, ['ISSUE_SCOPE_HELD']]);
    const queued = (await db.execute(sql`
      SELECT s.status, r.metadata -> 'declarationRefusal' ->> 'gate' AS gate
        FROM agent_sessions s JOIN pipeline_runs r ON r.id = s.pipeline_run_id
       WHERE r.metadata ->> 'boxRunId' = ${refused.runId}
    `)) as unknown as Array<{ status: string; gate: string }>;
    expect(queued).toEqual([{ status: 'queued', gate: 'scope_held' }]);
    const leases = (await db.execute(sql`
      SELECT count(*)::int AS n FROM issue_leases WHERE project_id = ${projectId} AND issue_key = ${w(454).key}
    `)) as unknown as Array<{ n: number }>;
    expect(leases[0]?.n).toBe(0);

    expect((await close(holder.sessionId)).status).toBe(200);
    expect(await leaseOf(w(453).key)).toMatchObject({ held: false });
    const after = await preflight([w(454).key]);
    expect([after.status, codes(after)]).toEqual([200, []]);
    const resent = await call(box, 'POST', '/api/devices/me/run-sessions', {
      projectId,
      runId: refused.runId,
      issueKeys: [w(454).key],
      name: w(454).key,
    });
    expect([resent.status, details(resent)]).toEqual([200, '']);
    expect((await close(String(resent.body.sessionId))).status).toBe(200);
  });

  it('lets an unrelated pair through; refuses on a group label or a contract', async () => {
    const w = await wave(455, 469, 1, 2);
    await design(w(455).id, [...DESIGNS[455]]);
    await design(w(469).id, [...DESIGNS[469]]);
    const holder = await opened([w(455).key]);
    expect(codes(await preflight([w(469).key]))).toEqual([]);

    await design(w(1).id, ['work-delivery']);
    const group = await preflight([w(1).key]);
    expect(codes(group)).toEqual(['ISSUE_SCOPE_HELD']);
    expect(details(group)).toContain('shares module work-delivery with');

    await design(w(2).id, ['feedback'], ['acme/orders-api']);
    await db.execute(sql`
      UPDATE issue_designs SET contracts = ARRAY['acme/orders-api']::text[] WHERE issue_id = ${w(455).id}`);
    const contract = await preflight([w(2).key]);
    expect(codes(contract)).toEqual(['ISSUE_SCOPE_HELD']);
    expect(details(contract)).toContain('contract acme/orders-api');
    await close(holder.sessionId);
  });

  it('takes two issues whose designs meet in one run: a group never holds itself', async () => {
    const w = await wave(453, 454);
    await design(w(453).id, [...DESIGNS[453]]);
    await design(w(454).id, [...DESIGNS[454]]);
    const both = await opened([w(453).key, w(454).key]);
    await close(both.sessionId);
  });

  it('admits an issue with no design record, by the rule that it declares no scope', async () => {
    const w = await wave(453, 3);
    await design(w(453).id, [...DESIGNS[453]]);
    const holder = await opened([w(453).key]);
    expect(codes(await preflight([w(3).key]))).toEqual([]);
    await close(holder.sessionId);
  });
});

describe('the admissible list while the overlap stands (criterion 2)', () => {
  it('withholds the scope-held issues and lists them again once the run ends', async () => {
    const w = await wave(453, 454, 469, 455);
    for (const n of [453, 454, 469, 455] as const) await design(w(n).id, [...DESIGNS[n]]);
    const before = await admissibleKeys();
    expect(before).toEqual(expect.arrayContaining([w(453).key, w(454).key, w(455).key]));
    // ISS-469 holds issues, which ISS-453 and ISS-454 also change; ISS-455 shares nothing with it
    const holder = await opened([w(469).key]);
    const during = await admissibleKeys();
    expect(during).not.toContain(w(469).key);
    expect(during).not.toContain(w(453).key);
    expect(during).not.toContain(w(454).key);
    expect(during).toContain(w(455).key);
    await close(holder.sessionId);
    const after = await admissibleKeys();
    expect(after).toEqual(expect.arrayContaining([w(453).key, w(454).key, w(455).key]));
  });
});

describe('a design recorded after admission, at the move into build', () => {
  it('lets the first run build and refuses the second until the first ends', async () => {
    const w = await wave(453, 454);
    const first = await opened([w(453).key]);
    const second = await opened([w(454).key]);
    for (const n of [453, 454] as const) {
      await seedIssueStatus(w(n).id, 'in_progress');
      await design(w(n).id, [...DESIGNS[n]]);
    }
    const step = (n: 453 | 454, to: string) =>
      call(author, 'PATCH', `/api/issues/${w(n).id}`, { workState: { step: to } });

    expect((await step(453, 'build')).status).toBe(200);
    const held = await step(454, 'build');
    expect([held.status, codes(held)]).toEqual([422, ['ISSUE_SCOPE_HELD']]);
    expect(details(held)).toContain(`shares module issues with ${w(453).key}`);
    expect(details(held)).toContain(`held by live run ${first.runId}`);

    expect((await close(first.sessionId)).status).toBe(200);
    expect((await step(454, 'build')).status).toBe(200);
    await close(second.sessionId);
  });
});

// orbit, ISS-2/3 (FB-444): three runs of one wave each sat at build with their work landed, and
// each one's move build -> test was refused ISSUE_SCOPE_HELD "into build" while the others lived.
describe('the hold is asked where the work starts, never within the build phase (ISS-843)', () => {
  it('takes an issue already at build on to test while another run builds, and names the move it refuses', async () => {
    const w = await waveIn(bareId, 8, 9);
    const first = await opened([w(8).key], bareId);
    const second = await opened([w(9).key], bareId);
    for (const n of [8, 9]) {
      await seedIssueStatus(w(n).id, 'in_progress');
      await design(w(n).id, []);
    }
    const step = (n: number, to: string) =>
      call(author, 'PATCH', `/api/issues/${w(n).id}`, { workState: { step: to } });
    expect((await step(8, 'design')).status).toBe(200);
    expect((await step(8, 'build')).status).toBe(200);
    // the entry is where the hold stands, and the refusal names the move it refuses
    expect((await step(9, 'design')).status).toBe(200);
    const held = await step(9, 'build');
    expect([held.status, codes(held)]).toEqual([422, ['ISSUE_SCOPE_HELD']]);
    expect(details(held)).toContain('the move of the work from design into build is refused');
    // the field's state: the second run reached build anyway (its work landed), as orbit's did
    await db.execute(sql`UPDATE issue_work_state SET step = 'build', step_started_at = now()
                          WHERE issue_id = ${w(9).id}`);
    expect((await step(9, 'test')).status).toBe(200);
    expect((await step(8, 'test')).status).toBe(200);
    await close(first.sessionId);
    await close(second.sessionId);
  });
});

describe('a design naming no module, on a project that declares none (ISS-609)', () => {
  it('holds the whole project: a second designed issue waits, one with no design does not', async () => {
    const w = await waveIn(bareId, 1, 2, 3);
    await design(w(1).id, []);
    await design(w(2).id, []);
    const holder = await opened([w(1).key], bareId);
    const pre = await preflight([w(2).key], bareId);
    expect([pre.status, codes(pre)]).toEqual([422, ['ISSUE_SCOPE_HELD']]);
    expect(details(pre)).toContain(`${w(2).key} shares the whole project with ${w(1).key}`);
    expect(details(pre)).toContain(`held by live run ${holder.runId}`);
    expect(codes(await preflight([w(3).key], bareId))).toEqual([]);
    await close(holder.sessionId);
    expect(codes(await preflight([w(2).key], bareId))).toEqual([]);
  });

  it('still meets a design naming a module once the project declares one', async () => {
    const w = await waveIn(bareId, 4, 5);
    await design(w(4).id, []);
    const holder = await opened([w(4).key], bareId);
    const label = (await db.execute(sql`
      INSERT INTO labels (project_id, name, color, kind, slug)
      VALUES (${bareId}, 'billing', '#888888', 'module', 'billing') RETURNING id
    `)) as unknown as Array<{ id: string }>;
    await design(w(5).id, ['billing']);
    const pre = await preflight([w(5).key], bareId);
    expect(codes(pre)).toEqual(['ISSUE_SCOPE_HELD']);
    expect(details(pre)).toContain('shares the whole project with');
    await close(holder.sessionId);
    await db.execute(sql`DELETE FROM labels WHERE id = ${label[0]?.id}`);
  });

  it('refuses the second move into build while the first builds', async () => {
    const w = await waveIn(bareId, 6, 7);
    const first = await opened([w(6).key], bareId);
    const second = await opened([w(7).key], bareId);
    for (const n of [6, 7]) {
      await seedIssueStatus(w(n).id, 'in_progress');
      await design(w(n).id, []);
    }
    const step = (n: number, to: string) =>
      call(author, 'PATCH', `/api/issues/${w(n).id}`, { workState: { step: to } });
    expect((await step(6, 'build')).status).toBe(200);
    const held = await step(7, 'build');
    expect([held.status, codes(held)]).toEqual([422, ['ISSUE_SCOPE_HELD']]);
    expect(details(held)).toContain(`shares the whole project with ${w(6).key}`);
    await close(first.sessionId);
    expect((await step(7, 'build')).status).toBe(200);
    await close(second.sessionId);
  });
});
