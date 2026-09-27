/**
 * ISS-1190 — what an abort answers about a roster closed before it ran, whatever claims survived,
 * and why each issue a release could not claim was refused, against real Postgres through the
 * real worker, the abort and the record and batch doors.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const PUSHED = '2222222222222222222222222222222222222222';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let serving = '1111111111111111111111111111111111111111';
let probe: Server;
let probeUrl: string;
let job: typeof import('../../src/release-batch/finish-job.js');
let service: typeof import('../../src/release-batch/service.js');
let refusals: typeof import('../../src/release-batch/refusals.js');
let recorded: typeof import('../../src/release-batch/recorded.js');

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  probe = createServer((_req, res) => res.end(serving));
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/version`;
  job = await import('../../src/release-batch/finish-job.js');
  service = await import('../../src/release-batch/service.js');
  refusals = await import('../../src/release-batch/refusals.js');
  recorded = await import('../../src/release-batch/recorded.js');
}, 120_000);

afterAll(async () => {
  probe.closeAllConnections();
  await new Promise<void>((done) => probe.close(() => done()));
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  serving = '1111111111111111111111111111111111111111';
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await fx.declareProduction();
  await fx.seedReleaseRunner();
  await harness.db.execute(sql`
    UPDATE integration_bindings
    SET config = config || ${JSON.stringify({
      verify: { probes: [{ url: probeUrl }], timeoutSeconds: 12, stableReads: 1 },
    })}::jsonb
    WHERE project_id = ${projectId} AND provider = 'coolify'
  `);
});

async function batchOf(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) ids.push(await fx.insertIssue());
  const { runId } = await fx.claim(ids);
  return { runId, ids };
}

async function accept(runId: string) {
  const actor = { type: 'user' as const, id: ownerId };
  return job.acceptReleaseBatchFinish(runId, actor, { commit: PUSHED }, async () => {});
}

async function abort(runId: string, options: Parameters<typeof service.abortReleaseBatch>[3] = {}) {
  return service.abortReleaseBatch(runId, 'a person stopped it', ownerId, options);
}

async function promoted(runId: string): Promise<void> {
  const { openAttempt } = await import('../../src/release-batch/ledger.js');
  await openAttempt({ runId, stage: 'promote', idempotencyKey: 'promote-1', commit: PUSHED });
}

async function keyOf(issueId: string): Promise<string> {
  const rows = await harness.db.execute(sql`
    SELECT coalesce(p.issue_prefix, 'ISS') || '-' || i.iss_seq AS key
    FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.id = ${issueId}
  `);
  return String(rows[0]?.key);
}

/** A key as a whole word, so ISS-1 is not found inside ISS-12. */
const named = (key: string) => new RegExp(`\\b${key}\\b`);

interface Refusal {
  code: string;
  message: string;
  details: { conflicts?: Array<Record<string, unknown>> } & Record<string, unknown>;
}

function asRefusal(http: { message: string; cause?: unknown }): Refusal {
  const cause = http.cause as { code: string; details?: Refusal['details'] };
  return { code: cause.code, message: http.message, details: cause.details ?? {} };
}

/** What `POST /release-records` answers for these issues, as its route maps the throw. */
async function recordRefused(issueIds: string[]): Promise<Refusal> {
  try {
    await recorded.recordPerformedRelease({
      projectId,
      userId: ownerId,
      issueIds,
      commit: serving,
      account: 'Promoted by hand; production serves this commit.',
    });
  } catch (err) {
    return asRefusal(refusals.recordRefusal(err));
  }
  throw new Error('the record was not refused');
}

