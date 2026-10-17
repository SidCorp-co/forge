/**
 * ISS-1421 — the releasing sweep settles every row at Releasing that no live release run carries,
 * out loud, and touches nothing a live run carries.
 *
 * Its first pass runs on every project at deploy, against rows standing today: sid-desk had ten,
 * one with no claim at all and one whose release had already shipped alone. So every shape is
 * planted here and one pass is run over them all: no claim; a claim on a completed, a failed and a
 * cancelled run; a claim on a running and a paused run; production carrying the landing commit or
 * not; no probe declared; a probe that is down; no landing commit; a record the release door
 * refuses; an Awaiting release entry criterion the row never earned; a promoted roster an abort
 * left behind. Real Postgres, a live probe server and a GitHub double answering compares, because
 * what is asserted is what one pass leaves on the rows.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FORGE_AUTHOR_ID } from '../../src/comments/forge-author.js';
import { TERMINAL_PIPELINE_RUN_STATUSES } from '../../src/pipeline/status-sets.js';
import type { ProductionReading } from '../../src/release-batch/releasing-settle-reading.js';
import { releaseRunStopped } from '../../src/release-batch/run-ended-words.js';
import { type GitHubDouble, startGitHubDouble } from '../helpers/github-double.js';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

/** What production's probe serves. */
const SERVING = '5e1d0a9c3b7f2e4d6a8c0b1f3e5d7a9c2b4f6e8d';
/** A landing commit SERVING descends from. */
const SHIPPED = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
/** The start branch's head, which a batch's range read stops at. */
const MAIN_HEAD = '9a1b2c3d4e5f60718293a4b5c6d7e8f901234567';
/** A landing commit SERVING does not carry. */
const UNSHIPPED = '9f8e7d6c5b4a39281706f5e4d3c2b1a098f7e6d5';

let harness: TestDatabase;
let repo: GitHubDouble;
let projectId: string;
let ownerId: string;
let drainOutboxOnce: typeof import('../../src/pipeline/outbox-worker.js').drainOutboxOnce;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  repo = await startGitHubDouble();
  drainOutboxOnce = (await import('../../src/pipeline/outbox-worker.js')).drainOutboxOnce;
  const { hooks } = await import('../../src/pipeline/hooks.js');
  (await import('../../src/pipeline/subscribers.js')).registerActivitySubscribers(hooks);
}, 60_000);

