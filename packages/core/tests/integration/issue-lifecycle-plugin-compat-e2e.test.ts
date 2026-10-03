/**
 * ISS-54 cm:hack — forge-plugin 3.36.542 still speaks the seventeen statuses ISS-54 retired, and
 * these cases drive its verbs through the REST API exactly as it sends them: a personal token,
 * `Authorization` and `Content-Type` and nothing else, the retired names in `toStatus` and in list
 * filters, its lease inside a whole `sessionContext` written under an `expect`. What it must get
 * back is its own words, and what must be stored is the ten-status model with no second source.
 * Exit: until forge-plugin moves to the 10-status model (plugin-followups.md) — then this file is
 * deleted with `issues/legacy-status.ts`.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedProjectDocument,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let mintPat: typeof import('../../src/auth/pat.js')['mintPat'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV ??= 'test';

  const [transitionMod, routesMod, searchMod, patMod, errMod] = await Promise.all([
    import('../../src/issues/transition.js'),
    import('../../src/issues/routes.js'),
    import('../../src/issues/search.js'),
    import('../../src/auth/pat.js'),
    import('../../src/middleware/error.js'),
  ]);
  mintPat = patMod.mintPat;
  app = new Hono();
  app.route('/api/projects', routesMod.issueProjectRoutes);
  app.route('/api/projects', searchMod.searchRoutes);
  app.route('/api/issues', routesMod.issueRoutes);
  app.route('/api/issues', transitionMod.transitionRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

const HEAD = '33637c612ef15be6f924520c0d201a0889d8ed7e';

interface World {
  projectId: string;
  humanId: string;
  /** The agent's personal token: what forge-plugin's `forge` CLI holds. */
  plugin: string;
}

async function world(): Promise<World> {
  const human = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const agent = await createTestUser(harness.db, { kind: 'agent' });
  const project = await createTestProject(harness.db, human.id);
  await createTestProjectMember(harness.db, { userId: agent.id, projectId: project.id });
  await seedProjectDocument(harness.db, project.id, human.id, { environments: {} });
  const pat = await mintPat({ userId: agent.id, name: 'forge cli', boundProjectId: project.id });
  return { projectId: project.id, humanId: human.id, plugin: pat.plaintext };
}

async function insertIssue(w: World, status: string): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id, status)
    VALUES (${w.projectId}::uuid, 'a plugin-driven issue', ${w.humanId}::uuid, ${status})
    RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