describe('the abort’s own account of a roster closed before it ran', () => {
  /** A batch with no promotion that finished green: every issue closed, every claim released. */
  async function finishedBatch(n: number) {
    const { runId, ids } = await batchOf(n);
    serving = PUSHED;
    await accept(runId);
    await job.runReleaseBatchFinish(runId);
    for (const id of ids) {
      expect(await fx.stored(id)).toMatchObject({ status: 'closed', claim: null });
    }
    expect(await fx.runStatus(runId)).toBe('completed');
    return { runId, ids };
  }

  it('names every closed issue although no claim was left to read them by', async () => {
    const { runId, ids } = await finishedBatch(3);
    const aborted = await abort(runId);
    expect(aborted.promoted).toBe(false);
    expect(aborted.claimsCleared).toEqual([]);
    expect(aborted.recovered).toEqual([]);
    expect(aborted.alreadyClosed).toEqual([...ids].sort());
  }, 40_000);

  it('does not answer an issue a person reopened after the batch closed it', async () => {
    const { runId, ids } = await finishedBatch(2);
    const [reopened, stillClosed] = ids as [string, string];
    await harness.db.execute(sql`UPDATE issues SET status = 'reopen' WHERE id = ${reopened}`);
    const aborted = await abort(runId);
    expect(aborted.alreadyClosed).toEqual([stillClosed]);
  }, 40_000);
});

