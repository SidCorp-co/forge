/**
 * A landing that already happened is recorded as the fact it is (REQ-45 BC-11, owner ruling
 * 2026-10-27), and each issue's verdicts are read beside it (BC-14), never as a gate (BC-15).
 *
 * Planted from adminhub-api, 2026-10-27: ISS-23/24/25 landed on `release/stg` through their own
 * requests; the stg head e663b765 was promoted to `release/production` by !5020 as merge commit
 * e2c9c827, which adds production's own commits, and !5021 merged it back into `release/stg`. The
 * record door answered RELEASE_LANDING_UNJUDGED at e2c9c827 (the passes stand at e663b765 and
 * earlier) and the only way through was re-judging 28 criteria at a new commit. The source host is
 * planted from that history.
 *
 * @direct-test-of packages/core/src/release-batch/recorded-landing.ts
 * @direct-test-of packages/contracts/src/verified-rule.ts
 * @direct-test-of packages/core/src/release-batch/landing-coverage.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { api } from '../helpers/api.js';
import { createTestUser, seedIssueStatus } from '../helpers/factories.js';
import {
  BRANCH,
  ok,
  readingsOf,
  record,
  refusalsOf,
  seedLandedWorld,
  statusOf,
  world,
} from '../helpers/landed-world.js';
import { declareControls } from '../helpers/project-controls.js';
import { seedProduction } from '../helpers/release-world.js';

// hoisted, so the planted host below reads them: `vi.mock` runs before the module body
const { S0, L23, L24, L25, E663, P0, PX, E2C9, ASIDE } = vi.hoisted(() => {
  const sha = (c: string) => c.repeat(40).slice(0, 40);
  return {
    S0: sha('0a'),
    L23: sha('23'),
    L24: sha('24'),
    L25: sha('25'),
    /** The stg head every landing is in, where QA judged most criteria. */
    E663: 'e663b7652530cb466798628dfb9b543fad039e47',
    P0: sha('0b'),
    PX: sha('0c'),
    /** !5020: release/stg into release/production, adding production's own P0 and PX. */
    E2C9: 'e2c9c8274bc58f9641b0b18083dcee89cec9e2a0',
    /** A commit on no branch the planted host holds. */
    ASIDE: sha('fe'),
  };
});
const PRODUCTION = 'release/production';

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => {
  const holds: Record<string, string[]> = {
    [L23]: [L23, S0],
    [L24]: [L24, L23, S0],
    [L25]: [L25, L24, L23, S0],
    [E663]: [E663, L25, L24, L23, S0],
    [E2C9]: [E2C9, PX, P0, E663, L25, L24, L23, S0],
    [ASIDE]: [ASIDE],
  };
  const branches: Record<string, string[]> = {
    // !5021 merged production back, so release/stg holds the promotion too
    'release/stg': [E2C9, E663, L25, L24, L23, S0],
    'release/production': [E2C9, PX, P0],
  };
  const key = (p: { commit: string; release: string }) => `${p.commit}@${p.release}`;
  const reader = {
    async ask(pairs: Array<{ commit: string; release: string }>) {
      const out = new Map<string, boolean | { unread: string }>();
      for (const p of pairs) {
        const held = holds[p.release];
        out.set(key(p), held ? held.includes(p.commit) : { unread: `no history for ${p.release}` });
      }
      return out;
    },
    witness: () => ({ via: 'source-host' as const }),
  };
  const host = {
    branchContains: async (branch: string, commit: string) =>
      (branches[branch] ?? []).includes(commit),
    readRange: async (base: string, head: string) => {
      const inHead = holds[head] ?? [];
      const inBase = new Set(holds[base] ?? []);
      const commits = inHead
        .filter((c) => !inBase.has(c))
        .map((c) => ({ sha: c, message: '', parents: [] }));
      return { ok: true, commits, complete: true };
    },
  };
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
    ancestrySourceFor: async () => ({ kind: 'host', host, reader }),
  };
});

const short = (c: string) => c.slice(0, 12);
let qaId = '';

beforeEach(async () => {
  // adminhub-api's own policy: verdicts are required, judged on stg
  await seedLandedWorld({ verdictsRequired: true, approvalRequired: true });
  // REQ-79 r6: builder_verdict is strict's now; this test asks for it
  await declareControls(world.projectId, world.ownerId, {
    gates: { overrides: { builder_verdict: 'enforce' } },
  });
  qaId = (await createTestUser({ verified: true })).id;
});

/** An issue that landed on release/stg at `landing` through its own request, with `n` criteria. */
async function landed(seq: number, landing: string, n = 3): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes,
                        merged_at, merged_commit_sha, merged_target)
    VALUES (${id}, ${world.projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${world.ownerId},
            ${JSON.stringify({ section: 'Skip', userFacing: '-' })}::jsonb,
            now() - interval '2 hours', ${landing}, ${BRANCH})
  `);
  await replaceCriteria(
    id,
    Array.from({ length: n }, (_, i) => ({ n: i + 1, statement: `criterion ${i + 1} holds` })),
  );
  await seedIssueStatus(id, 'awaiting_release');
  return id;
}

/** A verdict on criterion `n` at commit `at`, by QA, or by the builder where `by` says so. */
async function judged(issueId: string, n: number, at: string, by: 'qa' | 'builder' = 'qa') {
  const author = by === 'qa' ? qaId : world.ownerId;
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    author_user_id, author_agency, judge)
    SELECT id, ${issueId}, 'pass', 'Ran it on stg.', 'commit', ${at}, ${author}, 'agent', 'qa'
      FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL
  `);
}

