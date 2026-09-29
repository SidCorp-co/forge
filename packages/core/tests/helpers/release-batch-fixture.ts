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
import { afterAll, expect } from 'vitest';
import type { CreateReleaseBatchResult } from '../../src/release-batch/service.js';
import { createTestDevice, type TestDatabase } from './index.js';

export const RELEASE_LABEL = 'release-box';
export const SKIP_NOTE = { section: 'Skip', userFacing: '-' };

export interface StoredIssue {
  status: string;
  mergedAt: unknown;
  claim: unknown;
}

export interface ReleaseBoxOver {
  /** Defaults to the release label, so the binding's preference is met. */
  labels?: string[];
  /** Defaults to true. */
  master?: boolean;
  /** Defaults to shipping the role with an open admission. */
  capabilities?: Record<string, unknown> | null;
  runnerStatus?: 'online' | 'offline';
  name?: string;
}

export const OPEN_RELEASE_BOX = { releaseRole: true, admission: { state: 'open' } };

/**
 * Make a box already bound to the project able to own its releases: the heartbeat fields a runner
 * sends (`capabilities`), and a live master session of the project on it. Suites that seed their
 * own runner call this beside it, so every one of them plants the same owner (ISS-1281).
 */
export async function makeReleaseOwner(
  db: TestDatabase['db'],
  args: {
    projectId: string;
    userId: string;
    deviceId: string;
    capabilities?: Record<string, unknown> | null;
    master?: boolean;
  },
): Promise<void> {
  const capabilities = args.capabilities === undefined ? OPEN_RELEASE_BOX : args.capabilities;
  await db.execute(sql`
    UPDATE devices SET capabilities = ${capabilities === null ? null : JSON.stringify(capabilities)}::jsonb
     WHERE id = ${args.deviceId}
  `);
  if (args.master === false) return;
  const masterRun = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${masterRun}, ${args.projectId}, 'system', 'running')
  `);
  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, user_id, device_id, kind,
                                status, last_heartbeat_at)
    VALUES (${randomUUID()}, ${args.projectId}, ${masterRun}, ${args.userId}, ${args.deviceId},
            'master', 'running', now())
  `);
}

export interface ReleaseBatchFixture {
  declareProduction(config?: Record<string, unknown>): Promise<void>;
  /** What the default probe server is serving right now. */
  serving(): string;
  /**
   * Say what the probe server answers. A batch opened onto a commit that is
   * ALREADY live is the shape ISS-1199 was found in, and `claim` moving the
   * value for you is what makes every other case a deploy the batch watched.
   */
  serve(commit: string): void;
  /** Announce the method a run loaded, as an agent would. */
  announceMethod(runId: string, over?: { skill?: string; loaded?: boolean }): Promise<void>;
  /**
   * A box that can own a release (ISS-1281): its runner live and labelled, a master of this
   * project running on it, and a heartbeat saying it ships the release role and is not draining.
   * `over` plants the one thing that stops it.
   */
  seedReleaseRunner(over?: ReleaseBoxOver): Promise<{ deviceId: string; deviceName: string }>;
  /** Open the run session a master would, over exactly the roster of `releaseRunId`. */
  take(
    releaseRunId: string,
    deviceId: string,
    issueIds?: string[],
  ): Promise<{ sessionId: string; runId: string }>;
  /** `merged` defaults to true: a roster issue is work that LANDED, which ISS-1108 made the
   *  precondition of the close, so a fixture leaving the claim off is asking for the refusal. */
  insertIssue(status?: string, note?: unknown, merged?: boolean): Promise<string>;
  stored(id: string): Promise<StoredIssue>;
  runStatus(runId: string): Promise<string>;
  commentCount(issueId: string): Promise<number>;
  /**
   * Whatever `createReleaseBatch` returns, named by its own type rather than copied. The copy
   * this replaced went stale the moment ISS-1120 put `version` on the result.
   */
  claim(ids: string[], opts?: { deploy?: boolean }): Promise<CreateReleaseBatchResult>;
  /**
   * A batch as one cut before ISS-1281 stands in the field: no owner record, and the queued
   * `release_batch` job that owned it, enqueued through `insertAndEnqueueJob` as such a batch was.
   */
  claimLegacy(ids: string[]): Promise<CreateReleaseBatchResult & { jobId: string }>;
  waitFor(cond: () => Promise<boolean>): Promise<void>;
}

