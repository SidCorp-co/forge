// The seeding a release-batch case needs before it can assert anything.
//
// Extracted from `release-batch-finish-e2e.test.ts` when the recovery cases
// pushed that file's outer `describe` past its line budget. Two suites read
// the same batch surface, and a second hand-typed copy of this seeding is how
// one of them ends up proving its own SQL instead of the batch's.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, vi } from 'vitest';
import type { CreateReleaseBatchResult } from '../../src/release-batch/service.js';
import { createTestDevice, seedProjectDocument, type TestDatabase } from './index.js';

export const RELEASE_LABEL = 'release-box';
export const SKIP_NOTE = { section: 'Skip', userFacing: '-' };

/** Where a batch holds a claimed row (ISS-54): at the gate, at step `release`, where the
 *  seventeen-status model had `releasing`. */
export const AT_RELEASE = { status: 'awaiting_release', step: 'release' } as const;

export interface StoredIssue {
  status: string;
  /** `issue_work_state.step` (ISS-54): `release` while a batch holds the row at the gate. */
  step: string | null;
  mergedAt: unknown;
  claim: unknown;
}

export interface StoredJob {
  status: string;
  exitCode: number | null;
}

/** What production's `verification.runtime` declares: a source probe, nothing, or only an
 *  artifact probe, which no release can be proved by. */
export type DeclaredProbes = 'source' | 'none' | 'artifact-only';

/** The probe production declares, answered by the fixture's own `fetch` stub. */
export const PROBE_URL = 'https://release-fixture.example.test/version';

export interface ReleaseBatchFixture {
  /** Production `live` deploys from `production`, which `main` reaches by merge, through a coolify
   *  binding carrying `config`; the binding id is what it answers. */
  declareProduction(config?: Record<string, unknown>, probes?: DeclaredProbes): Promise<string>;
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
  seedReleaseRunner(): Promise<void>;
  /** `merged` defaults to true: a roster issue is work that LANDED, which ISS-1108 made the
   *  precondition of the close, so a fixture leaving the claim off is asking for the refusal. */
  insertIssue(status?: string, note?: unknown, merged?: boolean): Promise<string>;
  stored(id: string): Promise<StoredIssue>;
  runStatus(runId: string): Promise<string>;
  storedJob(jobId: string): Promise<StoredJob>;
  commentCount(issueId: string): Promise<number>;
  /** `ISS-nn` for each id, in the order given. */
  displayIds(ids: string[]): Promise<string[]>;
  /** A waiting row merged at `mergedAt` whose two criteria passed at `commit`, written the way the
   *  forge-plugin writes a `commit:` verdict. */
  judgedRow(commit: string, mergedAt: string): Promise<string>;
  /** The `releaseHold` a sweep left on the row, or null. */
  holdOf(issueId: string): Promise<Record<string, unknown> | null>;
  /** How many hold comments the row carries. */
  holdComments(issueId: string): Promise<number>;
  /**
   * Whatever `createReleaseBatch` returns, named by its own type rather than copied. The copy
   * this replaced went stale the moment ISS-1120 put `version` on the result.
   */
  claim(ids: string[], opts?: { deploy?: boolean }): Promise<CreateReleaseBatchResult>;
  waitFor(cond: () => Promise<boolean>): Promise<void>;
}

