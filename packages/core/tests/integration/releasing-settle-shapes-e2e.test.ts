/**
 * ISS-1421 round 2 — what the releasing sweep tells the reader of an issue it returns names only a
 * door that project has.
 *
 * Judge-28 read the sweep's comment telling a project with no release gate to press Release now, and
 * a website project to name a commit. One row is planted per project shape (a release gate, ships
 * nothing, a release with no live target) and per landing lane (git, outside git), one pass is run,
 * and the comment is read back. Same harness as releasing-settle-e2e: real Postgres, a live probe
 * server and a GitHub double.
 */

import { markMergedSteps } from '@forge/contracts/mark-merged-words';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProductionReading } from '../../src/release-batch/releasing-settle-reading.js';
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
/** A landing commit SERVING does not carry. */
const UNSHIPPED = '9f8e7d6c5b4a39281706f5e4d3c2b1a098f7e6d5';

let harness: TestDatabase;
let repo: GitHubDouble;
let projectId: string;
let ownerId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  repo = await startGitHubDouble();
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

async function plant(
  opts: { claim?: string | null; landing?: string | null; note?: unknown; merged?: boolean } = {},
) {
  const id = await fx.insertIssue(
    'releasing',
    opts.note === undefined ? undefined : opts.note,
    opts.merged ?? true,
  );
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

describe("the sweep's next step names only a door the project has (criteria 27-30, 39)", () => {
  const GATE_DOORS = /Release now|release gate/;

  it('on a project with a release gate, says a release starts from Release now or the release gate', async () => {
    await production();
    const id = await plant({ landing: UNSHIPPED });

    await settle();

    expect((await bodies(id))[0]).toContain(
      'Release now on this page, or at the release gate on the issues list, starts a release.',
    );
  });

  it('on a project with a release gate, tells an issue not marked merged to mark it, not to press Release now', async () => {
    await production();
    const id = await plant({ landing: null, merged: false });

    expect(await settle()).toEqual({ settled: 1, closed: 0, failed: 0 });

    expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    const [said] = await bodies(id);
    expect(said).toContain('It is back at Awaiting release.');
    expect(said).toContain('A release cannot close this issue yet. It is not marked merged.');
    expect(said).toContain(markMergedSteps(false));
    expect(said).toContain('Release now appears on its page once that is done.');
    expect(said).not.toContain('starts a release');
    expect(said?.match(/Mark merged|Mark it merged/g)).toHaveLength(1);
  });

  it('on a project that ships nothing, offers a releasing shape or Reopen and reads no production', async () => {
    await production();
    await harness.db.execute(
      sql`UPDATE projects SET release_chain = '[]'::jsonb WHERE id = ${projectId}`,
    );
    const id = await plant();
    const read: string[] = [];
    const { settleStrandedReleasing } = await import('../../src/release-batch/releasing-settle.js');
    const noRead = async (project: string): Promise<ProductionReading> => {
      read.push(project);
      throw new Error('a project that ships nothing has no production to read');
    };

    expect(await settleStrandedReleasing({ production: noRead })).toEqual({
      settled: 1,
      closed: 0,
      failed: 0,
    });
    expect(read).toEqual([]);

    expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    const [said] = await bodies(id);
    expect(said).toContain('This project releases nothing, so no release will carry it');
    expect(said).toContain('choose a shape that releases under Shape & release');
    expect(said).toContain('If work remains, reopen it instead.');
    expect(said).not.toMatch(GATE_DOORS);
    expect(said).not.toMatch(/Production's|production serves|verify probe|landing commit/);
    expect(await recordFor(id)).toBeNull();
  });

  it('on a project with no live deploy target, says none can start until one is added', async () => {
    await harness.db.execute(sql`
      UPDATE projects SET base_branch = 'main', release_chain = '[{"branch": "main"}]'::jsonb
      WHERE id = ${projectId}
    `);
    const id = await plant();
    expect(await settle()).toEqual({ settled: 1, closed: 0, failed: 0 });
    expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    const [said] = await bodies(id);
    expect(said).toContain(
      "This project declares a release but has no live deploy target. No release can start until one is added in the project's Settings, on the Integrations tab. There, share a connection as Deploy target, with Live ticked.",
    );
    // ISS-1421 r4: and it carries the address that opens that place (judge-32).
    expect(said).toMatch(
      /It opens at https?:\/\/[^ ]+\/projects\/[^/ ]+\/settings\?tab=integrations&add=live-deploy-target\./,
    );
    expect(said).not.toMatch(GATE_DOORS);
  });

  it.each([
    ['a website project', 'kind'],
    ['an issue declaring its work lands outside git', 'declared'],
  ] as const)('on %s, asks for no commit', async (_, how) => {
    await production();
    if (how === 'kind') {
      await harness.db.execute(sql`UPDATE projects SET kind = 'website' WHERE id = ${projectId}`);
    }
    const id = await plant({ landing: null });
    await harness.db.execute(sql`
      UPDATE issues SET merged_landing = 'https://shop.example/products/42',
             declared_landing_shape = ${how === 'declared' ? 'outside_git' : null}
      WHERE id = ${id}
    `);

    expect(await settle()).toEqual({ settled: 1, closed: 0, failed: 0 });

    const [said] = await bodies(id);
    expect(said).toContain("This issue's work lands outside git");
    expect(said).not.toMatch(/commit it landed at|Mark it merged/);
    expect(said).toContain('Release now on this page');
  });
});