afterAll(async () => {
  if (repo) await repo.close();
  if (harness) await harness.cleanup();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

beforeEach(async () => {
  await truncateAll(harness.db);
  repo.reset();
  repo.compare.set(`${SHIPPED}...${SERVING}`, { status: 'ahead' });
  repo.compare.set(`${UNSHIPPED}...${SERVING}`, { status: 'behind' });
  repo.compare.set(`${SERVING}...${UNSHIPPED}`, { status: 'ahead', files: ['src/a.ts'] });
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await repo.bind(projectId, ownerId);
  const { forgetCarriage } = await import('../../src/release-batch/carriage.js');
  forgetCarriage();
});

async function production(opts: { probe?: 'none' | 'down' } = {}): Promise<void> {
  await fx.declareProduction(
    opts.probe === 'none'
      ? { verify: null }
      : opts.probe === 'down'
        ? { verify: { probes: [{ url: 'http://127.0.0.1:9/version' }], stableReads: 1 } }
        : {},
  );
  fx.serve(SERVING);
}

async function plantRun(status: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
    VALUES (${id}, ${projectId}, 'system', ${status}, '{"source":"release-batch"}'::jsonb)
  `);
  return id;
}

async function plant(
  opts: { claim?: string | null; landing?: string | null; note?: unknown } = {},
) {
  const id = await fx.insertIssue('releasing', opts.note === undefined ? undefined : opts.note);
  await harness.db.execute(sql`
    UPDATE issues
       SET release_batch_run_id = ${opts.claim ?? null},
           merged_commit_sha = ${opts.landing === undefined ? SHIPPED : opts.landing}
     WHERE id = ${id}
  `);
  return id;
}

async function bodies(id: string): Promise<string[]> {
  const rows = await harness.db.execute<{ body: string }>(
    sql`SELECT body FROM comments WHERE issue_id = ${id} ORDER BY created_at, id`,
  );
  return rows.map((r) => r.body);
}

async function settle() {
  const { settleStrandedReleasing } = await import('../../src/release-batch/releasing-settle.js');
  return settleStrandedReleasing();
}

async function recordFor(issueId: string): Promise<Record<string, unknown> | null> {
  const rows = await harness.db.execute<{ metadata: Record<string, unknown> }>(sql`
    SELECT metadata FROM pipeline_runs
    WHERE metadata ->> 'source' = 'release-record' AND metadata -> 'issueIds' ? ${issueId}
  `);
  return rows[0]?.metadata ?? null;
}

describe('a row at Releasing that nothing carries (criteria 13, 14, 15, 16, 17)', () => {
  it('closes a row no run claims through a release record, where production carries its landing', async () => {
    await production();
    const id = await plant();

    const result = await settle();

    expect(result).toEqual({ settled: 1, closed: 1, failed: 0 });
    expect(await fx.stored(id)).toMatchObject({ status: 'closed', claim: null });
    const [said] = await bodies(id);
    expect(said).toContain('No release run claims this issue, so nothing was releasing it');
    expect(said).toContain(
      `serves \`${SERVING}\`. That carries this issue's landing commit \`${SHIPPED}\``,
    );
    const record = await recordFor(id);
    expect(record).toMatchObject({ commit: SERVING, identity: SERVING, verification: 'probed' });
  });

  it.each([...TERMINAL_PIPELINE_RUN_STATUSES])(
    'returns a row whose run ended %s to Awaiting release, saying how it ended, where production lacks it',
    async (runStatus) => {
      await production();
      const run = await plantRun(runStatus);
      const id = await plant({ claim: run, landing: UNSHIPPED });

      expect(await settle()).toEqual({ settled: 1, closed: 0, failed: 0 });

      expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
      const [said] = await bodies(id);
      expect(said).toContain(`${releaseRunStopped(runStatus)}, so nothing was releasing it`);
      expect(said).not.toContain(`ended ${runStatus}`);
      expect(said).not.toContain(run);
      expect(said).toContain(`does not carry this issue's landing commit \`${UNSHIPPED}\``);
      expect(said).toContain(
        'It is back at Awaiting release. Release now on this page, or at the release gate on the issues list, starts a release.',
      );
      expect(await recordFor(id)).toBeNull();
    },
  );

  it('returns a row to Awaiting release where no probe is declared, saying nothing read production', async () => {
    await production({ probe: 'none' });
    const id = await plant();

    await settle();

    expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    expect((await bodies(id))[0]).toContain('declares no verify probe');
    expect(await recordFor(id)).toBeNull();
  });

  it('returns a row to Awaiting release where the probe is down, saying it could not be read', async () => {
    await production({ probe: 'down' });
    const id = await plant();

    await settle();

    expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    const [said] = await bodies(id);
    expect(said).toContain(
      'What production serves could not be read, so the sweep did not close it.',
    );
    expect(said).toContain('\n\n> the probe of the live deployment reports it down');
    expect(said).not.toContain('answered down');
    expect(await recordFor(id)).toBeNull();
  });

  it('returns a row with no landing commit, saying nothing can tell whether it shipped', async () => {
    await production();
    const id = await plant({ landing: null });

    await settle();

    expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    expect((await bodies(id))[0]).toContain('carries no landing commit');
  });

  it('leaves a row at Awaiting release, saying so, where the release record is refused', async () => {
    await production();
    const id = await plant({ note: null });

    expect(await settle()).toEqual({ settled: 1, closed: 0, failed: 0 });

    expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    const said = await bodies(id);
    expect(said[0]).toContain('A release record closes it now.');
    expect(said.at(-1)).toContain('The release record that would close this issue was refused');
    expect(said.at(-1)).toContain('It stays at Awaiting release');
  });
});

