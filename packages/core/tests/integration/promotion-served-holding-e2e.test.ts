/**
 * ISS-1169 — a promotion branch's served commit is read as holding the landing branch's landings.
 * Planted from adminhub-api on 2026-11-09: work lands on `release/stg` and is promoted by merge to
 * `release/production`. ISS-23's landing is marked at e2c9c827 on `release/stg`; production serves
 * f6ff753 (v0.18.0), marked on `release/production` by another issue's landing, and holds e2c9c827
 * through the promotion. Passes were judged at e663b765, the landing's stg parent, and again on
 * production. Coverage weighs them at the landing, and the merge marks answer neither pair: the
 * production pass read "`f6ff753` landed on `release/production` and `e2c9c827` on `release/stg`" and
 * the parent pass "no merge mark records the landing e663b765", for ever.
 *
 * The pass that reads what a project serves now asks the source host each pair coverage reads (the
 * landing against every commit its issue's verdicts name, and back where that commit does not hold
 * it) and keeps the answer (`served_ancestry`); the reads answer from the kept row where marks cannot
 * place a pair, and ask no host.
 *
 * @direct-test-of packages/core/src/release-batch/served-ancestry.ts
 * @direct-test-of packages/core/src/release-batch/landed-build-holds.ts
 * @direct-test-of packages/core/src/release-batch/landed-build.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { aheadBuildsOf, landedBuildsOf } from '../../src/release-batch/landed-build.js';
import { keepHolding, readServedAncestry } from '../../src/release-batch/served-ancestry.js';
import { seedIssueStatus } from '../helpers/factories.js';
import { agreedRequirement, bcOf, traced } from '../helpers/landed-requirement.js';
import { landedIssue, seedLandedWorld, world } from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/** e663b765 is the stg head the promotion merged; e2c9c827 that merge; f6ff753 production's tag. */
const PARENT = 'e663b7652530cb466798628dfb9b543fad039e47';
const LANDING = 'e2c9c8274bc58f9641b0b18083dcee89cec9e2a0';
const PRODUCTION = 'f6ff753'.padEnd(40, 'a');
const STG = 'release/stg';
const PROMOTED = 'release/production';
const STG_PROBE = 'https://stg-adminhub-api.example.test/api/v1/build-info';
const PRODUCTION_PROBE = 'https://adminhub-api.example.test/api/v1/build-info';
const short = (sha: string) => sha.slice(0, 12);

const H = vi.hoisted(() => {
  /** Each commit's ancestors, itself included: release/production's history through the promotion. */
  const history: Record<string, readonly string[]> = {};
  const state = { calls: 0, refusing: false };
  const host = () => ({
    fullName: 'acme/adminhub-api',
    compare: async (base: string, head: string) => {
      state.calls += 1;
      if (state.refusing) throw new Error('429 Too Many Requests');
      return base === head ? 'identical' : history[head]?.includes(base) ? 'ahead' : 'diverged';
    },
    compareFiles: async () => {
      state.calls += 1;
      return { status: 'diverged', files: ['src/accounts/list.ts'], changes: [] };
    },
    commitFiles: async () => {
      state.calls += 1;
      return { files: [], changes: [] };
    },
  });
  return { history, state, host };
});

vi.mock('../../src/integrations/source-host/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/index.js')>()),
  resolveSourceHost: async () => H.host(),
}));

const probeOn = (url: string) => ({
  runtime: [{ type: 'http' as const, url, path: 'commit', identifies: 'source' as const }],
});

/** adminhub-api's document: lands on `release/stg`, promoted by merge to `release/production`. */
async function promotionProject(): Promise<void> {
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: STG,
    promotions: [{ from: STG, to: PROMOTED, via: 'merge' }],
    environments: {
      stg: {
        tier: 'staging',
        deploysFrom: STG,
        deployment: { mode: 'external' },
        url: 'https://stg-adminhub-api.example.test',
        verification: probeOn(STG_PROBE),
      },
      production: {
        tier: 'production',
        deploysFrom: PROMOTED,
        deployment: { mode: 'external' },
        url: 'https://adminhub-api.example.test',
        verification: probeOn(PRODUCTION_PROBE),
      },
    } as never,
    extra: {
      release: { approval: { required: true }, changeRequests: false },
      delivery: { verdictsRequired: true, judgedOn: 'stg' },
    } as never,
  });
}

/** Another issue's landing recorded at production's commit, on `release/production`. */
async function productionMarked(): Promise<void> {
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at,
                        merged_commit_sha, merged_target)
    VALUES (${randomUUID()}, ${world.projectId}, 900, 'issue 900', 'closed', ${world.ownerId},
            now() + interval '1 minute', ${PRODUCTION}, ${PROMOTED})
  `);
}

/** QA's pass on criterion `n` at `commit`, covering `covers` where given. */
async function passed(issueId: string, n: number, commit: string, covers?: string[]) {
  const covered = covers ? sql`ARRAY[${sql.join(covers, sql`, `)}]::text[]` : sql`NULL`;
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    covers, author_user_id, author_agency, judge)
    SELECT id, ${issueId}, 'pass', ${`held at ${commit}`}, 'commit', ${commit}, ${covered},
           ${world.ownerId}, 'agent', 'qa'
      FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL
  `);
}

/** ISS-23 landed at LANDING on `release/stg`, its criteria traced BC-1.. and passed at `at[n]`. */
async function judgedIssue(req: string, at: readonly string[], covers?: string[]) {
  const issue = await landedIssue(
    23,
    LANDING,
    at.map((_, i) => `Criterion ${i + 1} holds on stg`),
  );
  await traced(req, issue, 23, Object.fromEntries(at.map((_, i) => [i + 1, `BC-${i + 1}`])));
  for (const [i, commit] of at.entries()) await passed(issue, i + 1, commit, covers);
  await seedIssueStatus(issue, 'closed');
  return issue;
}