describe('CLAIM_CONFLICT names what refused each issue, and what frees it', () => {
  it('names a held roster by key with a return-to-gate abort on the batch that ended', async () => {
    const { runId, ids } = await batchOf(2);
    await promoted(runId);
    await abort(runId);
    serving = PUSHED;
    const answer = await recordRefused(ids);
    expect(answer.code).toBe('CLAIM_CONFLICT');
    for (const id of ids) {
      expect(answer.message).toMatch(named(await keyOf(id)));
      expect(answer.message).not.toContain(id);
    }
    expect(answer.message).toContain(
      `POST /api/projects/${projectId}/release-batches/${runId}/abort and a body of {"promotedRoster":"return-to-gate"}`,
    );
    expect(answer.message).not.toMatch(/Read the roster and send the issues it lists/);
    expect(answer.details.conflicts).toEqual(
      expect.arrayContaining(
        ids.map((id) =>
          expect.objectContaining({
            id,
            standing: 'claimed',
            runId,
            runEnded: true,
            claimer: 'batch',
            status: 'releasing',
          }),
        ),
      ),
    );
  }, 30_000);

  it('frees the held roster when the abort it names is taken, then the record is sent again', async () => {
    const { runId, ids } = await batchOf(2);
    await promoted(runId);
    await abort(runId);
    serving = PUSHED;
    await recordRefused(ids);
    await abort(runId, { promotedRoster: 'return-to-gate' });
    await recorded.recordPerformedRelease({
      projectId,
      userId: ownerId,
      issueIds: ids,
      commit: serving,
      account: 'Promoted by the batch before it was aborted.',
    });
    for (const id of ids) expect((await fx.stored(id)).status).toBe('closed');
  }, 30_000);

  it('names a batch still running by its state path and offers no abort', async () => {
    const { runId, ids } = await batchOf(1);
    const [claimed] = ids as [string];
    const answer = await recordRefused([claimed]);
    expect(answer.message).toMatch(named(await keyOf(claimed)));
    expect(answer.message).toContain(
      `GET /api/projects/${projectId}/release-batches/${runId}/state`,
    );
    expect(answer.message).not.toMatch(/abort/i);
    expect(answer.details.conflicts).toEqual([
      expect.objectContaining({
        id: claimed,
        standing: 'claimed',
        runId,
        runEnded: false,
        claimer: 'batch',
      }),
    ]);
  }, 30_000);

  it('names a closed issue a shipped batch still claims by its status, and offers no abort', async () => {
    const { runId, ids } = await batchOf(2);
    await promoted(runId);
    serving = PUSHED;
    await accept(runId);
    await job.runReleaseBatchFinish(runId);
    const [shipped] = ids as [string];
    // The minutely sweep has not run: a promoted roster keeps its claims past a green finish.
    expect(await fx.stored(shipped)).toMatchObject({ status: 'closed', claim: runId });
    expect(await fx.runStatus(runId)).toBe('completed');
    const answer = await recordRefused([shipped]);
    expect(answer.code).toBe('CLAIM_CONFLICT');
    expect(answer.message).toMatch(
      new RegExp(`\\b${await keyOf(shipped)} is at \`closed\`: already shipped`),
    );
    expect(answer.message).not.toMatch(/abort/i);
    expect(answer.details.conflicts).toEqual([
      expect.objectContaining({ id: shipped, standing: 'status', status: 'closed' }),
    ]);
    expect(await fx.runStatus(runId)).toBe('completed');
  }, 40_000);

  it('tells an issue at the gate that an ended run still claims the sweep clears it, not an abort', async () => {
    const { runId, ids } = await batchOf(1);
    const [stale] = ids as [string];
    // PLANTED: a run that ended leaving its claim on an issue back at the gate, before the sweep.
    await harness.db.execute(
      sql`UPDATE issues SET status = 'awaiting_release' WHERE id = ${stale}`,
    );
    await harness.db.execute(sql`UPDATE pipeline_runs SET status = 'failed' WHERE id = ${runId}`);
    const answer = await recordRefused([stale]);
    expect(answer.message).toMatch(named(await keyOf(stale)));
    expect(answer.message).toContain('the pipeline sweep clears');
    expect(answer.message).not.toMatch(/abort/i);
    expect(answer.details.conflicts).toEqual([
      expect.objectContaining({
        id: stale,
        standing: 'claimed',
        runId,
        runEnded: true,
        claimer: 'batch',
        status: 'awaiting_release',
      }),
    ]);
  }, 30_000);

  it('names a release record claiming an issue as a record, by a path that answers', async () => {
    const { openOneShotRun } = await import('../../src/pipeline/runs.js');
    const gate = await fx.insertIssue();
    const run = await openOneShotRun({
      projectId,
      kind: 'system',
      metadata: { source: 'release-record', gateStatus: 'awaiting_release', issueIds: [gate] },
    });
    // PLANTED: another caller's record holding its claim mid-close, as the race arm reads it.
    await harness.db.execute(
      sql`UPDATE issues SET release_batch_run_id = ${run.id} WHERE id = ${gate}`,
    );
    const answer = await recordRefused([gate]);
    expect(answer.message).toMatch(named(await keyOf(gate)));
    expect(answer.message).toContain(`GET /api/projects/${projectId}/release-records/${run.id}`);
    expect(answer.message).toContain('release record');
    expect(answer.message).not.toContain('release-batches');
    expect(answer.message).not.toContain('release batch');
    expect(answer.message).not.toMatch(/abort/i);
    expect(answer.details.conflicts).toEqual([
      expect.objectContaining({ id: gate, standing: 'claimed', runId: run.id, claimer: 'record' }),
    ]);
    expect(await recorded.readReleaseRecord(projectId, run.id)).toMatchObject({ runId: run.id });
  }, 30_000);

  it('names a status short of the gate, and an id that is no issue here as it was sent', async () => {
    const testing = await fx.insertIssue('testing');
    const stranger = randomUUID();
    const answer = await recordRefused([testing, stranger]);
    expect(answer.code).toBe('CLAIM_CONFLICT');
    expect(answer.message).toMatch(
      new RegExp(`\\b${await keyOf(testing)} is at \`testing\`, not \`awaiting_release\``),
    );
    expect(answer.message).toContain(`${stranger} is no issue on this project`);
    expect(answer.details.conflicts).toEqual([
      expect.objectContaining({ id: testing, standing: 'status', status: 'testing' }),
      { id: stranger, key: stranger, standing: 'absent' },
    ]);
  }, 30_000);

  it('answers a new batch in the same words as the record door', async () => {
    const testing = await fx.insertIssue('testing');
    const fromRecord = await recordRefused([testing]);
    let fromBatch: Refusal | null = null;
    try {
      await service.createReleaseBatch({ projectId, issueIds: [testing], userId: ownerId });
    } catch (err) {
      const http = refusals.reportedRefusal(err);
      if (!http) throw err;
      fromBatch = asRefusal(http);
    }
    expect(fromBatch?.code).toBe('CLAIM_CONFLICT');
    expect(fromBatch?.message).toBe(fromRecord.message);
  }, 30_000);
});