/** A request as forge-plugin sends it: its token, a JSON body, no other header. */
async function call(
  w: World,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${w.plugin}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

const transition = (w: World, id: string, toStatus: string, more: Record<string, unknown> = {}) =>
  call(w, 'POST', `/api/issues/${id}/transition`, { toStatus, ...more });

async function lease(holder: string) {
  return { holder, renewedAt: new Date().toISOString(), minutes: 30, history: [] };
}

async function kernelMoves(issueId: string): Promise<Array<{ from: string; to: string }>> {
  const rows = (await harness.db.execute(sql`
    SELECT from_status, to_status FROM kernel_transitions
     WHERE entity = 'issue' AND entity_id = ${issueId} ORDER BY created_at, id
  `)) as unknown as Array<{ from_status: string; to_status: string }>;
  return rows.map((r) => ({ from: r.from_status, to: r.to_status }));
}

async function stored(issueId: string) {
  const rows = (await harness.db.execute(sql`
    SELECT i.status, i.waiting_kind, i.session_context, w.step, w.lease_holder, w.branch,
           w.head_sha, w.left_status, w.legacy_status
      FROM issues i LEFT JOIN issue_work_state w ON w.issue_id = i.id
     WHERE i.id = ${issueId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] as Record<string, unknown>;
}

describe('the plugin ladder, driven in its own words', () => {
  it('walks open → confirmed → approved → in_progress → developed → testing → awaiting_release', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');

    // The claim: a whole sessionContext carrying the lease, CAS'd against what it read (null).
    const claim = await call(w, 'PATCH', `/api/issues/${id}`, {
      sessionContext: { lease: await lease('plugin-run-1') },
      expect: { sessionContext: null },
    });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect((claim.body.sessionContext as { lease: { holder: string } }).lease.holder).toBe(
      'plugin-run-1',
    );

    const confirmed = await transition(w, id, 'confirmed');
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.status).toBe('confirmed');
    expect(confirmed.headers.get('X-Forge-Status-Compat')).toContain('STATUS_RETIRED');
    expect(await stored(id)).toMatchObject({
      status: 'in_progress',
      step: 'plan',
      legacy_status: 'confirmed',
      lease_holder: 'plugin-run-1',
    });
    // The lease lives on the work state alone: no second copy in the blob.
    expect((await stored(id)).session_context).toEqual({});

    const read = await call(w, 'GET', `/api/issues/${id}`);
    expect(read.body.status).toBe('confirmed');

    expect(
      (
        await call(w, 'PATCH', `/api/issues/${id}`, {
          plan: 'the plan',
          acceptanceCriteria: '1. it works',
        })
      ).status,
    ).toBe(200);
    const approved = await transition(w, id, 'approved');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('approved');

    const building = await transition(w, id, 'in_progress');
    expect(building.status, JSON.stringify(building.body)).toBe(200);
    expect(building.body.status).toBe('in_progress');
    expect((await stored(id)).step).toBe('build');

    // The worklog the plugin writes after a push: its branch and head become typed columns.
    const before = (await call(w, 'GET', `/api/issues/${id}`)).body.sessionContext;
    const pushed = await call(w, 'PATCH', `/api/issues/${id}`, {
      sessionContext: {
        ...(before as Record<string, unknown>),
        worklog: { branch: 'ISS-1-thing', head: HEAD },
      },
      expect: { sessionContext: before },
    });
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(await stored(id)).toMatchObject({ branch: 'ISS-1-thing', head_sha: HEAD });

    const movesBeforeRungs = (await kernelMoves(id)).length;
    const developed = await transition(w, id, 'developed');
    expect(developed.status, JSON.stringify(developed.body)).toBe(200);
    expect(developed.body.status).toBe('developed');
    const testing = await transition(w, id, 'testing');
    expect(testing.status, JSON.stringify(testing.body)).toBe(200);
    expect(testing.body.status).toBe('testing');
    // Two rungs of one stored status: the step moved, the status did not, nothing was audited.
    expect(await stored(id)).toMatchObject({
      status: 'in_progress',
      step: 'test',
      legacy_status: 'testing',
    });
    expect((await kernelMoves(id)).length).toBe(movesBeforeRungs);

    // A ten-status reader of the same row sees the status and the step, not the rung.
    const ten = await call(w, 'GET', `/api/issues/${id}`, undefined, { 'X-Forge-Lifecycle': '10' });
    expect(ten.body.status).toBe('in_progress');
    expect((ten.body.workState as { step: string }).step).toBe('test');

    // The plugin posts its verdict as a comment fence; the comment door mirrors it into
    // `criterion_verdicts` (ISS-55's dual path), which is what the gate reads.
    const verdict = await call(w, 'POST', `/api/issues/${id}/comments`, {
      body: [
        '```forge-record',
        'criterion: 1 — it works',
        'verdict: pass',
        `runtime: ${HEAD}`,
        'evidence: https://ci.example.test/runs/1/judge-log.txt',
        'why: exercised',
        '```',
        '',
        '`forge-record: verdict · contract 1`',
      ].join('\n'),
    });
    expect(verdict.status, JSON.stringify(verdict.body)).toBe(201);
    const gate = await transition(w, id, 'awaiting_release');
    expect(gate.status, JSON.stringify(gate.body)).toBe(200);
    expect(gate.body.status).toBe('awaiting_release');
    expect(await stored(id)).toMatchObject({ status: 'awaiting_release', legacy_status: null });
    expect((await kernelMoves(id)).map((m) => m.to)).toEqual([
      'in_progress',
      'approved',
      'in_progress',
      'awaiting_release',
    ]);
  });

  it('refuses developed with no branch recorded, as the old rung did (NO_WORK_EVIDENCE)', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    await call(w, 'PATCH', `/api/issues/${id}`, {
      sessionContext: { lease: await lease('plugin-run-2') },
      expect: { sessionContext: null },
    });
    expect((await transition(w, id, 'in_progress')).status).toBe(200);
    const res = await transition(w, id, 'developed');
    expect(res.body.code, JSON.stringify(res.body)).toBe('NO_WORK_EVIDENCE');
    expect((await stored(id)).legacy_status).toBeNull();
  });

  it('parks at waiting, stored as needs_info with its kind, and returns to where it left', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    await call(w, 'PATCH', `/api/issues/${id}`, {
      sessionContext: { lease: await lease('plugin-run-3') },
      expect: { sessionContext: null },
    });
    expect((await transition(w, id, 'in_progress')).status).toBe(200);
    const parked = await transition(w, id, 'waiting', {
      reason: 'needs a Stripe test account',
      waitingKind: 'needs_resource',
    });
    expect(parked.status, JSON.stringify(parked.body)).toBe(200);
    expect(parked.body.status).toBe('needs_info');
    expect(await stored(id)).toMatchObject({
      status: 'needs_info',
      waiting_kind: 'needs_resource',
      left_status: 'in_progress',
    });
    const filtered = await call(w, 'GET', `/api/projects/${w.projectId}/issues?status=waiting`);
    expect((filtered.body.items as Array<{ id: string }>).map((r) => r.id)).toEqual([id]);

    const back = await transition(w, id, 'in_progress');
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await stored(id)).toMatchObject({
      status: 'in_progress',
      waiting_kind: null,
      left_status: null,
    });
  });
});