describe('what the sweep holds to (criteria 18, 19, 20, 21)', () => {
  it('returns a row even where Awaiting release declares an entry record the row never earned', async () => {
    await production({ probe: 'none' });
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify({
        pipelineConfig: { statusEntryCriteria: { awaiting_release: ['plan'] } },
      })}::jsonb WHERE id = ${projectId}
    `);
    const id = await plant();

    expect(await settle()).toEqual({ settled: 1, closed: 0, failed: 0 });
    expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
  });

  it.each(['running', 'paused'])(
    'leaves a row its %s run carries exactly as it was',
    async (runStatus) => {
      await production();
      const run = await plantRun(runStatus);
      const id = await plant({ claim: run });

      expect(await settle()).toEqual({ settled: 0, closed: 0, failed: 0 });

      expect(await fx.stored(id)).toMatchObject({ status: 'releasing', claim: run });
      expect(await bodies(id)).toEqual([]);
    },
  );

  it('settles the rows of every project in one pass', async () => {
    await production({ probe: 'none' });
    const first = await plant();
    const other = await createTestProject(harness.db, ownerId);
    const second = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
      VALUES (${second}, ${other.id}, 1, 'the other project''s', 'releasing', ${ownerId}, now())
    `);

    expect(await settle()).toEqual({ settled: 2, closed: 0, failed: 0 });
    expect((await fx.stored(first)).status).toBe('awaiting_release');
    expect((await fx.stored(second)).status).toBe('awaiting_release');
  });

  it('records every move it makes, the record close included, under a named actor', async () => {
    await production();
    const id = await plant();

    await settle();
    await drainOutboxOnce();

    const moves = await harness.db.execute<{
      from_status: string;
      to_status: string;
      actor_type: string;
      actor_id: string;
      actor_agency: string;
    }>(sql`
      SELECT from_status, to_status, actor_type, actor_id, actor_agency FROM kernel_transitions
      WHERE entity = 'issue' AND entity_id = ${id} ORDER BY created_at
    `);
    expect(moves).toEqual([
      {
        from_status: 'releasing',
        to_status: 'awaiting_release',
        actor_type: 'user',
        actor_id: FORGE_AUTHOR_ID,
        actor_agency: 'agent',
      },
      {
        from_status: 'awaiting_release',
        to_status: 'closed',
        actor_type: 'user',
        actor_id: FORGE_AUTHOR_ID,
        actor_agency: 'agent',
      },
    ]);
    const activity = await harness.db.execute<{
      actor_type: string;
      actor_id: string;
      to: string;
    }>(sql`
      SELECT actor_type, actor_id, payload ->> 'to' AS to FROM activity_log
      WHERE issue_id = ${id} AND action = 'issue.statusChanged' ORDER BY created_at
    `);
    expect(activity).toEqual([
      { actor_type: 'user', actor_id: FORGE_AUTHOR_ID, to: 'awaiting_release' },
      { actor_type: 'user', actor_id: FORGE_AUTHOR_ID, to: 'closed' },
    ]);
  });
});

describe('what the sweep writes on an issue, and as whom (ISS-1421 round 2)', () => {
  it.each([
    ['closed, production carrying it', {}],
    ['returned, production lacking it', { landing: UNSHIPPED }],
    ['left at the gate, its record refused', { note: null }],
  ] as const)(
    'writes as Forge, in words naming no route and no id, where it is %s',
    async (_, opts) => {
      await production();
      const id = await plant(opts);

      await settle();

      const said = await harness.db.execute<{
        body: string;
        author_id: string;
        kind: string;
        display_name: string | null;
      }>(sql`
      SELECT c.body, c.author_id, u.kind, u.display_name FROM comments c
      JOIN users u ON u.id = c.author_id WHERE c.issue_id = ${id} ORDER BY c.created_at, c.id
    `);
      expect(said.length).toBeGreaterThan(0);
      for (const row of said) {
        expect(row).toMatchObject({
          author_id: FORGE_AUTHOR_ID,
          kind: 'agent',
          display_name: 'Forge',
        });
        expect(row.body).not.toMatch(
          /\/api\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
        );
      }
    },
  );
});

describe('a claim the stale-claims reaper meets at Releasing (criterion 14)', () => {
  // Cleared first, the claim was the only record of which run left the row there, and the sweep
  // then told the issue no release run had ever claimed it.
  it('is left for the sweep, which says the run that claimed it ended', async () => {
    await production();
    const run = await plantRun('failed');
    const id = await plant({ claim: run, landing: UNSHIPPED });
    const { reapStaleReleaseBatchClaims } = await import(
      '../../src/pipeline/stale-release-claims.js'
    );

    expect(await reapStaleReleaseBatchClaims()).toEqual({ released: 0 });
    expect(await fx.stored(id)).toMatchObject({ status: 'releasing', claim: run });

    expect(await settle()).toEqual({ settled: 1, closed: 0, failed: 0 });
    const [said] = await bodies(id);
    expect(said).toContain(`${releaseRunStopped('failed')}, so nothing was releasing it`);
  });
});

