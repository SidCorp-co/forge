// The seeding a release-batch case needs before it can assert anything.
//
// Extracted from `release-batch-finish-e2e.test.ts` when the recovery cases
// pushed that file's outer `describe` past its line budget. Two suites read
// the same batch surface, and a second hand-typed copy of this seeding is how
// one of them ends up proving its own SQL instead of the batch's.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll } from 'vitest';
import { createTestDevice, type TestDatabase } from './index.js';

export const RELEASE_LABEL = 'release-box';
export const SKIP_NOTE = { section: 'Skip', userFacing: '-' };

export interface StoredIssue {
  status: string;
  mergedAt: unknown;
  claim: unknown;
}

export interface StoredJob {
  status: string;
  exitCode: number | null;
}

export interface ReleaseBatchFixture {
  declareProduction(config?: Record<string, unknown>): Promise<void>;
  /** What the default probe server is serving right now. */
  serving(): string;
  /** Announce the method a run loaded, as an agent would. */
  announceMethod(runId: string, over?: { skill?: string; loaded?: boolean }): Promise<void>;
  seedReleaseRunner(): Promise<void>;
  insertIssue(status?: string, note?: unknown): Promise<string>;
  stored(id: string): Promise<StoredIssue>;
  runStatus(runId: string): Promise<string>;
  storedJob(jobId: string): Promise<StoredJob>;
  commentCount(issueId: string): Promise<number>;
  claim(ids: string[]): Promise<{ runId: string; jobId: string; issueIds: string[] }>;
  waitFor(cond: () => Promise<boolean>): Promise<void>;
}