describe('the lease round-trips through sessionContext with no second source', () => {
  it('a CAS write against a stale value is refused with the composed current value', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    const first = { lease: await lease('plugin-run-a'), note: 'kept' };
    expect(
      (
        await call(w, 'PATCH', `/api/issues/${id}`, {
          sessionContext: first,
          expect: { sessionContext: null },
        })
      ).status,
    ).toBe(200);

    const loser = await call(w, 'PATCH', `/api/issues/${id}`, {
      sessionContext: { lease: await lease('plugin-run-b') },
      expect: { sessionContext: null },
    });
    expect(loser.status).toBe(409);
    expect(loser.body.code).toBe('SESSION_CONTEXT_MISMATCH');
    const current = (loser.body.details as { current: { lease: { holder: string }; note: string } })
      .current;
    expect(current.lease.holder).toBe('plugin-run-a');
    expect(current.note).toBe('kept');
    expect((await stored(id)).lease_holder).toBe('plugin-run-a');
  });

  it('a write that drops the lease key without having read it is refused naming the key', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    await call(w, 'PATCH', `/api/issues/${id}`, {
      sessionContext: { lease: await lease('plugin-run-c') },
      expect: { sessionContext: null },
    });
    const res = await call(w, 'PATCH', `/api/issues/${id}`, { sessionContext: { other: 1 } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SESSION_CONTEXT_DROPS_UNREAD_KEYS');
    expect(
      res.body.dropped ?? (res.body.details as { dropped?: string[] })?.dropped ?? res.body,
    ).toBeTruthy();
    expect(String(res.body.message)).toContain('lease');
    expect((await stored(id)).lease_holder).toBe('plugin-run-c');
  });

  it('the release of a lease, written as the plugin writes it, clears the work state', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    const held = { lease: await lease('plugin-run-d') };
    await call(w, 'PATCH', `/api/issues/${id}`, {
      sessionContext: held,
      expect: { sessionContext: null },
    });
    const read = (await call(w, 'GET', `/api/issues/${id}`)).body.sessionContext;
    const released = await call(w, 'PATCH', `/api/issues/${id}`, {
      sessionContext: {},
      expect: { sessionContext: read },
    });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(await stored(id)).toMatchObject({ lease_holder: null });
  });
});

describe('list and search filters in the retired words', () => {
  it('matches the rows a 17-status reader is shown at each name', async () => {
    const w = await world();
    const id = await insertIssue(w, 'open');
    await call(w, 'PATCH', `/api/issues/${id}`, {
      sessionContext: {
        lease: await lease('plugin-run-e'),
        worklog: { branch: 'ISS-9-x', head: HEAD },
      },
      expect: { sessionContext: null },
    });
    await transition(w, id, 'in_progress');
    expect((await transition(w, id, 'developed')).status).toBe(200);
    const other = await insertIssue(w, 'open');

    const developed = await call(w, 'GET', `/api/projects/${w.projectId}/issues?status=developed`);
    expect(developed.headers.get('X-Forge-Status-Compat')).toContain('STATUS_RETIRED');
    const devRows = developed.body.items as Array<{ id: string; status: string }>;
    expect(devRows.map((r) => [r.id, r.status])).toEqual([[id, 'developed']]);

    const inProgress = await call(
      w,
      'GET',
      `/api/projects/${w.projectId}/issues?status=in_progress`,
    );
    expect((inProgress.body.items as unknown[]).length).toBe(0);

    const takeable = await call(
      w,
      'GET',
      `/api/projects/${w.projectId}/issues/search?status=open&status=confirmed&status=approved&status=reopen`,
    );
    expect((takeable.body.items as Array<{ id: string }>).map((r) => r.id)).toEqual([other]);

    const live = await call(
      w,
      'GET',
      `/api/projects/${w.projectId}/issues/search?statusNot=closed&statusNot=dropped&statusNot=developed`,
    );
    expect((live.body.items as Array<{ id: string }>).map((r) => r.id)).toEqual([other]);
  });
});