describe('an issue id is the same id in either case', () => {
  it('names a project issue sent with an upper-case id by its key, under its reason', async () => {
    const testing = await fx.insertIssue('testing');
    const answer = await recordRefused([testing.toUpperCase()]);
    expect(answer.code).toBe('CLAIM_CONFLICT');
    expect(answer.message).toMatch(
      new RegExp(`\\b${await keyOf(testing)} is at \`testing\`, not \`awaiting_release\``),
    );
    expect(answer.message).not.toMatch(/no issues? on this project/);
    expect(answer.details.conflicts).toEqual([
      expect.objectContaining({ id: testing, standing: 'status', status: 'testing' }),
    ]);
  }, 30_000);

  it('names an id no issue has as it was sent, upper-case and all', async () => {
    const stranger = randomUUID().toUpperCase();
    const answer = await recordRefused([stranger]);
    expect(answer.message).toContain(`${stranger} is no issue on this project`);
    expect(answer.details.conflicts).toEqual([{ id: stranger, key: stranger, standing: 'absent' }]);
  }, 30_000);

  it('records a release of an eligible issue sent with an upper-case id, and closes it', async () => {
    const gate = await fx.insertIssue();
    const result = await recorded.recordPerformedRelease({
      projectId,
      userId: ownerId,
      issueIds: [gate.toUpperCase()],
      commit: serving,
      account: 'Promoted by hand; production serves this commit.',
    });
    expect(result.closed).toEqual([gate]);
    expect(await fx.stored(gate)).toMatchObject({ status: 'closed', claim: null });
    const rows = await harness.db.execute(
      sql`SELECT metadata -> 'issueIds' AS ids FROM pipeline_runs WHERE id = ${result.runId}`,
    );
    expect(rows[0]?.ids).toEqual([gate]);
  }, 30_000);

  it('claims an eligible issue sent with an upper-case id for a new batch', async () => {
    const gate = await fx.insertIssue();
    const result = await service.createReleaseBatch({
      projectId,
      issueIds: [gate.toUpperCase()],
      userId: ownerId,
    });
    expect(result.issueIds).toEqual([gate]);
    expect(await fx.stored(gate)).toMatchObject({ status: 'releasing', claim: result.runId });
  }, 30_000);
});

describe('an issue past the release gate is not told to wait for it', () => {
  it('says an issue at closed has already shipped', async () => {
    const closed = await fx.insertIssue('closed');
    const answer = await recordRefused([closed]);
    expect(answer.message).toMatch(new RegExp(`\\b${await keyOf(closed)} is at \`closed\``));
    expect(answer.message).toContain('already shipped');
    expect(answer.message).not.toContain('only once it reaches the release gate');
  }, 30_000);

  it('says an issue at dropped was set down as not work', async () => {
    const dropped = await fx.insertIssue('dropped');
    const answer = await recordRefused([dropped]);
    expect(answer.message).toMatch(new RegExp(`\\b${await keyOf(dropped)} is at \`dropped\``));
    expect(answer.message).toContain('not work');
    expect(answer.message).not.toContain('only once it reaches the release gate');
  }, 30_000);
});

describe('an issue on another project reads as an id no issue here has', () => {
  async function foreignIssue(): Promise<string> {
    const home = projectId;
    projectId = (await createTestProject(harness.db, ownerId)).id;
    // Without a note and without a merge, so a read that crossed projects would report both.
    const id = await fx.insertIssue('awaiting_release', null, false);
    projectId = home;
    return id;
  }

  it.each(['record', 'batch'] as const)(
    'draws nothing at the %s door that a made-up id does not',
    async (door) => {
      const foreign = await foreignIssue();
      const stranger = randomUUID();
      const refusedAt = async (id: string): Promise<Refusal> => {
        if (door === 'record') return recordRefused([id]);
        try {
          await service.createReleaseBatch({ projectId, issueIds: [id], userId: ownerId });
        } catch (err) {
          const http = refusals.reportedRefusal(err);
          if (http) return asRefusal(http);
          throw err;
        }
        throw new Error('the batch was not refused');
      };
      const fromForeign = await refusedAt(foreign);
      const fromStranger = await refusedAt(stranger);
      expect(fromForeign.code).toBe('CLAIM_CONFLICT');
      expect(fromForeign.message).toContain(`${foreign} is no issue on this project`);
      expect(JSON.stringify(fromForeign.details).replaceAll(foreign, '<id>')).toBe(
        JSON.stringify(fromStranger.details).replaceAll(stranger, '<id>'),
      );
    },
    30_000,
  );
});