export function releaseBatchFixture(
  harness: () => TestDatabase,
  ids: () => { projectId: string; ownerId: string },
): ReleaseBatchFixture {
  let seq = 0;

  // cm:guard every case that CLAIMS now needs declared probes, because `createReleaseBatch` and
  // `finishReleaseBatch` both refuse a production project without them (ISS-1042). One real server
  // over a mocked `fetch`: the probe path is `fetch` plus a cache-buster plus `pluck`, and a mock
  // asserts the call rather than the read. A case wanting a project with NO probes passes
  // `{ verify: null }`, and one wanting its own passes `verify` — both override this default.
  let probe: Server | null = null;
  let served = 'commit-before-any-release';

  async function probeUrl(): Promise<string> {
    if (!probe) {
      const server = createServer((_req, res) => res.end(served));
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      probe = server;
    }
    return `http://127.0.0.1:${(probe.address() as AddressInfo).port}/version`;
  }

  afterAll(async () => {
    if (probe) await new Promise<void>((done) => probe?.close(() => done()));
    probe = null;
  });

  // cm:edge contract -> packages/core/src/release-batch/gate.ts — `resolveProductionDeclaration` reads exactly a production branch distinct from the base plus an active `prod` binding; seed one half and every case dies on NO_RELEASE_GATE before reaching what it asserts
  async function declareProduction(config: Record<string, unknown> = {}): Promise<void> {
    const { projectId, ownerId } = ids();
    const connectionId = randomUUID();
    // cm:why `stableReads: 1` so one read confirms. The default is two, five seconds apart, and no
    // case here is about the poll loop's patience.
    const verify = { probes: [{ url: await probeUrl() }], timeoutSeconds: 20, stableReads: 1 };
    await harness().db.execute(sql`
      UPDATE projects
         SET base_branch = 'main',
             live_branch = 'production',
             release_model = 'promote',
             release_strategy = 'merge-branch'
       WHERE id = ${projectId}
    `);
    await harness().db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connectionId}, 'user', ${ownerId}, 'coolify', true)
    `);
    await harness().db.execute(sql`
      INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
      VALUES (
        ${connectionId}, ${projectId}, 'coolify', 'deploy', ARRAY['live']::text[], true,
        ${JSON.stringify({ releaseRunnerLabel: RELEASE_LABEL, verify, ...config })}::jsonb
      )
    `);
  }

  // cm:guard the box must carry the LABEL and be claim-capable, which are two different gates: `resolveReleaseDeviceIds` matches on `runners.labels`, and `onlineCapableDeviceIds` then asks whether anyone in that set is alive and above the version floor. Seed the label without the liveness and the batch refuses NO_RUNNER_ONLINE, which reads nothing like the pool being empty.
  async function seedReleaseRunner(): Promise<void> {
    const { projectId, ownerId } = ids();
    const device = await createTestDevice(harness().db, ownerId, { status: 'online' });
    await harness().db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (
        ${randomUUID()}, ${projectId}, 'claude-code', ${device.id}, 'release-runner',
        'online', now(), ${JSON.stringify([RELEASE_LABEL])}::jsonb
      )
    `);
  }

  async function insertIssue(
    status = 'awaiting_release',
    note: unknown = SKIP_NOTE,
  ): Promise<string> {
    const { projectId, ownerId } = ids();
    const id = randomUUID();
    seq += 1;
    await harness().db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
      VALUES (
        ${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId},
        ${note === null ? null : JSON.stringify(note)}::jsonb
      )
    `);
    return id;
  }

  async function stored(id: string): Promise<StoredIssue> {
    const rows = await harness().db.execute(sql`
      SELECT status, merged_at, release_batch_run_id FROM issues WHERE id = ${id}
    `);
    return {
      status: String(rows[0]?.status),
      mergedAt: rows[0]?.merged_at ?? null,
      claim: rows[0]?.release_batch_run_id ?? null,
    };
  }

  async function runStatus(runId: string): Promise<string> {
    const rows = await harness().db.execute(sql`
      SELECT status FROM pipeline_runs WHERE id = ${runId}
    `);
    return String(rows[0]?.status);
  }

  // cm:guard reads `exit_code` alongside `status`, because the two together are
  // what separate the cascade's success sentinel from its cancel: a
  // `pipeline_completed` close flips an active child job to `done` with
  // `exitCode` 0, every other close cancels it.
  async function storedJob(jobId: string): Promise<StoredJob> {
    const rows = await harness().db.execute(sql`
      SELECT status, exit_code FROM jobs WHERE id = ${jobId}
    `);
    const exit = rows[0]?.exit_code;
    return { status: String(rows[0]?.status), exitCode: exit == null ? null : Number(exit) };
  }

  async function commentCount(issueId: string): Promise<number> {
    const rows = await harness().db.execute(sql`
      SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issueId}
    `);
    return Number(rows[0]?.n ?? 0);
  }

  // cm:guard go through `createReleaseBatch` and never write `release_batch_run_id` by hand — the claim is a CAS UPDATE inside that function, and a fixture that re-issues it proves its own SQL rather than the batch's
  async function claim(idList: string[]) {
    const { projectId, ownerId } = ids();
    const { createReleaseBatch } = await import('../../src/release-batch/service.js');
    const result = await createReleaseBatch({ projectId, issueIds: idList, userId: ownerId });
    // cm:guard the served commit MOVES here and nowhere else. `createReleaseBatch` records what was
    // live before anything moved, and `verifyDeployed` refuses a live commit equal to it — so a
    // server answering one constant makes every finish in every suite fail verification for the
    // right reason and the wrong case. This is the release actually happening.
    served = `commit-pushed-by-run-${result.runId}`;
    await announceMethodFor(result.runId);
    return result;
  }

  // cm:guard `claim()` announces the method because a REAL run does: the batch prompt tells the
  // agent to load its skill and post it, and `finishReleaseBatch` refuses a run that never did
  // (ISS-1042 criterion 26). A fixture that skipped it would leave every finish case in every suite
  // asserting the method refusal instead of what it is about.
  async function announceMethodFor(
    runId: string,
    over: { skill?: string; loaded?: boolean } = {},
  ): Promise<void> {
    const [{ announceMethod }, { RELEASE_BATCH_SKILL }] = await Promise.all([
      import('../../src/release-batch/method.js'),
      import('../../src/release-batch/plan.js'),
    ]);
    await announceMethod({
      runId,
      skill: over.skill ?? RELEASE_BATCH_SKILL,
      loaded: over.loaded ?? true,
    });
  }

  // cm:why the claim subscriber is fire-and-forget by design (it must not hold up a run close), so an assertion has to wait for the write rather than assume it landed
  async function waitFor(cond: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('waitFor: condition never became true');
  }

  return {
    declareProduction,
    serving: () => served,
    announceMethod: announceMethodFor,
    seedReleaseRunner,
    insertIssue,
    stored,
    runStatus,
    storedJob,
    commentCount,
    claim,
    waitFor,
  };
}