async function keptPairs(): Promise<Array<[string, string, boolean]>> {
  const rows = (await db.execute(sql`
    SELECT judged_commit, served_commit, carried FROM served_ancestry
     WHERE project_id = ${world.projectId} ORDER BY judged_commit, served_commit
  `)) as unknown as Array<{ judged_commit: string; served_commit: string; carried: boolean }>;
  return rows.map((r) => [r.judged_commit, r.served_commit, r.carried]);
}

const CROSSED = `${short(PRODUCTION)} landed on \`${PROMOTED}\` and ${short(LANDING)} on \`${STG}\``;

beforeEach(async () => {
  await seedLandedWorld();
  await promotionProject();
  await productionMarked();
  H.state.calls = 0;
  H.state.refusing = false;
  for (const k of Object.keys(H.history)) delete H.history[k];
  Object.assign(H.history, {
    [PARENT]: [PARENT],
    [LANDING]: [LANDING, PARENT],
    [PRODUCTION]: [PRODUCTION, LANDING, PARENT],
  });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(STG_PROBE) || url.startsWith(PRODUCTION_PROBE)) {
      return Response.json({ commit: PRODUCTION });
    }
    return real(input, init);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('a promotion served commit holds the landing branch’s landing (ISS-1169)', () => {
  it('reads a pass at production and one at the landing’s parent unread, then counts both from the kept answers', async () => {
    const req = await agreedRequirement(['Accounts list', 'An account opens', 'A search narrows']);
    await judgedIssue(req, [PRODUCTION, PARENT, LANDING]);

    const before = await bcOf(req, 'BC-1');
    expect(before.verdict).toBe('not_judged');
    expect(before.issues[0]?.notCounted).toContain(CROSSED);
    expect((await bcOf(req, 'BC-2')).issues[0]?.notCounted).toContain(
      `no merge mark records the landing ${short(PARENT)}`,
    );

    await readServedAncestry();
    const asked = H.state.calls;

    const held = await bcOf(req, 'BC-1');
    expect(held.verdict).toBe('passing');
    expect(held.issues[0]?.identity).toBe(
      `judged at commit ${short(PRODUCTION)}, which holds landing ${short(LANDING)}`,
    );
    const carried = await bcOf(req, 'BC-2');
    expect(carried.verdict).toBe('passing');
    expect(carried.issues[0]?.identity).toContain(
      `carried from \`${short(PARENT)}\` to \`${short(LANDING)}\`, which descends from it (the source host answered so at`,
    );
    expect((await bcOf(req, 'BC-3')).verdict).toBe('passing');
    // the reads answered from the kept rows, and asked no host
    expect(H.state.calls).toBe(asked);
  });

  it('stays unread where no answer is kept, naming the marks and the answer that is missing', async () => {
    const req = await agreedRequirement(['Accounts list']);
    await judgedIssue(req, [PRODUCTION]);
    H.state.refusing = true;

    expect(await readServedAncestry()).toMatchObject({ written: 0 });

    const bc = await bcOf(req, 'BC-1');
    expect(bc.verdict).toBe('not_judged');
    expect(bc.issues[0]?.notCounted).toContain(
      `${CROSSED}; no answer of the source host is kept on whether ${short(PRODUCTION)} holds ${short(LANDING)} (\`served_ancestry\`): the pass that reads what this project serves asks it once and keeps it`,
    );
  });

  it('still refuses to carry a pass covering a path, since a kept answer names no file between', async () => {
    const req = await agreedRequirement(['Accounts list']);
    await judgedIssue(req, [PARENT], ['src/accounts/']);

    await readServedAncestry();

    const bc = await bcOf(req, 'BC-1');
    expect(bc.verdict).toBe('not_judged');
    expect(bc.issues[0]?.notCounted).toContain(
      `which \`${short(LANDING)}\` descends from (the source host answered so at`,
    );
    expect(bc.issues[0]?.notCounted).toContain(
      'and it covers `src/accounts/`: what changed between them was not read',
    );
  });

  it('asks each landing pair once, keeps it, and asks nothing on the next pass', async () => {
    const req = await agreedRequirement(['Accounts list', 'An account opens']);
    await judgedIssue(req, [PRODUCTION, PARENT]);

    await readServedAncestry();

    expect(await keptPairs()).toEqual([
      // does the parent hold the landing: no, so the pass asked the other way
      [LANDING, PARENT, false],
      [LANDING, PRODUCTION, true],
      [PARENT, LANDING, true],
      [PARENT, PRODUCTION, true],
    ]);
    const asked = H.state.calls;
    expect(await readServedAncestry()).toMatchObject({ asked: 0, written: 0 });
    expect(H.state.calls).toBe(asked);
  });

  it('moves the steward’s build ahead to a commit on another branch the kept answer says holds the landing', async () => {
    const issue = await landedIssue(24, LANDING, ['Criterion 1 holds']);
    await passed(issue, 1, PRODUCTION);
    const landed = await landedBuildsOf([issue]);

    expect((await aheadBuildsOf(world.projectId, landed)).get(issue)).toMatchObject({
      sha: LANDING,
    });

    await keepHolding(world.projectId, LANDING, PRODUCTION);

    expect((await aheadBuildsOf(world.projectId, landed)).get(issue)).toMatchObject({
      sha: PRODUCTION,
      from: 'ahead',
    });
  });
});
