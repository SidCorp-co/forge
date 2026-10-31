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

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestUser,
  seedIssueStatus,
} from '../helpers/factories.js';
import { refusalCodes as codes, projectBuiltFrom, type Res } from '../helpers/pattern-world.js';
import { declareControls } from '../helpers/project-controls.js';

let projectId = '';
/** A project that declares no module label: a design there names none and holds it whole (ISS-609). */
let bareId = '';
let deviceId = '';
let adminId = '';
let box = '';
let author = '';

/** The module labels the wave's designs name, under the group labels this project files them in. */
const TREE: Record<string, string[]> = {
  'work-delivery': ['issues', 'lifecycle', 'pipeline'],
  'product-design': ['requirements', 'workflows', 'suggestions', 'feedback'],
  'projects-config': ['project-config'],
  execution: ['skills', 'prompt'],
  platform: ['mcp', 'db'],
};

async function moduleLabel(name: string, parentId: string | null): Promise<string> {
  const [row] = (await db.execute(sql`
    INSERT INTO labels (project_id, name, color, kind, slug, parent_id)
    VALUES (${projectId}, ${name}, '#888888', 'module', ${name}, ${parentId})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return String(row?.id);
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const admin = await createTestUser({ verified: true });
  const agent = await createTestUser({ kind: 'agent' });
  adminId = admin.id;
  projectId = await projectBuiltFrom(admin.id, null);
  for (const [group, children] of Object.entries(TREE)) {
    const parent = await moduleLabel(group, null);
    for (const child of children) await moduleLabel(child, parent);
  }
  bareId = await projectBuiltFrom(admin.id, null);
  deviceId = await createTestDevice(admin.id);
  for (const p of [projectId, bareId]) {
    // REQ-79 r6: scope_hold is strict's now; this test asks for it
    await declareControls(p, admin.id, { gates: { overrides: { scope_hold: 'enforce' } } });
    await addProjectMember(p, admin.id, 'admin');
    await addProjectMember(p, agent.id, 'member');
    await bindTestRunner(p, deviceId);
  }
  box = (
    await mintPat({
      permissions: ['*'],
      userId: admin.id,
      name: 'box-scope',
      deviceId,
      projectIds: [projectId, bareId],
    })
  ).plaintext;
  author = await userToken(agent.id);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function call(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
}

const details = (res: Res): string =>
  (res.body?.error?.refusals ?? []).map((r: Doc) => r.detail).join(' | ');

let seqBase = 0;

type Issue = { id: string; key: string };

/** A fresh set of issues keyed like the wave's, each with its two criteria written, by name. */
async function wave(...names: number[]): Promise<(n: number) => Issue> {
  return waveIn(projectId, ...names);
}

async function waveIn(project: string, ...names: number[]): Promise<(n: number) => Issue> {
  seqBase += 1000;
  const out = new Map<number, Issue>();
  for (const n of names) {
    const issue = await createTestIssue(project, adminId, seqBase + n, {
      status: 'open',
      createdAt: new Date(),
    });
    const res = await call(author, 'PATCH', `/api/issues/${issue.id}`, {
      acceptanceCriteria: '1. It holds.\n2. It is refused by name.',
    });
    expect(res.status).toBe(200);
    out.set(n, issue);
  }
  return (n) => {
    const issue = out.get(n);
    if (!issue) throw new Error(`this wave made no issue ${n}`);
    return issue;
  };
}

/** The issue's design through the REST door, then its contracts as given. */
async function design(issueId: string, modules: string[], contracts: string[] = []): Promise<void> {
  const res = await call(author, 'PUT', `/api/issues/${issueId}/design`, {
    criteria: [
      { criterion: 1, class: 'observable', pattern: null, proof: 'run it' },
      { criterion: 2, class: 'observable', pattern: null, proof: 'run it red' },
    ],
    modules,
    contracts: [],
  });
  expect([res.status, details(res)]).toEqual([200, '']);
  if (contracts.length > 0) {
    await db.execute(sql`
      UPDATE issue_designs SET contracts = ${sql`ARRAY[${sql.join(
        contracts.map((c) => sql`${c}`),
        sql`, `,
      )}]::text[]`} WHERE issue_id = ${issueId}`);
  }
}

/** The wave's designs: what each issue's tree and plan change, by module. */
const DESIGNS = {
  453: ['project-config', 'requirements', 'workflows', 'suggestions', 'issues'],
  454: ['lifecycle', 'issues', 'feedback', 'pipeline'],
  455: ['pipeline', 'requirements', 'skills', 'prompt', 'mcp'],
  469: ['issues'],
} as const;

const preflight = (keys: string[], project = projectId) =>
  call(box, 'POST', '/api/devices/me/run-sessions/preflight', {
    projectId: project,
    issueKeys: keys,
  });

async function open(keys: string[], project = projectId): Promise<{ res: Res; runId: string }> {
  const runId = randomUUID();
  const res = await call(box, 'POST', '/api/devices/me/run-sessions', {
    projectId: project,
    runId,
    issueKeys: keys,
    name: keys.join(','),
  });
  return { res, runId };
}

async function opened(
  keys: string[],
  project = projectId,
): Promise<{ sessionId: string; runId: string }> {
  const { res, runId } = await open(keys, project);
  expect([res.status, details(res)]).toEqual([200, '']);
  return { sessionId: String(res.body.sessionId), runId };
}

const close = (sessionId: string) =>
  call(box, 'POST', `/api/devices/me/run-sessions/${sessionId}/close`, { outcome: 'ended' });

async function admissibleKeys(): Promise<string[]> {
  const { readAdmissibleIssues } = await import('../../src/devices/admissible.js');
  const { items } = await readAdmissibleIssues({ deviceId, projectId });
  return items.map((i) => String(i.issueKey));
}

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

/** Ends every run still open on the bare project, so a red test leaves no holder to the next. */
async function closeBareRuns(): Promise<void> {
  const open = (await db.execute(sql`
    SELECT s.id FROM agent_sessions s
     WHERE s.project_id = ${bareId} AND s.kind = 'run_session' AND s.status = 'running'`)) as unknown as Array<{
    id: string;
  }>;
  for (const row of open) await close(row.id);
}

/** A run declared over landed work, as the QA master's judges are: it writes no code. */
async function landed(issueId: string): Promise<void> {
  await seedIssueStatus(issueId, 'awaiting_release');
}

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