describe('a landing marked while the sweep judges it (criterion 15)', () => {
  async function settleWith(production: ProductionReading['forLanding']) {
    const { settleStrandedReleasing } = await import('../../src/release-batch/releasing-settle.js');
    return settleStrandedReleasing({ production: async () => ({ forLanding: production }) });
  }

  async function closes(id: string): Promise<number> {
    const rows = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM kernel_transitions
      WHERE entity = 'issue' AND entity_id = ${id} AND to_status = 'closed'
    `);
    return Number(rows[0]?.n ?? 0);
  }

  it('leaves the row untouched where its landing moves while production is read, and judges the new one next pass', async () => {
    await production();
    const id = await plant();
    const { readProductionFinding } = await import(
      '../../src/release-batch/releasing-settle-reading.js'
    );

    const result = await settleWith(async (landing) => {
      await harness.db.execute(
        sql`UPDATE issues SET merged_commit_sha = ${UNSHIPPED} WHERE id = ${id}`,
      );
      return (await readProductionFinding(projectId)).forLanding(landing);
    });

    expect(result).toEqual({ settled: 0, closed: 0, failed: 0 });
    expect(await fx.stored(id)).toMatchObject({ status: 'releasing', claim: null });
    expect(await bodies(id)).toEqual([]);

    expect(await settle()).toEqual({ settled: 1, closed: 0, failed: 0 });
    expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release' });
    expect(await closes(id)).toBe(0);
  });

  it('refuses the close where the landing at close is not the one production was judged to carry', async () => {
    await production();
    const id = await plant();
    const judged = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';

    const result = await settleWith(async () => ({
      kind: 'carried',
      serving: SERVING,
      servingWhole: SERVING,
      landing: judged,
    }));

    expect(result).toEqual({ settled: 1, closed: 0, failed: 0 });
    expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    expect(await closes(id)).toBe(0);
    const said = await bodies(id);
    expect(said.at(-1)).toContain(
      `The release record that would close this issue was refused. It stays at Awaiting release.`,
    );
    expect(said.at(-1)).toContain(
      `\n\n> its landing commit is now ${SHIPPED}, not ${judged}, which production was read as carrying`,
    );
  });
});

describe('a promoted roster an abort left at Releasing (criterion 22)', () => {
  it('is settled by the sweep once its run is cancelled: closed where production carries it', async () => {
    await production();
    await fx.seedReleaseRunner();
    // A batch reads the range its promotion would carry; the start branch adds nothing to it.
    repo.heads.set('main', MAIN_HEAD);
    repo.compare.set(`production...${MAIN_HEAD}`, { status: 'ahead', commits: [] });
    const carried = await fx.insertIssue();
    const lacking = await fx.insertIssue();
    await harness.db.execute(
      sql`UPDATE issues SET merged_commit_sha = ${SHIPPED} WHERE id = ${carried}`,
    );
    await harness.db.execute(
      sql`UPDATE issues SET merged_commit_sha = ${UNSHIPPED} WHERE id = ${lacking}`,
    );
    const { runId } = await fx.claim([carried, lacking], { deploy: false, look: false });
    const { openAttempt } = await import('../../src/release-batch/ledger.js');
    await openAttempt({ runId, stage: 'promote', idempotencyKey: 'promote-1', commit: SERVING });
    const { abortReleaseBatch } = await import('../../src/release-batch/service.js');
    await abortReleaseBatch(runId, 'the box went away mid-promotion', ownerId);
    expect(await fx.stored(carried)).toMatchObject({ status: 'releasing', claim: runId });
    expect(await fx.runStatus(runId)).toBe('cancelled');
    fx.serve(SERVING);

    expect(await settle()).toEqual({ settled: 2, closed: 1, failed: 0 });

    expect(await fx.stored(carried)).toMatchObject({ status: 'closed', claim: null });
    expect(await fx.stored(lacking)).toMatchObject({ status: 'awaiting_release', claim: null });
    const said = await bodies(lacking);
    expect(said.at(-1)).toContain(
      'The release run was cancelled without finishing its release, so nothing was releasing it',
    );
    for (const body of [...said, ...(await bodies(carried))]) {
      expect(body).not.toMatch(/for a person to settle|settling it is an operator's act/);
      expect(body).not.toMatch(
        /\/api\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      );
    }
  });
});