/** The owner built the issue: a check run recorded by them with no session makes theirs a builder's pass. */
async function builtByOwner(issueId: string) {
  await db.execute(sql`
    INSERT INTO issue_check_runs (id, issue_id, kind, name, scope, command, result, duration_ms,
                                  started_at, head_sha, run_session_id, via, recorded_by)
    VALUES (${randomUUID()}, ${issueId}, 'tests', 'unit', 'api', 'artisan test', 'pass', 1000,
            now() - interval '3 hours', ${L23}, NULL, 'report', ${world.ownerId})
  `);
}

async function adminhubShape() {
  const i23 = await landed(23, L23);
  const i24 = await landed(24, L24, 2);
  const i25 = await landed(25, L25, 2);
  await builtByOwner(i23);
  await judged(i23, 1, E663);
  await judged(i23, 2, E2C9);
  await judged(i23, 3, L23, 'builder');
  await judged(i24, 1, E663);
  await judged(i24, 2, E663);
  await judged(i25, 1, L25);
  return { i23, i24, i25 };
}

describe('a promotion that already merged is recorded as the fact it is (REQ-45 BC-11)', () => {
  it('records e2c9c827 over ISS-23/24/25, reading each criterion beside it (BC-14)', async () => {
    const { i23, i24, i25 } = await adminhubShape();

    const res = await record([i23, i24, i25], E2C9);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ commit: E2C9, branch: BRANCH, closed: [i23, i24, i25] });
    const readings = readingsOf(res.body);
    expect(readings).toContain(
      `ISS-23: 3 live criteria, c1 pass at \`${short(E663)}\`, which \`${short(E2C9)}\` holds (the recorded commit adds 3 commits); c2 pass at \`${short(E2C9)}\`; c3 only a pass the verified rule does not count: passed by the run that built it, and a builder's own pass never counts where gate builder_verdict is enforced (gates.overrides.builder_verdict relaxes it)`,
    );
    expect(readings).toContain(
      `ISS-24: 2 live criteria, c1-2 pass at \`${short(E663)}\`, which \`${short(E2C9)}\` holds (the recorded commit adds 3 commits)`,
    );
    expect(readings).toContain(
      `ISS-25: 2 live criteria, c1 pass at \`${short(L25)}\`, which \`${short(E2C9)}\` holds (the recorded commit adds 4 commits); c2 no pass: no verdict was recorded`,
    );
    for (const id of [i23, i24, i25]) expect(await statusOf(id)).toBe('closed');

    // the record's own read and the issue's note carry the same coverage
    const read = await ok(
      api(world.token, 'GET', `/api/projects/${world.projectId}/release-records/${res.body.runId}`),
    );
    expect(read.readings).toEqual(readings);
    const [note] = (await db.execute(sql`
      SELECT body FROM comments WHERE issue_id = ${i24} AND body LIKE 'Landed on%'
    `)) as unknown as Array<{ body: string }>;
    expect(note?.body).toContain(`ISS-24: 2 live criteria, c1-2 pass at \`${short(E663)}\``);
  });

  it('records the stg head e663b765 the same way, where 15 criteria stood on the builder', async () => {
    const { i23, i24, i25 } = await adminhubShape();

    const res = await record([i23, i24, i25], E663);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(readingsOf(res.body)).toContain(
      `ISS-23: 3 live criteria, c1 pass at \`${short(E663)}\`; c2 no pass: it was judged at \`${short(E2C9)}\`, which \`${short(E663)}\` does not hold; c3 only a pass the verified rule does not count: passed by the run that built it, and a builder's own pass never counts where gate builder_verdict is enforced (gates.overrides.builder_verdict relaxes it)`,
    );
  });

  it('records on the branch the body names, where the commit is', async () => {
    const { i24 } = await adminhubShape();

    const res = await record([i24], E2C9, { branch: PRODUCTION });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ branch: PRODUCTION, commit: E2C9 });
    expect(readingsOf(res.body)).toContain(
      `the source host reads \`${short(E2C9)}\` on \`${PRODUCTION}\``,
    );
  });
});

describe('it still refuses what is not a fact', () => {
  it('refuses a commit the host does not hold on the named branch', async () => {
    const { i24 } = await adminhubShape();

    const res = await record([i24], E663, { branch: PRODUCTION });

    expect(res.status).toBe(422);
    const [refusal] = refusalsOf(res.body);
    expect(refusal?.code).toBe('RELEASE_LANDING_NOT_IN_COMMIT');
    expect(refusal?.detail).toContain(`as not on \`${PRODUCTION}\``);
    expect(await statusOf(i24)).toBe('awaiting_release');
  });

  it('refuses an issue whose landing the commit does not hold', async () => {
    const { i24 } = await adminhubShape();
    const elsewhere = await landed(26, ASIDE);

    const res = await record([i24, elsewhere], E2C9);

    expect(res.status).toBe(422);
    expect(refusalsOf(res.body).map((r) => r.code)).toEqual(['RELEASE_LANDING_NOT_IN_COMMIT']);
    expect(await statusOf(i24)).toBe('awaiting_release');
  });

  it('refuses an empty branch as a malformed body', async () => {
    const { i24 } = await adminhubShape();

    const res = await record([i24], E2C9, { branch: ' ' });

    expect(res.status).toBe(400);
    expect(await statusOf(i24)).toBe('awaiting_release');
  });

  it('refuses a branch on a project with production, whose record reads what it serves', async () => {
    await seedProduction({ projectId: world.projectId, ownerId: world.ownerId, probes: 'none' });
    const { i24 } = await adminhubShape();

    const res = await record([i24], E2C9, { branch: PRODUCTION });

    expect(res.status).toBe(422);
    expect(refusalsOf(res.body)[0]?.code).toBe('RELEASE_RECORD_BRANCH_UNUSED');
  });
});