export function releaseBatchFixture(
  harness: () => TestDatabase,
  ids: () => { projectId: string; ownerId: string },
): ReleaseBatchFixture {
  let seq = 0;

  let served = 'commit-before-any-release';
  let stubbed = false;

  function answerTheProbe(): void {
    if (stubbed) return;
    stubbed = true;
    const passThrough = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: URL | string | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.split('?')[0] === PROBE_URL) return Response.json({ commit: served });
      return passThrough(input, init);
    });
  }

  afterAll(() => {
    if (stubbed) vi.unstubAllGlobals();
    stubbed = false;
  });

  const PROBES: Record<DeclaredProbes, object | undefined> = {
    source: { runtime: [{ type: 'http', url: PROBE_URL, path: 'commit', identifies: 'source' }] },
    none: undefined,
    'artifact-only': {
      runtime: [{ type: 'http', url: PROBE_URL, path: 'commit', identifies: 'artifact' }],
    },
  };

  async function declareProduction(
    config: Record<string, unknown> = {},
    probes: DeclaredProbes = 'source',
  ): Promise<string> {
    const { projectId, ownerId } = ids();
    const connectionId = randomUUID();
    const bindingId = randomUUID();
    await harness().db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connectionId}, 'user', ${ownerId}, 'coolify', true)
    `);
    await harness().db.execute(sql`
      INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
      VALUES (
        ${bindingId}, ${connectionId}, ${projectId}, 'coolify', 'deploy', true,
        ${JSON.stringify({ releaseRunnerLabel: RELEASE_LABEL, ...config })}::jsonb
      )
    `);
    const verification = PROBES[probes];
    const [held] = await harness().db.execute<{ type: string | null }>(sql`
      SELECT document #>> '{source,type}' AS type FROM project_config_documents
      WHERE project_id = ${projectId}
    `);
    const storefront = held?.type === 'storefront';
    await seedProjectDocument(harness().db, projectId, ownerId, {
      ...(storefront ? { sourceType: 'storefront' as const } : {}),
      defaultBranch: 'main',
      promotions: storefront ? [] : [{ from: 'main', to: 'production', via: 'merge' }],
      environments: {
        live: {
          tier: 'production',
          deploysFrom: 'production',
          deployment: { binding: bindingId, trigger: 'on-request' },
          ...(verification ? { verification } : {}),
        },
      },
    } as Parameters<typeof seedProjectDocument>[3]);
    if (probes !== 'none') answerTheProbe();
    return bindingId;
  }

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
      SELECT i.status, i.merged_at, i.release_batch_run_id, w.step
      FROM issues i LEFT JOIN issue_work_state w ON w.issue_id = i.id WHERE i.id = ${id}
    `);
    return {
      status: String(rows[0]?.status),
      step: (rows[0]?.step as string | null | undefined) ?? null,
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

  async function claim(idList: string[], opts: { deploy?: boolean } = {}) {
    const { projectId, ownerId } = ids();
    const { createReleaseBatch } = await import('../../src/release-batch/service.js');
    const result = await createReleaseBatch({ projectId, issueIds: idList, userId: ownerId });
    if (opts.deploy !== false) served = `commit-pushed-by-run-${result.runId}`;
    await announceMethodFor(result.runId);
    return result;
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

  /** `ISS-nn` for each, in the order given, as the tracker names them. */
  async function displayIds(idList: string[]): Promise<string[]> {
    const { issueDisplayIds } = await import('../../src/issues/display-ids.js');
    const shown = await issueDisplayIds(idList);
    return idList.map((id) => String(shown.get(id)));
  }

  async function judgedRow(commit: string, mergedAt: string): Promise<string> {
    const { ownerId } = ids();
    const id = await insertIssue();
    await harness().db.execute(sql`
      UPDATE issues SET acceptance_criteria = ${'1. ok\n2. ok'}, merged_at = ${mergedAt}::timestamptz,
                        merged_commit_sha = ${commit}
       WHERE id = ${id}
    `);
    const block = (n: number) =>
      [`criterion: ${n} — ok`, 'verdict: pass', `commit: ${commit}`, 'evidence: judge.txt'].join(
        '\n',
      );
    const body = [
      '## Verdict',
      '',
      '```forge-record',
      block(1),
      block(2),
      '```',
      '',
      '`forge-record: verdict · contract 1`',
    ].join('\n');
    await harness().db.execute(sql`
      INSERT INTO comments (id, issue_id, author_id, body)
      VALUES (${randomUUID()}, ${id}, ${ownerId}, ${body})
    `);
    await harness().db.execute(sql`
      INSERT INTO issue_attachments (id, issue_id, uploader_id, name, path, mime, size)
      VALUES (${randomUUID()}, ${id}, ${ownerId}, 'judge.txt', ${`uploads/${id}`}, 'text/plain', 8)
    `);
    return id;
  }

  async function holdOf(issueId: string): Promise<Record<string, unknown> | null> {
    const rows = (await harness().db.execute(sql`
      SELECT session_context -> 'releaseHold' AS hold FROM issues WHERE id = ${issueId}
    `)) as unknown as Array<{ hold: Record<string, unknown> | null }>;
    return rows[0]?.hold ?? null;
  }

  async function holdComments(issueId: string): Promise<number> {
    const rows = (await harness().db.execute(sql`
      SELECT count(*)::int AS n FROM comments
       WHERE issue_id = ${issueId} AND body LIKE '%release-hold: %'
    `)) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
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
    insertIssue,
    stored,
    runStatus,
    storedJob,
    commentCount,
    displayIds,
    judgedRow,
    holdOf,
    holdComments,
    claim,
    waitFor,
  };
}