export function releaseBatchFixture(
  harness: () => TestDatabase,
  ids: () => { projectId: string; ownerId: string },
): ReleaseBatchFixture {
  let seq = 0;

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

  async function declareProduction(config: Record<string, unknown> = {}): Promise<void> {
    const { projectId, ownerId } = ids();
    const connectionId = randomUUID();
    const verify = { probes: [{ url: await probeUrl() }], timeoutSeconds: 20, stableReads: 1 };
    await harness().db.execute(sql`
      UPDATE projects
         SET base_branch = 'main',
             release_chain = '[{"branch": "main"}, {"branch": "production", "from": "merge-branch"}]'::jsonb
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

  async function seedReleaseRunner(
    over: ReleaseBoxOver = {},
  ): Promise<{ deviceId: string; deviceName: string }> {
    const { projectId, ownerId } = ids();
    const device = await createTestDevice(harness().db, ownerId, {
      status: 'online',
      ...(over.name ? { name: over.name } : {}),
    });
    await harness().db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (
        ${randomUUID()}, ${projectId}, 'claude-code', ${device.id}, 'release-runner',
        ${over.runnerStatus ?? 'online'}, now(), ${JSON.stringify(over.labels ?? [RELEASE_LABEL])}::jsonb
      )
    `);
    await makeReleaseOwner(harness().db, {
      projectId,
      userId: ownerId,
      deviceId: device.id,
      capabilities: over.capabilities === undefined ? OPEN_RELEASE_BOX : over.capabilities,
      master: over.master !== false,
    });
    return { deviceId: device.id, deviceName: device.name };
  }

  async function take(
    releaseRunId: string,
    deviceId: string,
    issueIds?: string[],
  ): Promise<{ sessionId: string; runId: string }> {
    const { projectId } = ids();
    const rows = (await harness().db.execute(sql`
      SELECT iss_seq FROM issues
       WHERE ${
         issueIds
           ? sql`id IN (${sql.join(
               issueIds.map((i) => sql`${i}`),
               sql`, `,
             )})`
           : sql`release_batch_run_id = ${releaseRunId}`
}
       ORDER BY iss_seq
    `)) as unknown as Array<{ iss_seq: number }>;
    const { openRunSession } = await import('../../src/devices/run-session.js');
    return openRunSession({
      deviceId,
      projectId,
      issueKeys: rows.map((r) => `ISS-${r.iss_seq}`),
      name: 'release',
    });
  }

  async function insertIssue(
    status = 'awaiting_release',
    note: unknown = SKIP_NOTE,
    merged = true,
  ): Promise<string> {
    const { projectId, ownerId } = ids();
    const id = randomUUID();
    seq += 1;
    await harness().db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes,
                          merged_at)
      VALUES (
        ${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId},
        ${note === null ? null : JSON.stringify(note)}::jsonb,
        ${merged ? sql`now()` : null}
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

  async function commentCount(issueId: string): Promise<number> {
    const rows = await harness().db.execute(sql`
      SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issueId}
    `);
    return Number(rows[0]?.n ?? 0);
  }

  async function claim(idList: string[], opts: { deploy?: boolean } = {}) {
    const { projectId, ownerId } = ids();
    const { createReleaseBatch } = await import('../../src/release-batch/service.js');
    const result = await createReleaseBatch({ projectId, issueIds: idList, userId: ownerId });
    if (opts.deploy !== false) served = `commit-pushed-by-run-${result.runId}`;
    await announceMethodFor(result.runId);
    return result;
  }

  async function claimLegacy(idList: string[]) {
    const { projectId, ownerId } = ids();
    const result = await claim(idList);
    const rows = (await harness().db.execute(sql`
      UPDATE pipeline_runs SET metadata = metadata - 'owner' - 'brief'
       WHERE id = ${result.runId}
       RETURNING metadata
    `)) as unknown as Array<{ metadata: unknown }>;
    expect(rows).toHaveLength(1);
    const [{ insertAndEnqueueJob }, { RELEASE_BATCH_SKILL }] = await Promise.all([
      import('../../src/pipeline/enqueue-helper.js'),
      import('../../src/release-batch/plan.js'),
    ]);
    const { jobId } = await insertAndEnqueueJob({
      projectId,
      issueId: null,
      pipelineRunId: result.runId,
      createdBy: ownerId,
      type: 'release_batch',
      skillName: RELEASE_BATCH_SKILL,
      promptString: 'a release cut before ISS-1281',
      payloadExtras: {
        releaseBatch: true,
        gateStatus: result.gateStatus,
        issueIds: result.issueIds,
        timeoutSeconds: 3600,
      },
    });
    return { ...result, jobId };
  }

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
    serve: (commit: string) => {
      served = commit;
    },
    announceMethod: announceMethodFor,
    seedReleaseRunner,
    take,
    insertIssue,
    stored,
    runStatus,
    commentCount,
    claim,
    claimLegacy,
    waitFor,
  };
}
